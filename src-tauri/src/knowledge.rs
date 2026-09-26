use crate::{contracts::*, storage::Storage};
use std::collections::HashSet;
pub fn load(storage: &Storage, repository_id: &str) -> AppResult<ProjectKnowledge> {
    let _: Repository = storage.get("repository", repository_id)?;
    match storage.get::<ProjectKnowledge>("knowledge", repository_id) {
        Ok(mut k) => {
            let settings = storage.project_settings(repository_id)?;
            k.language = settings.language;
            Ok(k)
        }
        Err(e) if e.code == "not_found" => Ok(ProjectKnowledge {
            repository_id: repository_id.into(),
            language: storage.project_settings(repository_id)?.language,
            terms: vec![],
            documents: vec![],
            revision: 0,
        }),
        Err(e) => Err(e),
    }
}
pub fn prepare(
    storage: &Storage,
    mut knowledge: ProjectKnowledge,
) -> AppResult<(ProjectKnowledge, Option<u32>)> {
    let previous = load(storage, &knowledge.repository_id)?;
    if previous.revision != knowledge.revision {
        return Err(AppError::new(
            "conflict",
            "The glossary changed. Reload before saving.",
        ));
    }
    if knowledge.language.trim().is_empty() {
        return Err(AppError::new(
            "invalid_language",
            "Choose an explanation language.",
        ));
    }
    let mut ids = HashSet::new();
    for term in &knowledge.terms {
        if term.term.trim().is_empty() || term.senses.is_empty() || !ids.insert(&term.id) {
            return Err(AppError::new(
                "invalid_term",
                "Terms need a name, distinct IDs and at least one sense.",
            ));
        }
        for sense in &term.senses {
            if sense.description.trim().is_empty() || !ids.insert(&sense.id) {
                return Err(AppError::new(
                    "invalid_sense",
                    "Senses need distinct IDs and descriptions.",
                ));
            }
        }
    }
    // Preserve referenced meanings as history rather than silently breaking documents.
    for old in &previous.terms {
        if !knowledge.terms.iter().any(|t| t.id == old.id) {
            return Err(AppError::new(
                "archive_required",
                "Archive a term instead of deleting its history.",
            ));
        }
    }
    for document in &knowledge.documents {
        if document.repository_id != knowledge.repository_id {
            return Err(AppError::new(
                "invalid_document",
                "Document belongs to another repository.",
            ));
        }
        let snapshot: Snapshot = storage.get("snapshot", &document.snapshot_id)?;
        let file = snapshot
            .files
            .iter()
            .find(|f| f.path == document.path && f.content.hash == document.fingerprint)
            .ok_or_else(|| {
                AppError::new(
                    "invalid_document",
                    "Document source does not match its snapshot.",
                )
            })?;
        let bytes = storage.read_blob(&file.content.hash)?;
        let lines = bytes.split(|b| *b == b'\n').count() as u32;
        for section in &document.sections {
            if section.start_line == 0
                || section.end_line < section.start_line
                || section.end_line > lines
            {
                return Err(AppError::new(
                    "invalid_anchor",
                    "Explanation line range is outside the file.",
                ));
            }
        }
        for occurrence in &document.occurrences {
            let section = document
                .sections
                .iter()
                .find(|s| s.id == occurrence.section_id)
                .ok_or_else(|| AppError::new("invalid_occurrence", "Section does not exist."))?;
            let text: String = section
                .body
                .chars()
                .skip(occurrence.offset as usize)
                .take(occurrence.quote.chars().count())
                .collect();
            if occurrence.quote.is_empty() || text != occurrence.quote {
                return Err(AppError::new(
                    "invalid_occurrence",
                    "Text occurrence no longer matches.",
                ));
            }
            if occurrence.description.is_none()
                && !knowledge.terms.iter().any(|t| {
                    Some(&t.id) == occurrence.term_id.as_ref()
                        && t.senses
                            .iter()
                            .any(|s| Some(&s.id) == occurrence.sense_id.as_ref())
                })
            {
                return Err(AppError::new(
                    "invalid_occurrence",
                    "Choose a valid sense or a local description.",
                ));
            }
        }
    }
    let exists = storage
        .get::<ProjectKnowledge>("knowledge", &knowledge.repository_id)
        .is_ok();
    let revision = knowledge.revision;
    knowledge.revision = if exists { revision + 1 } else { 0 };
    Ok((knowledge, exists.then_some(revision)))
}
pub fn save(storage: &Storage, knowledge: ProjectKnowledge) -> AppResult<ProjectKnowledge> {
    let (knowledge, revision) = prepare(storage, knowledge)?;
    let mut writes: Vec<(&str, &str, Option<u32>, serde_json::Value)> = vec![(
        "knowledge",
        &knowledge.repository_id,
        revision,
        serde_json::to_value(&knowledge)?,
    )];
    let mut settings = storage.project_settings(&knowledge.repository_id)?;
    if settings.language != knowledge.language {
        let previous = settings.revision;
        settings.revision += 1;
        settings.language = knowledge.language.clone();
        writes.push((
            "project_settings",
            &knowledge.repository_id,
            Some(previous),
            serde_json::to_value(settings)?,
        ));
    }
    storage.write_batch(writes)?;
    Ok(knowledge)
}
