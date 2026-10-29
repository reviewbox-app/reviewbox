use crate::{contracts::*, snapshots, storage::Storage};
use std::collections::HashSet;

pub fn create(storage: &Storage, request: CaptureRequest) -> AppResult<Workspace> {
    let _sources = storage.pin_source_cache();
    let snapshot = snapshots::prepare_capture(storage, request, &mut |_, _, _, _| Ok(()))?;
    publish_creation(storage, snapshot)
}
pub(crate) fn publish_creation(storage: &Storage, snapshot: Snapshot) -> AppResult<Workspace> {
    let files = crate::reader::files(&snapshot);
    let position = file_position(&snapshot, &files);
    let review = Review {
        update_origin: None,
        needs_update_confirmation: false,
        publication: ReviewPublication::default(),
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
    let _read = storage.read_consistently();
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
        let _read = storage.read_consistently();
        let mut workspace = load(storage, id)?;
        if position
            .change_id
            .as_ref()
            .is_some_and(|id| !workspace.snapshot.changes.iter().any(|c| &c.id == id))
        {
            return Err(AppError::new(
                "stale_position",
                "This reading position belongs to another capture.",
            ));
        }
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
    let current = load(storage, id)?;
    storage.check_update_write(&current.review.repository_id, id)?;
    if current.review.publication.is_complete() {
        if matches!(
            action,
            ReviewAction::ReopenReview
                | ReviewAction::ReopenStep { .. }
                | ReviewAction::ReopenFile { .. }
        ) {
            return reopen(storage, current, revision, action);
        }
        // A repeated click after the final validation acknowledges the durable
        // result. It must not publish a second bundle or record another decision.
        let repeated_completion = matches!(
            action,
            ReviewAction::CompleteManualReview | ReviewAction::CompleteUpdatedReview
        ) && current.review.publication.completion.as_ref().is_some_and(
            |completion| {
                completion.kind == ReviewCompletionKind::Manual
                    || matches!(action, ReviewAction::CompleteUpdatedReview)
            },
        );
        let repeated_step = if let ReviewAction::ValidateStep { ref step_id } = action {
            let target = DecisionTarget::Step {
                step_id: step_id.clone(),
            };
            current.review.decisions.iter().any(|decision| {
                decision.target == target && decision.state == DecisionState::Validated
            })
        } else {
            false
        };
        if repeated_completion
            || repeated_step
            || (matches!(action, ReviewAction::RetryPublication)
                && current.review.publication.is_shared())
        {
            return Ok(current);
        }
    }
    let workspace = prepare_action(storage, current, revision, action)?;
    storage.replace("review", id, revision, &workspace.review)?;
    if workspace.review.publication.is_complete() {
        // Cleanup is best-effort and never reverses a durable human completion.
        // Per-file failures remain visible through review_working_context and can be retried.
        let _ = crate::working_context::cleanup(storage, &workspace.review);
    }
    publish_if_ready(storage, workspace)
}

fn publish_if_ready(storage: &Storage, workspace: Workspace) -> AppResult<Workspace> {
    if workspace.review.publication.status == PublicationStatus::PublicationPending {
        storage.publish_review(&workspace.review.id)
    } else {
        if workspace.review.publication.status == PublicationStatus::CompletedLocal {
            storage.collect_review_garbage(&workspace.review.repository_id)?;
        }
        Ok(workspace)
    }
}

pub(crate) fn require_draft(review: &Review) -> AppResult<()> {
    if review.publication.is_complete() {
        return Err(AppError::new(
            "immutable_review",
            "This completed review is read-only. Reopen it to create a local draft.",
        ));
    }
    Ok(())
}

fn reopen(
    storage: &Storage,
    mut workspace: Workspace,
    revision: u32,
    action: ReviewAction,
) -> AppResult<Workspace> {
    if workspace.review.revision != revision {
        return Err(AppError::new(
            "conflict",
            "Reload before reopening this review.",
        ));
    }
    fork_review(&mut workspace.review);
    // A full reopening invalidates the completion rather than manufacturing
    // unchecked file decisions or modifying the old published attestation.
    if matches!(action, ReviewAction::ReopenReview) {
        workspace.review.decisions.clear();
    } else {
        workspace = prepare_action(storage, workspace, 0, action)?;
        workspace.review.revision = 0;
    }
    let mut value = serde_json::to_value(&workspace.review)?;
    value["forkRevision"] = revision.into();
    storage.insert("review", &workspace.review.id, &value)?;
    Ok(workspace)
}

fn fork_review(review: &mut Review) {
    review.needs_update_confirmation = false;
    let origin = review.id.clone();
    let keep_local = review.publication.keep_local;
    review.id = id();
    review.revision = 0;
    review.created_at = now();
    review.updated_at = now();
    review.previous_snapshot_ids.clear();
    review.publication = ReviewPublication {
        keep_local,
        origin_review_id: Some(origin),
        ..ReviewPublication::default()
    };
}
pub fn prepare_action(
    storage: &Storage,
    mut workspace: Workspace,
    revision: u32,
    action: ReviewAction,
) -> AppResult<Workspace> {
    let review = &mut workspace.review;
    storage.check_update_write(&review.repository_id, &review.id)?;
    if review.revision != revision {
        return Err(AppError::new(
            "conflict",
            "Reload the review before editing it.",
        ));
    }
    let publication_only = matches!(
        action,
        ReviewAction::SetKeepLocal { .. } | ReviewAction::RetryPublication
    );
    if !publication_only {
        require_draft(review)?;
    } else if review.publication.is_shared() {
        return Err(AppError::new(
            "immutable_review",
            "A shared review cannot be made local. Reopen it to create a local draft.",
        ));
    }
    let validates_step = matches!(action, ReviewAction::ValidateStep { .. });
    if matches!(action, ReviewAction::CompleteUpdatedReview)
        && (!review.needs_update_confirmation || !coverage(&workspace).complete)
    {
        return Err(AppError::new(
            "review_incomplete",
            "Validate the remaining steps before completing this update.",
        ));
    }
    let review = &mut workspace.review;
    match action {
        ReviewAction::CompleteUpdatedReview => {
            verify_captured_scope(storage, &workspace.snapshot)?;
            complete(
                storage,
                review,
                &workspace.snapshot,
                ReviewCompletionKind::Guided,
            )?;
        }
        ReviewAction::CompleteManualReview => {
            if review.mode != ReviewMode::Manual {
                return Err(AppError::new(
                    "review_mode",
                    "Validate the guided steps to complete this review.",
                ));
            }
            verify_captured_scope(storage, &workspace.snapshot)?;
            complete(
                storage,
                review,
                &workspace.snapshot,
                ReviewCompletionKind::Manual,
            )?;
        }
        ReviewAction::SetKeepLocal { keep_local } => {
            review.publication.keep_local = keep_local;
            review.publication.publication_error = None;
            if review.publication.completion.is_some() {
                review.publication.status = if keep_local {
                    PublicationStatus::CompletedLocal
                } else {
                    PublicationStatus::PublicationPending
                };
            }
        }
        ReviewAction::RetryPublication => {
            if review.publication.completion.is_none() || review.publication.keep_local {
                return Err(AppError::new(
                    "publication_state",
                    "Only a validated review awaiting publication can be retried.",
                ));
            }
            review.publication.status = PublicationStatus::PublicationPending;
            review.publication.publication_error = None;
        }
        ReviewAction::ReopenReview => {
            return Err(AppError::new(
                "review_state",
                "This review is already a local draft.",
            ));
        }
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
                    carried_from: None,
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
                    carried_from: None,
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
            let fingerprint = decision_fingerprint(storage, &workspace.snapshot, review, &target)?;
            if !review.decisions.iter().any(|d| {
                d.target == target
                    && d.fingerprint == fingerprint
                    && d.state == DecisionState::Validated
            }) {
                review.decisions.retain(|d| d.target != target);
                review.decisions.push(Decision {
                    carried_from: None,
                    id: crate::contracts::id(),
                    author: storage.author()?,
                    target,
                    state: DecisionState::Validated,
                    fingerprint,
                    created_at: now(),
                });
            }
        }
        ReviewAction::ValidateFile { file_id } => {
            let target = DecisionTarget::File { file_id };
            let fingerprint = decision_fingerprint(storage, &workspace.snapshot, review, &target)?;
            if !review.decisions.iter().any(|d| {
                d.target == target
                    && d.fingerprint == fingerprint
                    && d.state == DecisionState::Validated
            }) {
                review.decisions.retain(|d| d.target != target);
                review.decisions.push(Decision {
                    carried_from: None,
                    id: crate::contracts::id(),
                    author: storage.author()?,
                    target,
                    state: DecisionState::Validated,
                    fingerprint,
                    created_at: now(),
                });
            }
        }
        ReviewAction::ReopenStep { step_id } => {
            review.needs_update_confirmation = false;
            let target = DecisionTarget::Step { step_id };
            target_fingerprint(&workspace.snapshot, review, &target)?;
            review
                .decisions
                .retain(|decision| decision.target != target);
        }
        ReviewAction::ReopenFile { file_id } => {
            let target = DecisionTarget::File { file_id };
            target_fingerprint(&workspace.snapshot, review, &target)?;
            review
                .decisions
                .retain(|decision| decision.target != target);
        }
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
    if validates_step
        && !workspace.review.needs_update_confirmation
        && workspace.review.mode == ReviewMode::Guided
        && coverage(&workspace).complete
    {
        complete(
            storage,
            &mut workspace.review,
            &workspace.snapshot,
            ReviewCompletionKind::Guided,
        )?;
    }
    Ok(workspace)
}

fn complete(
    storage: &Storage,
    review: &mut Review,
    snapshot: &Snapshot,
    kind: ReviewCompletionKind,
) -> AppResult<()> {
    review.needs_update_confirmation = false;
    review.publication.completion = Some(ReviewCompletion {
        kind,
        author: storage.author()?,
        completed_at: now(),
        scope_fingerprint: scope_fingerprint(snapshot)?,
        scope: snapshot.request.scope.clone(),
        include_untracked: snapshot.request.include_untracked,
        base_commit_id: matches!(snapshot.request.scope, Scope::Commit | Scope::Range)
            .then(|| snapshot.git_refs.get(1).cloned())
            .flatten(),
        target_commit_id: matches!(snapshot.request.scope, Scope::Commit | Scope::Range)
            .then(|| snapshot.git_refs.get(2).cloned())
            .flatten(),
    });
    review.publication.status = if review.publication.keep_local {
        PublicationStatus::CompletedLocal
    } else {
        PublicationStatus::PublicationPending
    };
    review.publication.publication_error = None;
    review.publication.file_count = Some(review.files.len() as u32);
    review.publication.step_count = Some(
        review
            .topics
            .iter()
            .map(|topic| topic.steps.len() as u32)
            .sum(),
    );
    Ok(())
}

pub(crate) fn scope_fingerprint(snapshot: &Snapshot) -> AppResult<String> {
    crate::project_storage::publication::scope_fingerprint(snapshot)
}

fn verify_captured_scope(storage: &Storage, snapshot: &Snapshot) -> AppResult<()> {
    let mut checked = HashSet::new();
    for blob in snapshot.files.iter().map(|file| &file.content).chain(
        snapshot
            .changes
            .iter()
            .flat_map(|change| [&change.before, &change.after].into_iter().flatten()),
    ) {
        if checked.insert(&blob.hash) {
            let bytes = storage.read_blob(&blob.hash)?;
            if bytes.len() != blob.size as usize || fingerprint(&bytes) != blob.hash {
                return Err(AppError::new(
                    "corrupt_blob",
                    "The captured scope could not be verified.",
                ));
            }
        }
    }
    Ok(())
}
pub(crate) fn target_fingerprint(
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
            for source in crate::reader::sources(snapshot)
                .into_iter()
                .filter(|source| {
                    file.change_ids
                        .iter()
                        .any(|id| source.source_id.starts_with(&format!("change:{id}:")))
                })
            {
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
    let _sources = storage.pin_source_cache();
    let mut workspace = load(storage, id)?;
    storage.check_update_write(&workspace.review.repository_id, id)?;
    if workspace.review.revision != revision {
        return Err(AppError::new(
            "conflict",
            "Reload before capturing a new version.",
        ));
    }
    let completed = workspace.review.publication.is_complete();
    let next = snapshots::prepare_capture(
        storage,
        workspace.snapshot.request.clone(),
        &mut |_, _, _, _| Ok(()),
    )?;
    if completed {
        fork_review(&mut workspace.review);
    }
    // Preparing the capture does not publish it. The old capture stays usable
    // until the optimistic transaction installs both the new review and sources.
    workspace.review.needs_update_confirmation = false;
    workspace.review.topics.clear();
    workspace.review.glossary.clear();
    workspace.review.mode = ReviewMode::Manual;
    workspace.review.files = crate::reader::files(&next);
    workspace.review.preparation_id = None;
    workspace.review.decisions.clear();
    workspace.review.previous_snapshot_ids.clear();
    workspace.review.snapshot_id = next.id.clone();
    if !completed {
        workspace.review.revision += 1;
    }
    workspace.review.examined.clear();
    workspace.review.position = file_position(&next, &workspace.review.files);
    workspace.review.updated_at = now();
    let mut review_value = serde_json::to_value(&workspace.review)?;
    if completed {
        review_value["forkRevision"] = revision.into();
    }
    storage.write_batch(vec![
        ("snapshot", &next.id, None, serde_json::to_value(&next)?),
        (
            "review",
            &workspace.review.id,
            if completed { None } else { Some(revision) },
            review_value,
        ),
    ])?;
    workspace.snapshot = next;
    // Commands quiesce the native preparation before entering this mutation;
    // its old checkpoint must not resurrect the discarded generated content.
    if !completed {
        storage.remove(
            "review_preparation",
            &format!("{}:{id}", workspace.review.repository_id),
        )?;
    }
    storage.collect_review_garbage(&workspace.review.repository_id)?;
    Ok(workspace)
}

#[cfg(test)]
mod tests;

/// Persist human completion before starting publication. Replays never add another decision.
pub(crate) fn save_finalization_decision(
    storage: &Storage,
    id: &str,
    revision: u32,
    action: ReviewAction,
) -> AppResult<Workspace> {
    let current = load(storage, id)?;
    storage.check_update_write(&current.review.repository_id, id)?;
    if current.review.publication.is_complete() {
        return Ok(current);
    }
    let workspace = prepare_action(storage, current, revision, action)?;
    if !workspace.review.publication.is_complete() {
        return Err(AppError::new(
            "review_incomplete",
            "Finish validating this review before finalizing it.",
        ));
    }
    storage.replace("review", id, revision, &workspace.review)?;
    Ok(workspace)
}
