use crate::{contracts::*, snapshots, storage::Storage};
use std::collections::HashSet;

pub fn create(storage: &Storage, request: CaptureRequest) -> AppResult<Workspace> {
    let snapshot = snapshots::prepare_capture(storage, request, &mut |_, _, _, _| Ok(()))?;
    publish_creation(storage, snapshot)
}
pub(crate) fn publish_creation(storage: &Storage, snapshot: Snapshot) -> AppResult<Workspace> {
    let files = crate::reader::files(&snapshot);
    let position = file_position(&snapshot, &files);
    let review = Review {
        glossary: vec![],
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
        mode: ReviewMode::Manual,
        preparation_id: None,
        files,
        decisions: vec![],
        examined: vec![],
        position,
        created_at: now(),
        updated_at: now(),
    };
    storage.write_batch(vec![
        (
            "snapshot",
            &snapshot.id,
            None,
            serde_json::to_value(&snapshot)?,
        ),
        ("review", &review.id, None, serde_json::to_value(&review)?),
    ])?;
    Ok(Workspace { review, snapshot })
}
pub(crate) fn file_position(snapshot: &Snapshot, files: &[ReviewFile]) -> ReadingPosition {
    let first_change = files
        .first()
        .and_then(|f| f.change_ids.first())
        .and_then(|id| snapshot.changes.iter().find(|c| &c.id == id));
    ReadingPosition {
        context: ReadingContext::Files,
        file_id: files.first().map(|f| f.id.clone()),
        change_id: first_change.map(|c| c.id.clone()),
        passage_id: first_change
            .and_then(|c| c.passages.first())
            .map(|p| p.id.clone()),
        ..ReadingPosition::default()
    }
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
    if let ReviewAction::SavePosition { position } = action {
        let mut workspace = load(storage, id)?;
        if !position.scroll_top.is_finite() || position.scroll_top < 0.0 {
            return Err(AppError::new(
                "invalid_position",
                "Invalid scroll position.",
            ));
        }
        workspace.review.position = position;
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
        ReviewAction::SaveTopics { mut topics } => {
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
                    crate::reader::validate_documents_with_glossary(
                        storage,
                        &workspace.snapshot,
                        &step.documents,
                        &review.glossary,
                    )?;
                }
            }
            for topic in &mut topics {
                for step in &mut topic.steps {
                    crate::reader::estimate_reading_time(&mut step.documents);
                }
            }
            review.mode = if topics.is_empty() {
                ReviewMode::Manual
            } else {
                ReviewMode::Guided
            };
            review.topics = topics;
        }
        ReviewAction::ExamineStep { step_id } => {
            let target = DecisionTarget::Step { step_id };
            let fingerprint = target_fingerprint(&workspace.snapshot, review, &target)?;
            if !review.decisions.iter().any(|d| d.target == target) {
                review.decisions.push(Decision {
                    id: crate::contracts::id(),
                    author: storage.author()?,
                    target,
                    state: DecisionState::Examined,
                    fingerprint,
                    created_at: now(),
                });
            }
        }
        ReviewAction::ExamineFile { file_id } => {
            let target = DecisionTarget::File { file_id };
            let fingerprint = target_fingerprint(&workspace.snapshot, review, &target)?;
            if !review.decisions.iter().any(|d| d.target == target) {
                review.decisions.push(Decision {
                    id: crate::contracts::id(),
                    author: storage.author()?,
                    target,
                    state: DecisionState::Examined,
                    fingerprint,
                    created_at: now(),
                });
            }
        }
        ReviewAction::ValidateStep { step_id } => {
            let target = DecisionTarget::Step { step_id };
            let fingerprint =
                decision_fingerprint(storage, &workspace.snapshot, review, &target, None)?;
            if !review.decisions.iter().any(|d| {
                d.target == target
                    && d.fingerprint == fingerprint
                    && d.state == DecisionState::Validated
            }) {
                review.decisions.retain(|d| d.target != target);
                review.decisions.push(Decision {
                    id: crate::contracts::id(),
                    author: storage.author()?,
                    target,
                    state: DecisionState::Validated,
                    fingerprint,
                    created_at: now(),
                });
            }
        }
        ReviewAction::ValidateFile { file_id, level } => {
            let target = DecisionTarget::File { file_id };
            let fingerprint =
                decision_fingerprint(storage, &workspace.snapshot, review, &target, Some(level))?;
            if !review.decisions.iter().any(|d| {
                d.target == target
                    && d.fingerprint == fingerprint
                    && d.state == DecisionState::Validated
            }) {
                review.decisions.retain(|d| d.target != target);
                review.decisions.push(Decision {
                    id: crate::contracts::id(),
                    author: storage.author()?,
                    target,
                    state: DecisionState::Validated,
                    fingerprint,
                    created_at: now(),
                });
            }
        }
        ReviewAction::ReopenStep { step_id } => review.decisions.retain(|d| {
            d.target
                != DecisionTarget::Step {
                    step_id: step_id.clone(),
                }
        }),
        ReviewAction::ReopenFile { file_id } => review.decisions.retain(|d| {
            d.target
                != DecisionTarget::File {
                    file_id: file_id.clone(),
                }
        }),
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
fn target_fingerprint(
    snapshot: &Snapshot,
    review: &Review,
    target: &DecisionTarget,
) -> AppResult<String> {
    let value = match target {
        DecisionTarget::Step { step_id } => {
            let step = review
                .topics
                .iter()
                .flat_map(|t| &t.steps)
                .find(|s| &s.id == step_id)
                .ok_or_else(|| AppError::new("invalid_step", "Step does not exist."))?;
            let mut bindings = Vec::new();
            for anchor in &step.anchors {
                let p = passage(snapshot, anchor)?;
                bindings.push(p.fingerprint.clone());
            }
            serde_json::json!({"documents":step.documents,"bindings":bindings})
        }
        DecisionTarget::File { file_id } => {
            let canonical = crate::reader::files(snapshot);
            let file = canonical
                .iter()
                .find(|f| &f.id == file_id)
                .ok_or_else(|| AppError::new("invalid_file", "File does not exist."))?;
            let changes: Vec<_> = file
                .change_ids
                .iter()
                .map(|id| {
                    snapshot
                        .changes
                        .iter()
                        .find(|c| &c.id == id)
                        .ok_or_else(|| {
                            AppError::new("stale_file", "File change is no longer captured.")
                        })
                })
                .collect::<AppResult<_>>()?;
            serde_json::json!(changes.iter().map(|c|serde_json::json!({"path":c.path,"previousPath":c.previous_path,"layer":c.layer,"before":c.before,"after":c.after})).collect::<Vec<_>>())
        }
    };
    Ok(fingerprint(&serde_json::to_vec(&value)?))
}
fn decision_fingerprint(
    storage: &Storage,
    snapshot: &Snapshot,
    review: &Review,
    target: &DecisionTarget,
    level: Option<ReadingLevel>,
) -> AppResult<String> {
    match target {
        DecisionTarget::Step { step_id } => {
            let step = review
                .topics
                .iter()
                .flat_map(|t| &t.steps)
                .find(|s| &s.id == step_id)
                .ok_or_else(|| AppError::new("invalid_step", "Step does not exist."))?;
            crate::reader::validate_documents_with_glossary(
                storage,
                snapshot,
                &step.documents,
                &review.glossary,
            )?;
            for anchor in &step.anchors {
                passage(snapshot, anchor)?;
                let c = snapshot
                    .changes
                    .iter()
                    .find(|c| c.id == anchor.change_id)
                    .ok_or_else(|| AppError::new("invalid_anchor", "Change is missing."))?;
                for blob in [&c.before, &c.after].into_iter().flatten() {
                    storage.read_blob(&blob.hash)?;
                }
            }
        }
        DecisionTarget::File { file_id } => {
            let canonical = crate::reader::files(snapshot);
            let file = canonical
                .iter()
                .find(|f| &f.id == file_id)
                .ok_or_else(|| AppError::new("invalid_file", "File does not exist."))?;
            if level == Some(ReadingLevel::Beginner) {
                return Err(AppError::new(
                    "reading_level",
                    "File validation is unavailable in Beginner mode.",
                ));
            }
            if level == Some(ReadingLevel::Intermediate) {
                let content = crate::reader::read_file(storage, &review.id, file_id)?;
                if content.pseudocode_selected != Some(false)
                    && content.pseudocode_skip_reason.is_none()
                    && file.translations.iter().any(|t| {
                        !content.translations.iter().any(|v| {
                            v.source_id == t.source_id
                                && v.source_hash == t.source_hash
                                && v.unavailable_reason.is_none()
                        })
                    })
                {
                    return Err(AppError::new(
                        "missing_pseudocode",
                        "Pseudocode is unavailable for part of this file.",
                    ));
                }
            }
            for t in &file.translations {
                let source = crate::reader::sources(snapshot)
                    .into_iter()
                    .find(|source| source.source_id == t.source_id && source.hash == t.source_hash)
                    .ok_or_else(|| {
                        AppError::new("invalid_reference", "Captured source is missing.")
                    })?;
                let bytes = storage.read_blob(&source.hash)?;
                if bytes.len() != source.size as usize {
                    return Err(AppError::new(
                        "corrupt_blob",
                        "Captured source size does not match.",
                    ));
                }
            }
        }
    }
    target_fingerprint(snapshot, review, target)
}
pub fn coverage(workspace: &Workspace) -> Coverage {
    let review = &workspace.review;
    let targets: Vec<_> = if review.mode == ReviewMode::Guided {
        review
            .topics
            .iter()
            .flat_map(|t| {
                t.steps.iter().map(|s| DecisionTarget::Step {
                    step_id: s.id.clone(),
                })
            })
            .collect()
    } else {
        review
            .files
            .iter()
            .map(|f| DecisionTarget::File {
                file_id: f.id.clone(),
            })
            .collect()
    };
    let validated = targets
        .iter()
        .filter(|target| {
            target_fingerprint(&workspace.snapshot, review, target).is_ok_and(|fp| {
                review.decisions.iter().any(|d| {
                    &d.target == *target
                        && d.fingerprint == fp
                        && d.state == DecisionState::Validated
                })
            })
        })
        .count() as u32;
    let examined = targets
        .iter()
        .filter(|target| {
            target_fingerprint(&workspace.snapshot, review, target).is_ok_and(|fp| {
                review
                    .decisions
                    .iter()
                    .any(|d| &d.target == *target && d.fingerprint == fp)
            })
        })
        .count() as u32;
    let total = targets.len() as u32;
    Coverage {
        total,
        examined,
        validated,
        outside: 0,
        complete: total > 0 && total == validated,
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
    // Generated documents and references belong to their exact capture. Keep
    // them in history; a new capture starts on its own frozen file catalogue.
    workspace.review.topics.clear();
    workspace.review.mode = ReviewMode::Manual;
    workspace.review.files = crate::reader::files(&next);
    workspace.review.preparation_id = None;
    workspace.review.decisions.retain(|d| {
        matches!(d.target, DecisionTarget::File { .. })
            && target_fingerprint(&next, &previous_review, &d.target)
                .is_ok_and(|fp| fp == d.fingerprint)
    });
    workspace
        .review
        .previous_snapshot_ids
        .push(workspace.snapshot.id.clone());
    workspace.review.snapshot_id = next.id.clone();
    workspace.review.revision += 1;
    workspace.review.examined.clear();
    workspace.review.position = file_position(&next, &workspace.review.files);
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
