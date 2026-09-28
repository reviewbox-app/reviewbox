//! Validated documents and exact frozen sources for the document reader.
pub(crate) mod glossary;
use crate::{contracts::*, reviews, storage::Storage};
use std::collections::{BTreeMap, HashSet};

pub(crate) fn file_id(path: &str) -> String {
    format!("file-{}", fingerprint(path.as_bytes()))
}
pub(crate) fn sources(snapshot: &Snapshot) -> Vec<SourceDescriptor> {
    let mut result = Vec::new();
    for change in &snapshot.changes {
        for (side, blob) in [("before", &change.before), ("after", &change.after)] {
            if let Some(blob) = blob {
                result.push(SourceDescriptor {
                    source_id: format!("change:{}:{side}", change.id),
                    path: if side == "before" {
                        change
                            .previous_path
                            .clone()
                            .unwrap_or_else(|| change.path.clone())
                    } else {
                        change.path.clone()
                    },
                    hash: blob.hash.clone(),
                    size: blob.size,
                });
            }
        }
    }
    for file in &snapshot.files {
        result.push(SourceDescriptor {
            source_id: format!("file:{}", file.path),
            path: file.path.clone(),
            hash: file.content.hash.clone(),
            size: file.content.size,
        });
    }
    result
}
pub(crate) fn source(
    storage: &Storage,
    snapshot: &Snapshot,
    source_id: &str,
) -> AppResult<FrozenSource> {
    let descriptor = sources(snapshot)
        .into_iter()
        .find(|s| s.source_id == source_id)
        .ok_or_else(|| {
            AppError::new("invalid_reference", "Source is not part of this snapshot.")
        })?;
    if descriptor.path.split('/').any(|part| {
        part == ".env"
            || part.starts_with(".env.")
            || [".ssh", ".aws"].contains(&part)
            || part.ends_with(".pem")
            || part.ends_with(".key")
    }) {
        return Ok(FrozenSource {
            source_id: descriptor.source_id,
            path: descriptor.path,
            hash: descriptor.hash,
            text: None,
            unavailable_reason: Some(
                "Sensitive source content is excluded from generated review documents.".into(),
            ),
        });
    }
    let content = storage.read_blob(&descriptor.hash);
    let (text, unavailable_reason) = match content {
        Ok(bytes) if bytes.len() != descriptor.size as usize => {
            (None, Some("Captured source size does not match.".into()))
        }
        Ok(bytes) if bytes.contains(&0) => (
            None,
            Some("Binary content cannot be displayed as source text.".into()),
        ),
        Ok(bytes) => match String::from_utf8(bytes) {
            Ok(text) => (Some(text), None),
            Err(_) => (None, Some("Captured source is not UTF-8 text.".into())),
        },
        Err(error) => (None, Some(error.message)),
    };
    Ok(FrozenSource {
        source_id: descriptor.source_id,
        path: descriptor.path,
        hash: descriptor.hash,
        text,
        unavailable_reason,
    })
}
pub(crate) fn files(snapshot: &Snapshot) -> Vec<ReviewFile> {
    fn root<'a>(parents: &BTreeMap<&'a str, &'a str>, mut path: &'a str) -> &'a str {
        while parents.get(path).is_some_and(|parent| *parent != path) {
            path = parents[path];
        }
        path
    }
    let mut parents = BTreeMap::new();
    for change in &snapshot.changes {
        parents
            .entry(change.path.as_str())
            .or_insert(change.path.as_str());
        if let Some(previous) = change.previous_path.as_deref() {
            parents.entry(previous).or_insert(previous);
            let a = root(&parents, previous);
            let b = root(&parents, &change.path);
            if a != b {
                parents.insert(a, b);
            }
        }
    }
    let mut groups: BTreeMap<&str, Vec<&Change>> = BTreeMap::new();
    for change in &snapshot.changes {
        groups
            .entry(root(&parents, &change.path))
            .or_default()
            .push(change);
    }
    let mut result = Vec::new();
    for mut changes in groups.into_values() {
        changes.sort_by_key(|c| if c.layer == "unstaged" { 1 } else { 0 });
        let path = changes.last().expect("non-empty file group").path.clone();
        let mut file = ReviewFile {
            pseudocode_selected: None,
            pseudocode_skip_reason: None,
            id: file_id(&path),
            path,
            change_ids: Vec::new(),
            has_documents: false,
            translations: Vec::new(),
        };
        for change in changes {
            file.change_ids.push(change.id.clone());
            for (side, blob) in [("before", &change.before), ("after", &change.after)] {
                if let Some(blob) = blob {
                    file.translations.push(PseudoTranslationInfo {
                        source_id: format!("change:{}:{side}", change.id),
                        source_hash: blob.hash.clone(),
                        available: false,
                        unavailable_reason: Some("Pseudocode has not been prepared.".into()),
                    });
                }
            }
        }
        result.push(file);
    }
    result.sort_by(|a, b| a.path.cmp(&b.path));
    result
}
fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 160
        && id
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || b"_-".contains(&c))
}
fn reference(storage: &Storage, snapshot: &Snapshot, r: &DocumentReference) -> AppResult<()> {
    let frozen = source(storage, snapshot, &r.source_id)?;
    let text = frozen.text.ok_or_else(|| {
        AppError::new(
            "unavailable_source",
            frozen.unavailable_reason.unwrap_or_default(),
        )
    })?;
    if r.start_line == 0
        || r.end_line < r.start_line
        || r.end_line > text.lines().count().max(1) as u32
    {
        return Err(AppError::new(
            "invalid_reference",
            "A document reference is outside the captured source.",
        ));
    }
    Ok(())
}
pub(crate) fn validate_documents(
    storage: &Storage,
    snapshot: &Snapshot,
    docs: &LevelDocuments,
) -> AppResult<()> {
    validate_documents_with_glossary(storage, snapshot, docs, &[])
}
pub(crate) fn validate_documents_with_glossary(
    storage: &Storage,
    snapshot: &Snapshot,
    docs: &LevelDocuments,
    glossary: &[DocumentTerm],
) -> AppResult<()> {
    let mut shared_ids = HashSet::new();
    for term in docs.glossary.iter().chain(glossary) {
        if !valid_id(&term.id)
            || term.term.trim().is_empty()
            || term.definition.trim().is_empty()
            || !shared_ids.insert(&term.id)
        {
            return Err(AppError::new(
                "invalid_term",
                "Shared definitions need distinct IDs, terms and definitions.",
            ));
        }
    }
    for (level, doc) in [
        (ReadingLevel::Beginner, &docs.beginner),
        (ReadingLevel::Intermediate, &docs.intermediate),
        (ReadingLevel::Developer, &docs.developer),
    ] {
        if doc.body.trim().is_empty() || doc.reading_seconds == 0 {
            return Err(AppError::new(
                "invalid_document",
                "A document needs non-empty Markdown and a valid reading duration.",
            ));
        }
        let mut ids = HashSet::new();
        for r in &doc.references {
            if !valid_id(&r.id)
                || r.label.trim().is_empty()
                || r.explanation.trim().is_empty()
                || !ids.insert(&r.id)
            {
                return Err(AppError::new(
                    "invalid_reference",
                    "References need distinct IDs, labels and explanations.",
                ));
            }
            reference(storage, snapshot, r)?;
        }
        for term in &doc.terms {
            if !valid_id(&term.id)
                || term.term.trim().is_empty()
                || term.definition.trim().is_empty()
                || !ids.insert(&term.id)
            {
                return Err(AppError::new(
                    "invalid_term",
                    "Terms need distinct IDs, names and definitions.",
                ));
            }
        }
        for (alias, target) in &doc.term_aliases {
            if !valid_id(alias)
                || !doc
                    .terms
                    .iter()
                    .chain(&docs.glossary)
                    .chain(glossary)
                    .any(|term| &term.id == target)
            {
                return Err(AppError::new(
                    "invalid_term",
                    "A term alias has no known glossary definition.",
                ));
            }
        }
        for link in doc
            .body
            .split("](")
            .skip(1)
            .filter_map(|part| part.split(')').next())
        {
            if let Some(id) = link.strip_prefix("reviewbox:ref/") {
                if !doc.references.iter().any(|r| r.id == id) {
                    return Err(AppError::new(
                        "invalid_reference",
                        "Markdown references an unknown source link.",
                    ));
                }
            } else if let Some(id) = link.strip_prefix("reviewbox:term/") {
                if !doc
                    .terms
                    .iter()
                    .chain(&docs.glossary)
                    .chain(glossary)
                    .any(|r| r.id == id)
                {
                    return Err(AppError::new(
                        "invalid_term",
                        "Markdown references an unknown term.",
                    ));
                }
            } else if link.starts_with("reviewbox:") {
                return Err(AppError::new(
                    "invalid_reference",
                    "Unknown internal document link.",
                ));
            }
        }
        let mut fence: Option<(&str, char, usize, String)> = None;
        for line in doc.body.lines() {
            let trimmed = line.trim_start();
            let delimiter = trimmed.chars().next().filter(|c| *c == '`' || *c == '~');
            let count = delimiter.map_or(0, |c| trimmed.chars().take_while(|v| *v == c).count());
            if count >= 3 {
                if let Some((kind, opening, length, mut body)) = fence.take() {
                    if delimiter != Some(opening)
                        || count < length
                        || !trimmed[count..].trim().is_empty()
                    {
                        body.push_str(line);
                        body.push('\n');
                        fence = Some((kind, opening, length, body));
                        continue;
                    }
                    if kind == "before-after" {
                        let v: serde_json::Value = serde_json::from_str(&body)?;
                        if !["before", "after"].iter().all(|key| {
                            v[*key].as_array().is_some_and(|a| {
                                !a.is_empty()
                                    && a.iter()
                                        .all(|s| s.as_str().is_some_and(|s| !s.trim().is_empty()))
                            })
                        }) {
                            return Err(AppError::new(
                                "invalid_document",
                                "Before/after blocks need two arrays of text.",
                            ));
                        }
                    } else if kind == "source"
                        && !doc.references.iter().any(|r| r.id == body.trim())
                    {
                        return Err(AppError::new(
                            "invalid_reference",
                            "Source block references an unknown source.",
                        ));
                    }
                } else {
                    let language = trimmed[count..].trim();
                    let allowed = matches!(
                        language,
                        "summary" | "before-after" | "mermaid" | "pseudocode" | "html"
                    ) || (level == ReadingLevel::Developer && language == "source");
                    if !allowed {
                        return Err(AppError::new(
                            "invalid_document",
                            "This reading level contains a forbidden code block.",
                        ));
                    }
                    fence = Some((language, delimiter.unwrap_or('`'), count, String::new()));
                }
            } else if let Some((_, _, _, body)) = &mut fence {
                body.push_str(line);
                body.push('\n');
            }
        }
        if fence.is_some() {
            return Err(AppError::new(
                "invalid_document",
                "Markdown contains an unfinished fenced block.",
            ));
        }
    }
    Ok(())
}
pub(crate) fn estimate_reading_time(documents: &mut LevelDocuments) {
    for document in [
        &mut documents.beginner,
        &mut documents.intermediate,
        &mut documents.developer,
    ] {
        // A consistent local estimate, independent of the provider's suggestion.
        document.reading_seconds = (document.body.split_whitespace().count() as u32)
            .div_ceil(3)
            .max(1);
    }
}
fn translation(storage: &Storage, snapshot: &Snapshot, value: &PseudoTranslation) -> AppResult<()> {
    let descriptor = sources(snapshot)
        .into_iter()
        .find(|s| s.source_id == value.source_id && s.hash == value.source_hash)
        .ok_or_else(|| {
            AppError::new(
                "invalid_translation",
                "Pseudocode source does not match the snapshot.",
            )
        })?;
    if let Some(reason) = &value.unavailable_reason {
        if reason.trim().is_empty() || !value.blocks.is_empty() {
            return Err(AppError::new(
                "invalid_translation",
                "Unavailable pseudocode must have a reason and no partial blocks.",
            ));
        }
        return Ok(());
    }
    let frozen = source(storage, snapshot, &descriptor.source_id)?;
    let text = frozen.text.ok_or_else(|| {
        AppError::new(
            "unavailable_source",
            frozen.unavailable_reason.unwrap_or_default(),
        )
    })?;
    if text.is_empty() && value.blocks.is_empty() {
        return Ok(());
    }
    let lines = text.lines().count().max(1) as u32;
    let mut next = 1;
    for block in &value.blocks {
        if block.start_line < next
            || block.end_line < block.start_line
            || block.end_line > lines
            || block.text.trim().is_empty()
        {
            return Err(AppError::new(
                "invalid_translation",
                "Pseudocode ranges must be ordered, non-overlapping and inside the source.",
            ));
        }
        next = block.end_line + 1;
    }
    Ok(())
}

fn validate_pseudocode_skip(content: &ReviewFileContent) -> AppResult<()> {
    if let Some(reason) = &content.pseudocode_skip_reason
        && (reason.trim().is_empty() || reason.len() > 1200 || !content.translations.is_empty())
    {
        return Err(AppError::new(
            "invalid_translation",
            "An unnecessary translation needs a short reason and no translated blocks.",
        ));
    }
    Ok(())
}
pub(crate) fn publish_preparation(
    storage: &Storage,
    review_id: &str,
    snapshot_id: &str,
    preparation_id: &str,
    expected_revision: u32,
    mut topics: Vec<Topic>,
    mut contents: Vec<ReviewFileContent>,
) -> AppResult<Workspace> {
    let mut workspace = reviews::load(storage, review_id)?;
    if workspace.snapshot.id != snapshot_id {
        return Err(AppError::new(
            "stale_preparation",
            "The review snapshot changed during preparation.",
        ));
    }
    if workspace.review.preparation_id.as_deref() == Some(preparation_id) {
        return Ok(workspace);
    }
    if workspace.review.revision != expected_revision {
        return Err(AppError::new(
            "conflict",
            "This review changed during preparation. Reload before replacing its documents.",
        ));
    }
    for topic in &topics {
        if topic.steps.is_empty() {
            return Err(AppError::new(
                "invalid_document",
                "Each topic needs a step.",
            ));
        }
        for step in &topic.steps {
            validate_documents(storage, &workspace.snapshot, &step.documents)?;
        }
    }
    workspace.review.glossary = glossary::assemble(&mut topics, &[]);
    let revision = workspace.review.revision;
    workspace = reviews::prepare_action(
        storage,
        workspace,
        revision,
        ReviewAction::SaveTopics { topics },
    )?;
    let mut files = files(&workspace.snapshot);
    let mut seen = HashSet::new();
    for content in &mut contents {
        validate_pseudocode_skip(content)?;
        let file = files
            .iter_mut()
            .find(|f| f.id == content.file_id)
            .ok_or_else(|| {
                AppError::new(
                    "invalid_file",
                    "Generated file is not part of this snapshot.",
                )
            })?;
        if !seen.insert(content.file_id.clone()) {
            return Err(AppError::new("invalid_file", "Duplicate generated file."));
        }
        if let Some(docs) = &mut content.documents {
            validate_documents_with_glossary(
                storage,
                &workspace.snapshot,
                docs,
                &workspace.review.glossary,
            )?;
            estimate_reading_time(docs);
            file.has_documents = true;
        }
        file.pseudocode_selected = content.pseudocode_selected;
        file.pseudocode_skip_reason = content.pseudocode_skip_reason.clone();
        let mut translations = HashSet::new();
        for value in &content.translations {
            if !translations.insert(&value.source_id) {
                return Err(AppError::new(
                    "invalid_translation",
                    "Duplicate pseudocode source.",
                ));
            }
            let info = file
                .translations
                .iter_mut()
                .find(|v| v.source_id == value.source_id)
                .ok_or_else(|| {
                    AppError::new("invalid_translation", "Pseudocode belongs to another file.")
                })?;
            translation(storage, &workspace.snapshot, value)?;
            info.available = value.unavailable_reason.is_none();
            info.unavailable_reason = value.unavailable_reason.clone();
        }
    }
    if seen.len() != files.len() {
        return Err(AppError::new(
            "missing_file",
            "Preparation did not return an artifact for every changed file.",
        ));
    }
    workspace.review.files = files;
    workspace.review.mode = if workspace.review.topics.is_empty() {
        ReviewMode::Manual
    } else {
        ReviewMode::Guided
    };
    workspace.review.preparation_id = Some(preparation_id.into());
    workspace.review.decisions.clear();
    workspace.review.position = if workspace.review.mode == ReviewMode::Manual {
        reviews::file_position(&workspace.snapshot, &workspace.review.files)
    } else {
        ReadingPosition::default()
    };
    let mut value = serde_json::to_value(&workspace.review)?;
    value["generatedFiles"] = serde_json::to_value(contents)?;
    storage.write_batch(vec![("review", review_id, Some(revision), value)])?;
    Ok(workspace)
}
pub(crate) fn read_file(
    storage: &Storage,
    review_id: &str,
    file_id: &str,
) -> AppResult<ReviewFileContent> {
    let workspace = reviews::load(storage, review_id)?;
    if !workspace.review.files.iter().any(|f| f.id == file_id) {
        return Err(AppError::new(
            "invalid_file",
            "File is not part of this review.",
        ));
    }
    if workspace.review.preparation_id.is_none()
        && workspace.review.files.iter().any(|f| {
            f.id == file_id && !f.has_documents && f.translations.iter().all(|t| !t.available)
        })
    {
        return Ok(ReviewFileContent {
            pseudocode_selected: None,
            pseudocode_skip_reason: None,
            file_id: file_id.into(),
            documents: None,
            translations: vec![],
        });
    }
    let content = storage.read_review_asset(review_id, file_id)?;
    validate_pseudocode_skip(&content)?;
    if let Some(docs) = &content.documents {
        validate_documents_with_glossary(
            storage,
            &workspace.snapshot,
            docs,
            &workspace.review.glossary,
        )?;
    }
    for value in &content.translations {
        translation(storage, &workspace.snapshot, value)?;
    }
    Ok(content)
}
pub(crate) fn summary(workspace: &Workspace, level: ReadingLevel) -> String {
    let mut out = format!("# {}\n\n", workspace.review.title);
    for topic in &workspace.review.topics {
        out.push_str(&format!("## {}\n\n", topic.title));
        for step in &topic.steps {
            let done = workspace.review.decisions.iter().any(|d| {
                d.target
                    == DecisionTarget::Step {
                        step_id: step.id.clone(),
                    }
                    && d.state == DecisionState::Validated
            });
            out.push_str(&format!(
                "### {} {}\n\n{}\n\n",
                if done { "[x]" } else { "[ ]" },
                step.title,
                step.documents.get(level).body
            ));
        }
    }
    out
}
