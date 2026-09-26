use crate::{contracts::*, snapshots, storage::Storage};
use std::collections::HashSet;

pub fn create(storage: &Storage, request: CaptureRequest) -> AppResult<Workspace> {
    let snapshot = snapshots::capture(storage, request)?;
    let review = Review {
        id: id(),
        title: match snapshot.request.scope {
            Scope::Local => "Local changes",
            Scope::Staged => "Staged changes",
            Scope::Unstaged => "Unstaged changes",
            Scope::Commit => "Commit review",
            Scope::Range => "Commit range",
        }
        .into(),
        repository_id: snapshot.repository_id.clone(),
        snapshot_id: snapshot.id.clone(),
        previous_snapshot_ids: vec![],
        revision: 0,
        topics: vec![],
        annotations: vec![],
        decisions: vec![],
        examined: vec![],
        position: ReadingPosition::default(),
        created_at: now(),
        updated_at: now(),
    };
    storage.insert("review", &review.id, &review)?;
    Ok(Workspace { review, snapshot })
}
pub fn load(storage: &Storage, id: &str) -> AppResult<Workspace> {
    let review: Review = storage.get("review", id)?;
    let snapshot = storage.get("snapshot", &review.snapshot_id)?;
    Ok(Workspace { review, snapshot })
}
pub fn passage<'a>(snapshot: &'a Snapshot, anchor: &CodeAnchor) -> AppResult<&'a Passage> {
    if anchor.snapshot_id != snapshot.id {
        return Err(AppError::new(
            "stale_anchor",
            "This anchor belongs to a different snapshot.",
        ));
    }
    snapshot
        .changes
        .iter()
        .find(|c| c.id == anchor.change_id)
        .and_then(|c| c.passages.iter().find(|p| p.id == anchor.passage_id))
        .ok_or_else(|| AppError::new("invalid_anchor", "The passage no longer exists."))
}
pub fn apply(
    storage: &Storage,
    id: &str,
    revision: u32,
    action: ReviewAction,
) -> AppResult<Workspace> {
    if matches!(
        action,
        ReviewAction::SavePosition { .. } | ReviewAction::Examine { .. }
    ) {
        let mut workspace = load(storage, id)?;
        match action {
            ReviewAction::SavePosition { position } => {
                if !position.scroll_top.is_finite() || position.scroll_top < 0.0 {
                    return Err(AppError::new(
                        "invalid_position",
                        "Invalid scroll position.",
                    ));
                }
                workspace.review.position = position;
            }
            ReviewAction::Examine { anchor } => {
                passage(&workspace.snapshot, &anchor)?;
                if !workspace.review.examined.contains(&anchor.passage_id) {
                    workspace.review.examined.push(anchor.passage_id);
                }
            }
            _ => unreachable!(),
        }
        storage.save_reading(&workspace.review)?;
        return Ok(workspace);
    }
    let workspace = prepare_action(storage, load(storage, id)?, revision, action)?;
    storage.replace("review", id, revision, &workspace.review)?;
    Ok(workspace)
}
pub fn prepare_action(
    storage: &Storage,
    mut workspace: Workspace,
    revision: u32,
    action: ReviewAction,
) -> AppResult<Workspace> {
    let review = &mut workspace.review;
    if review.revision != revision {
        return Err(AppError::new(
            "conflict",
            "Reload the review before editing it.",
        ));
    }
    match action {
        ReviewAction::Rename { title } => {
            if title.trim().is_empty() {
                return Err(AppError::new("invalid_title", "A title is required."));
            }
            review.title = title.trim().into();
        }
        ReviewAction::SaveTopics { topics } => {
            let mut ids = HashSet::new();
            for topic in &topics {
                if topic.title.trim().is_empty() || !ids.insert(&topic.id) {
                    return Err(AppError::new(
                        "invalid_topic",
                        "Topics need distinct IDs and non-empty titles.",
                    ));
                }
                for step in &topic.steps {
                    if step.title.trim().is_empty()
                        || step.anchors.is_empty()
                        || !ids.insert(&step.id)
                    {
                        return Err(AppError::new(
                            "invalid_step",
                            "Steps need a title, unique ID and at least one anchor.",
                        ));
                    }
                    for anchor in &step.anchors {
                        passage(&workspace.snapshot, anchor)?;
                    }
                }
            }
            review.topics = topics;
        }
        ReviewAction::Validate { anchor } => {
            let fingerprint = passage(&workspace.snapshot, &anchor)?.fingerprint.clone();
            if !review.decisions.iter().any(|d| {
                d.anchor.snapshot_id == anchor.snapshot_id
                    && d.anchor.passage_id == anchor.passage_id
            }) {
                review.decisions.push(Decision {
                    author: storage.author()?,
                    id: crate::contracts::id(),
                    anchor,
                    fingerprint,
                    created_at: now(),
                });
            }
        }
        ReviewAction::Reopen { anchor } => {
            passage(&workspace.snapshot, &anchor)?;
            review.decisions.retain(|d| {
                d.anchor.snapshot_id != anchor.snapshot_id
                    || d.anchor.passage_id != anchor.passage_id
            });
        }
        ReviewAction::Examine { anchor } => {
            passage(&workspace.snapshot, &anchor)?;
            if !review.examined.contains(&anchor.passage_id) {
                review.examined.push(anchor.passage_id);
            }
        }
        ReviewAction::AddAnnotation {
            anchor,
            body,
            question,
        } => {
            passage(&workspace.snapshot, &anchor)?;
            if body.trim().is_empty() || body.len() > 128 * 1024 {
                return Err(AppError::new(
                    "invalid_note",
                    "A note must contain between 1 and 131072 bytes.",
                ));
            }
            review.annotations.push(Annotation {
                resolved_by: None,
                resolved_at: None,
                id: crate::contracts::id(),
                anchor,
                body,
                question,
                resolved: false,
                author: storage.author()?,
                created_at: now(),
            });
        }
        ReviewAction::KeepAgentNote { anchor, run_id } => {
            passage(&workspace.snapshot, &anchor)?;
            let run: AgentRun = storage.get("agent_run", &run_id)?;
            if run.review_id != review.id
                || run.snapshot_id != workspace.snapshot.id
                || run.status != "completed"
                || run.output.trim().is_empty()
                || run.output.len() > 128 * 1024
            {
                return Err(AppError::new(
                    "invalid_agent_note",
                    "Only a completed response for this snapshot can be kept.",
                ));
            }
            review.annotations.push(Annotation {
                resolved_by: None,
                resolved_at: None,
                id: crate::contracts::id(),
                anchor,
                body: run.output,
                question: false,
                resolved: false,
                author: format!("agent:{}:{}", run.provider, run.id),
                created_at: now(),
            });
        }
        ReviewAction::ResolveQuestion { id, resolved } => {
            let note = review
                .annotations
                .iter_mut()
                .find(|n| n.id == id && n.question)
                .ok_or_else(|| AppError::new("not_found", "Question not found."))?;
            note.resolved = resolved;
            note.resolved_by = Some(storage.author()?);
            note.resolved_at = Some(now());
        }
        ReviewAction::DeleteAnnotation { id } => review.annotations.retain(|n| n.id != id),
        ReviewAction::SavePosition { position } => {
            if !position.scroll_top.is_finite() || position.scroll_top < 0.0 {
                return Err(AppError::new(
                    "invalid_position",
                    "Invalid scroll position.",
                ));
            }
            review.position = position;
        }
    }
    review.revision += 1;
    review.updated_at = now();
    Ok(workspace)
}
pub fn coverage(workspace: &Workspace) -> Coverage {
    let review = &workspace.review;
    let snapshot = &workspace.snapshot;
    let all: HashSet<_> = snapshot
        .changes
        .iter()
        .flat_map(|c| c.passages.iter().map(|p| p.id.as_str()))
        .collect();
    let covered: HashSet<_> = review
        .topics
        .iter()
        .flat_map(|t| t.steps.iter())
        .flat_map(|s| s.anchors.iter())
        .filter(|a| a.snapshot_id == snapshot.id)
        .map(|a| a.passage_id.as_str())
        .collect();
    let validated: HashSet<_> = review
        .decisions
        .iter()
        .filter(|d| passage(snapshot, &d.anchor).is_ok_and(|p| p.fingerprint == d.fingerprint))
        .map(|d| d.anchor.passage_id.as_str())
        .collect();
    let examined: HashSet<_> = review
        .examined
        .iter()
        .map(String::as_str)
        .chain(validated.iter().copied())
        .collect();
    let questions = review
        .annotations
        .iter()
        .filter(|n| n.question && !n.resolved)
        .count() as u32;
    Coverage {
        total: all.len() as u32,
        examined: all.intersection(&examined).count() as u32,
        validated: validated.len() as u32,
        outside: all.difference(&covered).count() as u32,
        questions,
        complete: !all.is_empty() && all == validated && questions == 0,
    }
}
pub fn refresh(storage: &Storage, id: &str, revision: u32) -> AppResult<Workspace> {
    let mut workspace = load(storage, id)?;
    if workspace.review.revision != revision {
        return Err(AppError::new(
            "conflict",
            "Reload before capturing a new version.",
        ));
    }
    let previous_review = workspace.review.clone();
    let next = snapshots::capture(storage, workspace.snapshot.request.clone())?;
    // Conservatively retain a decision only when the changed content matches uniquely
    // in the same file and layer. Ambiguous matches retain history, never validation.
    let remap = |anchor: &CodeAnchor| -> Option<CodeAnchor> {
        let old = workspace
            .snapshot
            .changes
            .iter()
            .find(|c| c.id == anchor.change_id)?;
        let old_passage = passage(&workspace.snapshot, anchor).ok()?;
        let matches: Vec<_> = next
            .changes
            .iter()
            .filter(|c| c.path == old.path && c.layer == old.layer)
            .flat_map(|c| {
                c.passages
                    .iter()
                    .filter(|p| p.fingerprint == old_passage.fingerprint)
                    .map(move |p| (c, p))
            })
            .collect();
        let old_count = old
            .passages
            .iter()
            .filter(|p| p.fingerprint == old_passage.fingerprint)
            .count();
        if matches.len() != 1 || old_count != 1 {
            return None;
        }
        Some(CodeAnchor {
            snapshot_id: next.id.clone(),
            change_id: matches[0].0.id.clone(),
            passage_id: matches[0].1.id.clone(),
        })
    };
    let mut inherited = Vec::new();
    for decision in &workspace.review.decisions {
        if let Some(anchor) = remap(&decision.anchor) {
            inherited.push(Decision {
                author: decision.author.clone(),
                id: crate::contracts::id(),
                anchor,
                fingerprint: decision.fingerprint.clone(),
                created_at: decision.created_at.clone(),
            });
        }
    }
    for topic in &mut workspace.review.topics {
        for step in &mut topic.steps {
            for anchor in &mut step.anchors {
                if let Some(new) = remap(anchor) {
                    *anchor = new;
                }
            }
        }
    }
    for note in &mut workspace.review.annotations {
        if let Some(new) = remap(&note.anchor) {
            note.anchor = new;
        }
    }
    workspace.review.decisions.extend(inherited);
    workspace
        .review
        .previous_snapshot_ids
        .push(workspace.snapshot.id.clone());
    workspace.review.snapshot_id = next.id.clone();
    workspace.review.revision += 1;
    workspace.review.examined.clear();
    workspace.review.position = ReadingPosition::default();
    workspace.review.updated_at = now();
    let history_id = format!("{id}@{revision}");
    storage.write_batch(vec![
        (
            "review_history",
            &history_id,
            None,
            serde_json::to_value(&previous_review)?,
        ),
        (
            "review",
            id,
            Some(revision),
            serde_json::to_value(&workspace.review)?,
        ),
    ])?;
    workspace.snapshot = next;
    Ok(workspace)
}

#[cfg(test)]
mod tests;
