use super::*;
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;

/// Provider contract; legacy topic containers remain a storage detail.
#[derive(Clone, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct JourneyOutline {
    #[serde(default)]
    pub working_context_assessments: Vec<WorkingContextAssessment>,
    #[serde(default)]
    pub removed_steps: Vec<String>,
    pub steps: Vec<OutlineStep>,
}
impl JourneyOutline {
    pub(super) fn into_outline(self) -> Outline {
        Outline {
            working_context_assessments: self.working_context_assessments,
            removed_steps: self.removed_steps,
            topics: self
                .steps
                .into_iter()
                .map(|step| OutlineTopic {
                    title: step.title.clone(),
                    brief: step.writing_brief.clone(),
                    steps: vec![step],
                })
                .collect(),
        }
    }
}
#[derive(Clone, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Outline {
    #[serde(default)]
    pub working_context_assessments: Vec<WorkingContextAssessment>,
    #[serde(default)]
    pub removed_steps: Vec<String>,
    pub topics: Vec<OutlineTopic>,
}
#[derive(Clone, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct OutlineTopic {
    pub title: String,
    pub brief: String,
    pub steps: Vec<OutlineStep>,
}
#[derive(Clone, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct OutlineStep {
    pub draft_id: String,
    #[serde(default)]
    pub previous_step_id: Option<String>,
    #[serde(default)]
    pub reuse: bool,
    pub title: String,
    pub writing_brief: String,
    // Missing only in legacy checkpoints; current provider output is validated below.
    #[serde(default)]
    pub analysis: Option<JourneyAnalysis>,
    pub context_source_ids: Vec<String>,
    pub anchors: Vec<CodeAnchor>,
}

impl OutlineStep {
    pub(super) fn context_sources(&self) -> Vec<String> {
        self.context_source_ids
            .iter()
            .cloned()
            .chain(
                self.analysis
                    .iter()
                    .flat_map(|a| a.evidence.iter().map(|e| e.source_id.clone())),
            )
            .collect::<BTreeSet<_>>()
            .into_iter()
            .collect()
    }
}

#[derive(Clone, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct JourneyAnalysis {
    pub before: String,
    pub after: String,
    pub relationships: String,
    pub consequences: String,
    pub uncertainties: Vec<String>,
    pub evidence: Vec<AnalysisEvidence>,
}
#[derive(Clone, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct AnalysisEvidence {
    pub fact: String,
    pub source_id: String,
    pub start_line: u32,
    pub end_line: u32,
}

pub(super) fn validate_analysis(
    outline: &Outline,
    snapshot: &Snapshot,
    storage: &Storage,
) -> AppResult<()> {
    let mut lengths = BTreeMap::new();
    for step in outline.topics.iter().flat_map(|topic| &topic.steps) {
        let analysis = step
            .analysis
            .as_ref()
            .ok_or_else(|| invalid("Every journey needs a private analysis dossier."))?;
        for text in [
            &analysis.before,
            &analysis.after,
            &analysis.relationships,
            &analysis.consequences,
        ] {
            short_text(text, usize::MAX)?;
        }
        let has_text_changes = step.anchors.iter().any(|anchor| {
            snapshot
                .changes
                .iter()
                .find(|change| change.id == anchor.change_id)
                .and_then(|change| change.passages.iter().find(|p| p.id == anchor.passage_id))
                .is_some_and(|passage| passage.old_lines > 0 || passage.new_lines > 0)
        });
        if analysis.evidence.is_empty() && has_text_changes {
            return Err(invalid(
                "Analysis of textual changes needs exact source evidence.",
            ));
        }
        for evidence in &analysis.evidence {
            short_text(&evidence.fact, usize::MAX)?;
            let length = if let Some(length) = lengths.get(&evidence.source_id) {
                *length
            } else {
                let source = reader::source(storage, snapshot, &evidence.source_id)
                    .map_err(|_| invalid("Analysis references an unavailable captured source."))?;
                let text = source
                    .text
                    .as_deref()
                    .ok_or_else(|| invalid("Analysis references unavailable source text."))?;
                let length = line_count(text);
                lengths.insert(evidence.source_id.clone(), length);
                length
            };
            if evidence.start_line == 0
                || evidence.end_line < evidence.start_line
                || evidence.end_line as usize > length
            {
                return Err(invalid(
                    "Analysis evidence range is outside the frozen source.",
                ));
            }
        }
    }
    Ok(())
}

pub(super) fn validate_outline(outline: &Outline, snapshot: &Snapshot) -> AppResult<()> {
    let sources: BTreeSet<_> = reader::sources(snapshot)
        .into_iter()
        .map(|source| source.source_id)
        .collect();
    let mut identities = BTreeSet::new();
    for topic in &outline.topics {
        short_text(&topic.title, usize::MAX)?;
        short_text(&topic.brief, usize::MAX)?;
        if topic.steps.is_empty() {
            return Err(invalid("Every topic needs a step."));
        }
        for step in &topic.steps {
            if step.draft_id.is_empty()
                || step.draft_id.len() > 100
                || !step
                    .draft_id
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b"-_:.".contains(&b))
                || !identities.insert(&step.draft_id)
            {
                return Err(invalid(
                    "Each step needs a unique, stable draftId (ASCII, at most 100 characters).",
                ));
            }
            short_text(&step.title, usize::MAX)?;
            short_text(&step.writing_brief, usize::MAX)?;
            let mut context = BTreeSet::new();
            for source in &step.context_source_ids {
                if !sources.contains(source) || !context.insert(source) {
                    return Err(invalid(
                        "Step context sources must be unique IDs from the frozen capture.",
                    ));
                }
            }
            if step.anchors.is_empty() || step.anchors.len() > 2000 {
                return Err(invalid("Every step needs 1–2000 captured anchors."));
            }
            for anchor in &step.anchors {
                if anchor.snapshot_id != snapshot.id
                    || !snapshot.changes.iter().any(|change| {
                        change.id == anchor.change_id
                            && change
                                .passages
                                .iter()
                                .any(|passage| passage.id == anchor.passage_id)
                    })
                {
                    return Err(invalid(
                        "An outline anchor is absent from the frozen capture.",
                    ));
                }
            }
        }
    }
    Ok(())
}

pub(super) fn invalid(message: &str) -> AppError {
    AppError::new("invalid_preparation", message)
}
fn short_text(text: &str, max: usize) -> AppResult<()> {
    if text.trim().is_empty() || text.len() > max {
        return Err(invalid(
            "A required text is empty or exceeds its size limit.",
        ));
    }
    Ok(())
}

pub(super) fn validate_documents(
    documents: &LevelDocuments,
    snapshot: &Snapshot,
    storage: &Storage,
) -> AppResult<()> {
    crate::reader::validate_documents(storage, snapshot, documents)?;
    for source in &documents.context_sources {
        crate::reader::source(storage, snapshot, source)?;
    }
    for (level, document) in [
        ("essential", &documents.essential),
        ("explained", &documents.explained),
        ("technical", &documents.technical),
    ] {
        short_text(&document.body, usize::MAX)?;
        if document.reading_seconds == 0 || document.reading_seconds > 7200 {
            return Err(invalid(
                "Reading duration must be between 1 and 7200 seconds.",
            ));
        }
        let mut ids = BTreeSet::new();
        for reference in &document.references {
            validate_id(&reference.id)?;
            if !ids.insert(("ref", &reference.id)) {
                return Err(invalid("Reference ids must be unique within a document."));
            }
            short_text(&reference.label, 300)?;
            short_text(&reference.explanation, 8000)?;
            let source = crate::reader::source(storage, snapshot, &reference.source_id)?;
            let text = source
                .text
                .as_deref()
                .ok_or_else(|| invalid("A document references unavailable source text."))?;
            if reference.start_line == 0
                || reference.end_line < reference.start_line
                || reference.end_line as usize > line_count(text)
            {
                return Err(invalid(
                    "A reference line range is outside the frozen source.",
                ));
            }
            if !document
                .body
                .contains(&format!("(reviewbox:ref/{})", reference.id))
            {
                return Err(invalid(
                    "Every reference must appear in its document as a reviewbox:ref link.",
                ));
            }
        }
        for term in document.terms.iter().chain(&documents.glossary) {
            validate_id(&term.id)?;
            if !ids.insert(("term", &term.id)) {
                return Err(invalid("Term ids must be unique within a document."));
            }
            short_text(&term.term, 200)?;
            short_text(&term.definition, 4000)?;
            short_text(&term.context, 4000)?;
            // Definitions can be shared without being used in this step. Validate
            // their metadata here; only links actually present must resolve below.
        }
        for (kind, marker) in [("ref", "reviewbox:ref/"), ("term", "reviewbox:term/")] {
            for tail in document.body.split(marker).skip(1) {
                let id = tail.split(')').next().unwrap_or_default();
                if !ids
                    .iter()
                    .any(|(k, known)| *k == kind && known.as_str() == id)
                {
                    return Err(invalid(
                        "A document contains an unresolved interactive link.",
                    ));
                }
            }
        }
        validate_fences(&document.body, level)?;
    }
    if documents.essential.body.trim() == documents.explained.body.trim()
        || documents.explained.body.trim() == documents.technical.body.trim()
        || documents.essential.body.trim() == documents.technical.body.trim()
    {
        return Err(invalid(
            "Write three genuinely distinct reading-level documents.",
        ));
    }
    Ok(())
}

fn validate_id(id: &str) -> AppResult<()> {
    if id.is_empty()
        || id.len() > 100
        || !id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
    {
        return Err(invalid(
            "Interactive ids must use only letters, digits, hyphens and underscores.",
        ));
    }
    Ok(())
}

pub(super) fn validate_fences(body: &str, level: &str) -> AppResult<()> {
    let mut fence: Option<(String, char, usize, String)> = None;
    for line in body.lines() {
        let trimmed = line.trim_start();
        let delimiter = trimmed.chars().next().filter(|ch| *ch == '`' || *ch == '~');
        let count = delimiter
            .map(|ch| {
                trimmed
                    .chars()
                    .take_while(|candidate| *candidate == ch)
                    .count()
            })
            .unwrap_or(0);
        if count >= 3 {
            if let Some((language, char, length, content)) = fence.take() {
                if delimiter == Some(char) && count >= length && trimmed[count..].trim().is_empty()
                {
                    if language == "before-after" {
                        let value: Value = serde_json::from_str(&content)?;
                        if !["before", "after"].iter().all(|key| {
                            value[*key].as_array().is_some_and(|items| {
                                !items.is_empty()
                                    && items.iter().all(|item| {
                                        item.as_str().is_some_and(|text| !text.trim().is_empty())
                                    })
                            })
                        }) {
                            return Err(invalid(
                                "A before-after block needs nonempty before and after text arrays.",
                            ));
                        }
                    }
                } else {
                    fence = Some((language, char, length, format!("{content}{line}\n")));
                }
            } else {
                let language = trimmed[count..].trim().to_owned();
                let allowed = match level {
                    "essential" => {
                        matches!(
                            language.as_str(),
                            "summary" | "before-after" | "mermaid" | "html"
                        )
                    }
                    "explained" => matches!(
                        language.as_str(),
                        "summary" | "before-after" | "mermaid" | "html"
                    ),
                    _ => matches!(
                        language.as_str(),
                        "summary" | "before-after" | "mermaid" | "source" | "html"
                    ),
                };
                if !allowed {
                    return Err(invalid(
                        "A reading-level document contains a forbidden source-code fence.",
                    ));
                }
                fence = Some((language, delimiter.unwrap_or('`'), count, String::new()));
            }
        } else if let Some((_, _, _, content)) = &mut fence {
            content.push_str(line);
            content.push('\n');
        }
    }
    if fence.is_some() {
        return Err(invalid("A Markdown code fence is unclosed."));
    }
    Ok(())
}

pub(super) fn line_count(text: &str) -> usize {
    text.lines().count()
}
