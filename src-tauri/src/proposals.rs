#[path = "proposals/knowledge.rs"]
pub(crate) mod code_explain;
use crate::{contracts::*, knowledge, reviews, storage::Storage};

fn validate(storage: &Storage, workspace: &Workspace, content: &ProposalContent) -> AppResult<()> {
    reviews::require_draft(&workspace.review)?;
    if serde_json::to_vec(content)?.len() > 512 * 1024 {
        return Err(AppError::new("proposal_limit", "Proposal exceeds 512 KiB."));
    }
    match content {
        ProposalContent::Topics { topics } => {
            if topics.is_empty() || topics.len() > 64 {
                return Err(AppError::new(
                    "invalid_proposal",
                    "Propose between 1 and 64 topics.",
                ));
            }
            reviews::prepare_action(
                storage,
                workspace.clone(),
                workspace.review.revision,
                ReviewAction::SaveTopics {
                    topics: topics.clone(),
                },
            )?;
        }
        ProposalContent::Explanation { path, sections } => {
            if sections.is_empty()
                || sections.len() > 256
                || sections
                    .iter()
                    .any(|s| s.title.trim().is_empty() || s.body.trim().is_empty())
            {
                return Err(AppError::new(
                    "invalid_proposal",
                    "Explanation needs 1–256 titled, non-empty sections.",
                ));
            }
            let mut value = knowledge::load(storage, &workspace.review.repository_id)?;
            value.documents.push(document(
                &workspace.snapshot,
                path,
                sections,
                &value.language,
            )?);
            knowledge::prepare(storage, value)?;
        }
        ProposalContent::Glossary { terms } => {
            if terms.is_empty() || terms.len() > 256 {
                return Err(AppError::new(
                    "invalid_proposal",
                    "Propose between 1 and 256 terms.",
                ));
            }
            let mut value = knowledge::load(storage, &workspace.review.repository_id)?;
            let mut terms = terms.clone();
            fresh_term_ids(&mut terms);
            value.terms.extend(terms);
            knowledge::prepare(storage, value)?;
        }
    }
    Ok(())
}
/// A draft may contain an unresolved anchor so that the user can repair it.
/// Shape errors remain rejected before persisting untrusted model output.
fn validate_draft(
    storage: &Storage,
    workspace: &Workspace,
    content: &ProposalContent,
) -> AppResult<()> {
    reviews::require_draft(&workspace.review)?;
    if serde_json::to_vec(content)?.len() > 512 * 1024 {
        return Err(AppError::new("proposal_limit", "Proposal exceeds 512 KiB."));
    }
    let ProposalContent::Topics { topics } = content else {
        return validate(storage, workspace, content);
    };
    if topics.is_empty() || topics.len() > 64 {
        return Err(AppError::new(
            "invalid_proposal",
            "Propose between 1 and 64 topics.",
        ));
    }
    let mut ids = std::collections::HashSet::new();
    for topic in topics {
        if topic.title.trim().is_empty()
            || !ids.insert(&topic.id)
            || topic.steps.is_empty()
            || topic.steps.len() > 512
        {
            return Err(AppError::new(
                "invalid_topic",
                "Topics need unique IDs, titles and 1–512 steps.",
            ));
        }
        for step in &topic.steps {
            if step.title.trim().is_empty() || !ids.insert(&step.id) || step.anchors.len() > 512 {
                return Err(AppError::new(
                    "invalid_step",
                    "Steps need unique IDs, titles and at most 512 anchors.",
                ));
            }
        }
    }
    Ok(())
}

pub(crate) fn diagnostics(
    storage: &Storage,
    review_id: &str,
    content: &ProposalContent,
) -> AppResult<Vec<ProposalDiagnostic>> {
    let workspace = reviews::load(storage, review_id)?;
    reviews::require_draft(&workspace.review)?;
    validate_draft(storage, &workspace, content)?;
    let mut diagnostics = vec![];
    if let ProposalContent::Topics { topics } = content {
        for (topic_index, topic) in topics.iter().enumerate() {
            for (step_index, step) in topic.steps.iter().enumerate() {
                if step.anchors.is_empty() {
                    diagnostics.push(ProposalDiagnostic {
                        topic_index: topic_index as u32,
                        step_index: step_index as u32,
                        anchor_index: None,
                        message: "Choose at least one frozen passage for this step.".into(),
                    });
                }
                for (anchor_index, anchor) in step.anchors.iter().enumerate() {
                    if let Err(error) = reviews::passage(&workspace.snapshot, anchor) {
                        diagnostics.push(ProposalDiagnostic {
                            topic_index: topic_index as u32,
                            step_index: step_index as u32,
                            anchor_index: Some(anchor_index as u32),
                            message: error.message,
                        });
                    }
                }
            }
        }
    }
    Ok(diagnostics)
}

fn document(
    snapshot: &Snapshot,
    path: &str,
    sections: &[ExplanationSection],
    language: &str,
) -> AppResult<ExplanationDocument> {
    let file = snapshot
        .files
        .iter()
        .find(|f| f.path == path)
        .ok_or_else(|| {
            AppError::new(
                "invalid_path",
                "Explanation source is not in this snapshot.",
            )
        })?;
    let mut sections = sections.to_vec();
    for section in &mut sections {
        section.id = id();
    }
    Ok(ExplanationDocument {
        id: id(),
        repository_id: snapshot.repository_id.clone(),
        snapshot_id: snapshot.id.clone(),
        path: path.into(),
        fingerprint: file.content.hash.clone(),
        language: language.into(),
        sections,
        occurrences: vec![],
        created_at: now(),
    })
}
fn fresh_term_ids(terms: &mut [GlossaryTerm]) {
    for term in terms {
        term.id = id();
        term.archived = false;
        for sense in &mut term.senses {
            sense.id = id();
        }
    }
}
pub fn parse(
    storage: &Storage,
    review_id: &str,
    text: &str,
    run_id: Option<String>,
) -> AppResult<Proposal> {
    if text.len() > 512 * 1024 {
        return Err(AppError::new("proposal_limit", "Proposal exceeds 512 KiB."));
    }
    let workspace = reviews::load(storage, review_id)?;
    let raw = text.trim();
    let raw = raw
        .strip_prefix("```json\n")
        .or_else(|| raw.strip_prefix("```\n"))
        .and_then(|s| s.strip_suffix("```"))
        .unwrap_or(raw);
    let content: ProposalContent = serde_json::from_str(raw.trim())?;
    if let Some(run_id) = &run_id {
        let run: AgentRun = storage.get("agent_run", run_id)?;
        if run.review_id != review_id
            || run.snapshot_id != workspace.snapshot.id
            || run.status != "completed"
        {
            return Err(AppError::new(
                "stale_proposal",
                "This agent response does not belong to the current snapshot.",
            ));
        }
        let correct_kind = matches!(
            (&*run.action, &content),
            ("topics", ProposalContent::Topics { .. })
                | (
                    "file" | "block" | "refresh",
                    ProposalContent::Explanation { .. }
                )
                | ("glossary", ProposalContent::Glossary { .. })
        );
        if !correct_kind {
            return Err(AppError::new(
                "invalid_proposal",
                "Response does not match the requested action.",
            ));
        }
    }
    validate_draft(storage, &workspace, &content)?;
    let proposal = Proposal {
        context_id: None,
        id: id(),
        review_id: review_id.into(),
        snapshot_id: workspace.snapshot.id,
        run_id,
        content,
        status: "pending".into(),
        revision: 0,
        created_at: now(),
    };
    storage.insert("proposal", &proposal.id, &proposal)?;
    Ok(proposal)
}
pub fn answer(
    storage: &Storage,
    proposal_id: &str,
    revision: u32,
    content: ProposalContent,
    accepted: bool,
) -> AppResult<Proposal> {
    if proposal_id.starts_with("knowledge-") {
        return code_explain::answer(storage, proposal_id, revision, content, accepted);
    }
    let mut proposal: Proposal = storage.get("proposal", proposal_id)?;
    if proposal.revision != revision || proposal.status != "pending" {
        return Err(AppError::new(
            "conflict",
            "This proposal was already answered or changed.",
        ));
    }
    let workspace = reviews::load(storage, &proposal.review_id)?;
    reviews::require_draft(&workspace.review)?;
    proposal.revision += 1;
    proposal.status = if accepted { "accepted" } else { "rejected" }.into();
    if !accepted {
        storage.replace("proposal", proposal_id, revision, &proposal)?;
        return Ok(proposal);
    }
    if proposal.snapshot_id != workspace.snapshot.id {
        return Err(AppError::new(
            "stale_proposal",
            "Code changed since this proposal. Generate a fresh proposal.",
        ));
    }
    validate(storage, &workspace, &content)?;
    proposal.content = content.clone();
    let proposal_write = (
        "proposal",
        proposal_id,
        Some(revision),
        serde_json::to_value(&proposal)?,
    );
    match content {
        ProposalContent::Topics { mut topics } => {
            for topic in &mut topics {
                topic.id = id();
                for step in &mut topic.steps {
                    step.id = id();
                }
            }
            let mut combined = workspace.review.topics.clone();
            combined.extend(topics);
            let next = reviews::prepare_action(
                storage,
                workspace.clone(),
                workspace.review.revision,
                ReviewAction::SaveTopics { topics: combined },
            )?;
            storage.write_batch(vec![
                proposal_write,
                (
                    "review",
                    &next.review.id,
                    Some(workspace.review.revision),
                    serde_json::to_value(&next.review)?,
                ),
            ])?;
        }
        other => {
            let mut value = knowledge::load(storage, &workspace.review.repository_id)?;
            match other {
                ProposalContent::Explanation { path, sections } => value.documents.push(document(
                    &workspace.snapshot,
                    &path,
                    &sections,
                    &value.language,
                )?),
                ProposalContent::Glossary { mut terms } => {
                    fresh_term_ids(&mut terms);
                    value.terms.extend(terms);
                }
                _ => unreachable!(),
            }
            let (value, previous_revision) = knowledge::prepare(storage, value)?;
            // Also check the review revision so a concurrent refresh cannot accept stale knowledge.
            let mut review = workspace.review.clone();
            review.revision += 1;
            review.updated_at = now();
            storage.write_batch(vec![
                proposal_write,
                (
                    "knowledge",
                    &value.repository_id,
                    previous_revision,
                    serde_json::to_value(&value)?,
                ),
                (
                    "review",
                    &review.id,
                    Some(workspace.review.revision),
                    serde_json::to_value(&review)?,
                ),
            ])?;
        }
    }
    Ok(proposal)
}

#[cfg(test)]
mod tests;
