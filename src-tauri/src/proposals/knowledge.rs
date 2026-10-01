//! Code Explain proposals have a frozen source context, never a review owner.
use super::*;

fn value(
    storage: &Storage,
    snapshot: &Snapshot,
    proposal_id: &str,
    content: &ProposalContent,
) -> AppResult<ProjectKnowledge> {
    let mut value = knowledge::load(storage, &snapshot.repository_id)?;
    match content {
        ProposalContent::Explanation { path, sections } => {
            if sections.is_empty()
                || sections.len() > 256
                || sections
                    .iter()
                    .any(|s| s.title.trim().is_empty() || s.body.trim().is_empty())
            {
                return Err(AppError::new(
                    "invalid_proposal",
                    "Provide titled, non-empty explanation sections.",
                ));
            }
            let mut document = super::document(snapshot, path, sections, &value.language)?;
            // Stable IDs make acceptance idempotent across a crash between the
            // shared writer's transaction and the private proposal receipt.
            document.id = proposal_id.into();
            for (i, section) in document.sections.iter_mut().enumerate() {
                section.id = format!("{proposal_id}-{i}");
            }
            if !value.documents.iter().any(|d| d.id == document.id) {
                value.documents.push(document);
            }
        }
        ProposalContent::Glossary { terms } => {
            if terms.is_empty() || terms.len() > 256 {
                return Err(AppError::new(
                    "invalid_proposal",
                    "Provide 1–256 glossary terms.",
                ));
            }
            for (i, term) in terms.iter().enumerate() {
                let mut term = term.clone();
                term.id = format!("{proposal_id}-{i}");
                term.archived = false;
                for (j, sense) in term.senses.iter_mut().enumerate() {
                    sense.id = format!("{proposal_id}-{i}-{j}");
                }
                if !value.terms.iter().any(|t| t.id == term.id) {
                    value.terms.push(term);
                }
            }
        }
        _ => {
            return Err(AppError::new(
                "invalid_proposal",
                "Code Explain cannot create review steps.",
            ));
        }
    }
    knowledge::prepare(storage, value.clone())?;
    Ok(value)
}
pub(crate) fn parse(storage: &Storage, run: &AgentRun) -> AppResult<Proposal> {
    let context = run
        .context_id
        .as_deref()
        .ok_or_else(|| AppError::new("context", "Missing source context."))?;
    if run.status != "completed" || run.snapshot_id != context {
        return Err(AppError::new(
            "stale_proposal",
            "This generation did not finish for these sources.",
        ));
    }
    if let Some(proposal) = storage
        .list::<Proposal>("knowledge_proposal")?
        .into_iter()
        .find(|p| p.run_id.as_deref() == Some(&run.id))
    {
        return Ok(proposal);
    }
    let snapshot: Snapshot = storage.get("snapshot", context)?;
    let text = run.output.trim();
    if text.len() > 512 * 1024 {
        return Err(AppError::new("proposal_limit", "Proposal exceeds 512 KiB."));
    }
    let text = text
        .strip_prefix("```json\n")
        .or_else(|| text.strip_prefix("```\n"))
        .and_then(|t| t.strip_suffix("```"))
        .unwrap_or(text);
    let content: ProposalContent = serde_json::from_str(text.trim())?;
    if !matches!(
        (&*run.action, &content),
        (
            "file" | "block" | "refresh",
            ProposalContent::Explanation { .. }
        ) | ("glossary", ProposalContent::Glossary { .. })
    ) {
        return Err(AppError::new(
            "invalid_proposal",
            "Response does not match the requested action.",
        ));
    }
    let proposal = Proposal {
        id: format!("knowledge-{}", id()),
        review_id: String::new(),
        context_id: Some(context.into()),
        snapshot_id: snapshot.id.clone(),
        run_id: Some(run.id.clone()),
        content,
        status: "pending".into(),
        revision: 0,
        created_at: now(),
    };
    value(storage, &snapshot, &proposal.id, &proposal.content)?;
    storage.insert("knowledge_proposal", &proposal.id, &proposal)?;
    Ok(proposal)
}
pub(crate) fn answer(
    storage: &Storage,
    id: &str,
    revision: u32,
    content: ProposalContent,
    accepted: bool,
) -> AppResult<Proposal> {
    let _guard = storage.read_consistently();
    let mut proposal: Proposal = storage.get("knowledge_proposal", id)?;
    if proposal.revision != revision || proposal.status != "pending" {
        return Err(AppError::new(
            "conflict",
            "This proposal has already been answered.",
        ));
    }
    let snapshot: Snapshot = storage.get("snapshot", &proposal.snapshot_id)?;
    if accepted {
        knowledge::save(storage, value(storage, &snapshot, id, &content)?)?;
        proposal.content = content;
    }
    proposal.status = if accepted { "accepted" } else { "rejected" }.into();
    proposal.revision += 1;
    storage.replace("knowledge_proposal", id, revision, &proposal)?;
    // A view that already closed can now release the proposal's private sources.
    // Accepted knowledge already owns its durable copy in the shared writer.
    if let Some(context) = &proposal.context_id {
        let _ = storage.release_finished_context(context);
    }
    Ok(proposal)
}
