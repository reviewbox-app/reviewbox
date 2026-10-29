//! Incremental preparation installs a private candidate without mutating the source review.
use super::*;
use crate::reader;

pub(super) fn change_key(change: &Change) -> Value {
    json!({"path":change.path,"previousPath":change.previous_path,"layer":change.layer,
        "before":change.before,"after":change.after,"binary":change.binary,"untracked":change.untracked})
}
pub(super) fn capture_key(snapshot: &Snapshot) -> AppResult<String> {
    let mut changes: Vec<_> = snapshot.changes.iter().map(change_key).collect();
    changes.sort_by_key(Value::to_string);
    let mut files = snapshot.files.clone();
    files.sort_by(|a, b| a.path.cmp(&b.path));
    let selected_commits = matches!(snapshot.request.scope, Scope::Commit | Scope::Range)
        .then(|| snapshot.git_refs.iter().skip(1).collect::<Vec<_>>());
    Ok(fingerprint(&serde_json::to_vec(
        &json!({"request":snapshot.request,"selectedCommits":selected_commits,"changes":changes,"files":files}),
    )?))
}
fn mapped_change<'a>(old: &Change, snapshot: &'a Snapshot) -> Option<&'a Change> {
    let key = change_key(old);
    let mut candidates = snapshot.changes.iter().filter(|c| change_key(c) == key);
    let candidate = candidates.next()?;
    candidates.next().is_none().then_some(candidate)
}
pub(super) fn source_map(old: &Snapshot, new: &Snapshot) -> BTreeMap<String, String> {
    let mut result = BTreeMap::new();
    for change in &old.changes {
        if let Some(next) = mapped_change(change, new) {
            for side in ["before", "after"] {
                result.insert(
                    format!("change:{}:{side}", change.id),
                    format!("change:{}:{side}", next.id),
                );
            }
        }
    }
    for file in &old.files {
        if new.files.iter().any(|f| {
            f.path == file.path
                && serde_json::to_value(&f.content).ok() == serde_json::to_value(&file.content).ok()
        }) {
            result.insert(format!("file:{}", file.path), format!("file:{}", file.path));
        }
    }
    result
}
/// Only meanings that can be displayed by this document influence its decision.
/// Include automatic term linking and illustration aliases, not just explicit links.
fn used_glossary(docs: &LevelDocuments, glossary: &[DocumentTerm]) -> Vec<Value> {
    let bodies = docs
        .documents()
        .into_iter()
        .map(|d| d.body.to_lowercase())
        .collect::<Vec<_>>()
        .join("\n");
    let mut used: Vec<_> = glossary
        .iter()
        .filter(|term| {
            bodies.contains(&term.term.to_lowercase())
                || bodies.contains(&term.id.to_lowercase())
                || docs.documents().iter().any(|doc| {
                    doc.term_aliases
                        .iter()
                        .any(|(alias, id)| id == &term.id && bodies.contains(&alias.to_lowercase()))
                })
        })
        .map(|term| json!([term.id, term.term, term.context, term.definition]))
        .collect();
    used.sort_by_key(Value::to_string);
    used
}
fn decision_documents_unchanged(old: &Workspace, new: &Workspace, step_id: &str) -> bool {
    let Some(previous) = old
        .review
        .topics
        .iter()
        .flat_map(|t| &t.steps)
        .find(|s| s.id == step_id)
    else {
        return false;
    };
    let Some(next) = new
        .review
        .topics
        .iter()
        .flat_map(|t| &t.steps)
        .find(|s| s.id == step_id)
    else {
        return false;
    };
    if used_glossary(&previous.documents, &old.review.glossary)
        != used_glossary(&next.documents, &new.review.glossary)
    {
        return false;
    }
    let mapping = source_map(&old.snapshot, &new.snapshot);
    for (before, after) in [(
        previous.documents.get(ReadingLevel::Essential),
        next.documents.get(ReadingLevel::Essential),
    )] {
        if before.body != after.body {
            return false;
        }
        let mut refs = before.references.clone();
        for reference in &mut refs {
            let Some(id) = mapping.get(&reference.source_id) else {
                return false;
            };
            reference.source_id = id.clone();
        }
        if serde_json::to_value(refs).ok() != serde_json::to_value(&after.references).ok() {
            return false;
        }
    }
    true
}

pub(super) fn committed(storage: &Storage, state: &PreparationState) -> AppResult<bool> {
    let Some(update) = &state.adaptation else {
        return Ok(false);
    };
    match storage.get::<Review>("review", &update.destination_review_id) {
        Ok(review) => {
            Ok(review.update_origin.is_none()
                && review.preparation_id.as_deref() == Some(&state.id))
        }
        Err(error) if error.code == "not_found" => Ok(false),
        Err(error) => Err(error),
    }
}

/// The private candidate is also a durable operation marker. Recover the tiny
/// checkpoint if the app closed between the project transaction and SQLite.
/// The caller holds the manager's active lock through recovery and registration.
pub(super) fn recover_checkpoint(
    storage: &Storage,
    review: &Review,
) -> AppResult<Option<Checkpoint>> {
    let Some(candidate) = storage.pending_review_update(&review.repository_id, &review.id)? else {
        return Ok(None);
    };
    let update = candidate.update_origin.ok_or_else(state_error)?;
    let previous =
        optional_checkpoint(storage, &format!("{}:{}", review.repository_id, review.id))?;
    if let Some(old) = &previous
        && old
            .state
            .adaptation
            .as_ref()
            .is_some_and(|u| u.operation_id == update.operation_id)
    {
        return Ok(previous);
    }
    let checkpoint = Checkpoint {
        working_context: None,
        revision: previous.as_ref().map_or(0, |old| old.revision + 1),
        review_revision: update.source_revision,
        repository_id: review.repository_id.clone(),
        state: PreparationState {
            id: update.operation_id.clone(),
            review_id: review.id.clone(),
            snapshot_id: candidate.snapshot_id,
            provider: update.provider.clone(),
            adaptation: Some(update),
            status: PreparationStatus::Interrupted,
            phase: PreparationPhase::Context,
            completed_batches: 0,
            total_batches: 1,
            steps: vec![],
            events: vec![],
            error: None,
            started_at: candidate.created_at,
            updated_at: now(),
            can_resume: true,
            active_batches: vec![],
            phases: vec![],
        },
        source_hash: String::new(),
        prompt_hash: String::new(),
        provider_hash: String::new(),
        helper_model: None,
        definitions: BTreeMap::new(),
        results: BTreeMap::new(),
        measurements: vec![],
    };
    if let Some(old) = previous {
        storage.replace(KIND, &checkpoint.key(), old.revision, &checkpoint)?;
    } else {
        storage.insert(KIND, &checkpoint.key(), &checkpoint)?;
    }
    Ok(Some(checkpoint))
}
pub(super) fn mapped_anchors(
    old: &Snapshot,
    new: &Snapshot,
    anchors: &[CodeAnchor],
) -> Option<Vec<CodeAnchor>> {
    anchors
        .iter()
        .map(|anchor| {
            let before = old.changes.iter().find(|c| c.id == anchor.change_id)?;
            let passage = before.passages.iter().find(|p| p.id == anchor.passage_id)?;
            let after = mapped_change(before, new)?;
            let mut matches = after.passages.iter().filter(|p| {
                p.fingerprint == passage.fingerprint
                    && p.old_start == passage.old_start
                    && p.new_start == passage.new_start
                    && p.old_lines == passage.old_lines
                    && p.new_lines == passage.new_lines
            });
            let next = matches.next()?;
            if matches.next().is_some() {
                return None;
            }
            Some(CodeAnchor {
                snapshot_id: new.id.clone(),
                change_id: after.id.clone(),
                passage_id: next.id.clone(),
            })
        })
        .collect()
}
pub(super) fn attach_dependencies(
    docs: &mut LevelDocuments,
    anchors: &[CodeAnchor],
    context_source_ids: &[String],
    snapshot: &Snapshot,
    signature: &str,
) -> AppResult<()> {
    let mut ids: BTreeMap<String, ()> = docs
        .context_sources
        .iter()
        .chain(context_source_ids)
        .chain(
            docs.dependencies
                .iter()
                .flat_map(|d| d.sources.iter().map(|s| &s.source_id)),
        )
        .cloned()
        .map(|id| (id, ()))
        .collect();
    for doc in docs.documents() {
        for reference in &doc.references {
            ids.insert(reference.source_id.clone(), ());
        }
    }
    let sources = reader::sources(snapshot);
    for source in &sources {
        if anchors.iter().any(|a| {
            source
                .source_id
                .starts_with(&format!("change:{}:", a.change_id))
        }) {
            ids.insert(source.source_id.clone(), ());
        }
    }
    let dependencies = ids
        .keys()
        .map(|id| {
            sources
                .iter()
                .find(|s| &s.source_id == id)
                .cloned()
                .ok_or_else(|| {
                    invalid("A declared document dependency is absent from the capture.")
                })
        })
        .collect::<AppResult<Vec<_>>>()?;
    docs.dependencies = Some(DocumentDependencies {
        signature: signature.into(),
        sources: dependencies,
    });
    Ok(())
}
impl PreparationManager {
    pub(crate) fn adapt(
        &self,
        storage: Storage,
        resources: PathBuf,
        review_id: &str,
        revision: u32,
        provider: String,
    ) -> AppResult<Option<PreparationState>> {
        let previous = self.get(&storage, review_id, None)?;
        if let Some(state) = &previous {
            if state.status == PreparationStatus::Running {
                return if state.adaptation.is_some() {
                    Ok(Some(state.clone()))
                } else {
                    Err(AppError::new(
                        "review_busy",
                        "Wait for the current preparation or cancel it explicitly.",
                    ))
                };
            }
            if state.adaptation.is_some() && state.status != PreparationStatus::Ready {
                return Err(AppError::new(
                    "update_pending",
                    "Resume or discard the previous update before capturing again.",
                ));
            }
        }
        let source = reviews::load(&storage, review_id)?;
        let candidate_id = id();
        let (storage, lease) =
            storage.own_update(&source.review.repository_id, review_id, &candidate_id)?;
        let source = reviews::load(&storage, review_id)?;
        if source.review.revision != revision {
            return Err(AppError::new(
                "conflict",
                "Reload before updating this review.",
            ));
        }
        let _sources = storage.pin_source_cache();
        let next = crate::snapshots::prepare_capture(
            &storage,
            source.snapshot.request.clone(),
            &mut |_, _, _, _| Ok(()),
        )?;
        let profile = writing::effective(&storage, &source.review.repository_id)?;
        let profile_changed = source
            .review
            .topics
            .iter()
            .flat_map(|t| &t.steps)
            .any(|step| {
                step.documents
                    .single
                    .as_ref()
                    .map(|d| &d.profile)
                    .unwrap_or(&ReviewWritingProfile::default())
                    != &profile
            });
        if !profile_changed && capture_key(&source.snapshot)? == capture_key(&next)? {
            return Ok(None);
        }
        if !profile_changed
            && let Some(previous) = previous
            && let Some(update) = &previous.adaptation
            && update.snapshot_id == source.snapshot.id
            && update.source_revision == source.review.revision
            && let Ok(completed) = reviews::load(&storage, &update.destination_review_id)
            && completed.review.preparation_id.as_deref() == Some(previous.id.as_str())
            && capture_key(&completed.snapshot)? == capture_key(&next)?
        {
            return Ok(Some(previous));
        }
        let update = ReviewAdaptation {
            operation_id: id(),
            provider: provider.clone(),
            source_review_id: review_id.into(),
            source_revision: revision,
            snapshot_id: source.snapshot.id.clone(),
            candidate_review_id: candidate_id.clone(),
            destination_review_id: if source.review.publication.is_complete() {
                candidate_id.clone()
            } else {
                review_id.into()
            },
            retained_steps: 0,
            rewritten_steps: 0,
            added_steps: 0,
            removed_steps: 0,
        };
        let mut candidate = source.review.clone();
        candidate.id = candidate_id.clone();
        candidate.revision = 0;
        candidate.created_at = now();
        candidate.snapshot_id = next.id.clone();
        candidate.publication = ReviewPublication {
            keep_local: source.review.publication.keep_local,
            ..Default::default()
        };
        candidate.topics.clear();
        candidate.glossary.clear();
        candidate.decisions.clear();
        candidate.examined.clear();
        candidate.files = reader::files(&next);
        candidate.preparation_id = None;
        candidate.mode = ReviewMode::Manual;
        candidate.update_origin = Some(update.clone());
        candidate.needs_update_confirmation = false;
        candidate.previous_snapshot_ids.clear();
        candidate.position = Default::default();
        storage.write_batch(vec![
            ("snapshot", &next.id, None, serde_json::to_value(&next)?),
            (
                "review",
                &candidate_id,
                None,
                serde_json::to_value(&candidate)?,
            ),
        ])?;
        let result = self.start_run(
            storage.clone(),
            resources,
            PreparationRequest {
                review_id: review_id.into(),
                provider,
            },
            Some(update),
            Some(lease),
        );
        if result.is_err() {
            storage.remove("review", &candidate_id)?;
            storage.collect_review_garbage(&source.review.repository_id)?;
        }
        result.map(Some)
    }
    pub(crate) fn discard_update(&self, storage: &Storage, review_id: &str) -> AppResult<()> {
        let review: Review = storage.get("review", review_id)?;
        let key = format!("{}:{review_id}", review.repository_id);
        if self
            .active
            .lock()
            .map_err(|_| state_error())?
            .get(&key)
            .is_some_and(|a| {
                a.state.status == PreparationStatus::Running || !a.finished.load(Ordering::Acquire)
            })
        {
            return Err(AppError::new(
                "review_busy",
                "Cancel the update and wait for it to stop before discarding it.",
            ));
        }
        let _ = self.get(storage, review_id, None)?;
        let Some(checkpoint) = optional_checkpoint(storage, &key)? else {
            return Ok(());
        };
        if let Some(update) = checkpoint.state.adaptation {
            if checkpoint.state.status != PreparationStatus::Ready {
                let (owned, _lease) = storage.own_update(
                    &review.repository_id,
                    review_id,
                    &update.candidate_review_id,
                )?;
                match owned.remove("review", &update.candidate_review_id) {
                    Ok(()) => (),
                    Err(e) if e.code == "not_found" => (),
                    Err(e) => return Err(e),
                }
                owned.collect_review_garbage(&review.repository_id)?;
            }
            storage.remove(KIND, &key)?;
            self.active.lock().map_err(|_| state_error())?.remove(&key);
        }
        Ok(())
    }
}

pub(super) fn finish(
    storage: &Storage,
    state: &PreparationState,
    reused: &HashSet<String>,
) -> AppResult<Workspace> {
    let _commit = storage.read_consistently();
    let update = state.adaptation.as_ref().ok_or_else(state_error)?;
    let source = reviews::load(storage, &update.source_review_id)?;
    // Covers interruption after the writer commit but before the checkpoint save.
    if let Ok(done) = reviews::load(storage, &update.destination_review_id)
        && done.review.preparation_id.as_deref() == Some(&state.id)
        && done.review.update_origin.is_none()
    {
        crate::working_context::transfer(
            storage,
            &done.review.repository_id,
            &state.review_id,
            &update.destination_review_id,
            &done.snapshot.id,
        )?;
        return Ok(done);
    }
    if source.review.revision != update.source_revision || source.snapshot.id != update.snapshot_id
    {
        return Err(AppError::new(
            "conflict",
            "The original review changed. Discard this update and capture again.",
        ));
    }
    let mut next = reviews::load(storage, &update.candidate_review_id)?;
    crate::working_context::transfer(
        storage,
        &next.review.repository_id,
        &state.review_id,
        &update.destination_review_id,
        &next.snapshot.id,
    )?;
    next.review.id = update.destination_review_id.clone();
    next.review.revision = if next.review.id == source.review.id {
        source.review.revision + 1
    } else {
        next.review.revision + 1
    };
    next.review.update_origin = None;
    next.review.created_at = if next.review.id == source.review.id {
        source.review.created_at.clone()
    } else {
        now()
    };
    next.review.publication.origin_review_id = if next.review.id == source.review.id {
        source.review.publication.origin_review_id.clone()
    } else {
        Some(source.review.id.clone())
    };
    next.review.publication.keep_local = source.review.publication.keep_local;
    let mapping = source_map(&source.snapshot, &next.snapshot);
    for decision in &source.review.decisions {
        if decision.author.starts_with("agent:") {
            continue;
        }
        let target = match &decision.target {
            DecisionTarget::Step { step_id } => {
                let old = source
                    .review
                    .topics
                    .iter()
                    .flat_map(|t| &t.steps)
                    .find(|s| &s.id == step_id);
                if !reused.contains(step_id)
                    || old.is_none_or(|s| s.documents.dependencies.is_none())
                    || !decision_documents_unchanged(&source, &next, step_id)
                {
                    continue;
                }
                decision.target.clone()
            }
            DecisionTarget::File { file_id } => {
                let Some(old) = source.review.files.iter().find(|f| &f.id == file_id) else {
                    continue;
                };
                let Some(new) = next.review.files.iter().find(|f| f.path == old.path) else {
                    continue;
                };
                if old.change_ids.len() != new.change_ids.len()
                    || old
                        .change_ids
                        .iter()
                        .any(|id| !mapping.contains_key(&format!("change:{id}:before")))
                {
                    continue;
                }
                DecisionTarget::File {
                    file_id: new.id.clone(),
                }
            }
        };
        if reviews::target_fingerprint(&source.snapshot, &source.review, &decision.target)?
            != decision.fingerprint
        {
            continue;
        }
        let mut transferred = decision.clone();
        transferred.id = id();
        transferred.target = target;
        transferred.fingerprint =
            reviews::target_fingerprint(&next.snapshot, &next.review, &transferred.target)?;
        transferred.carried_from = Some(DecisionOrigin {
            review_id: source.review.id.clone(),
            snapshot_id: source.snapshot.id.clone(),
            decision_id: decision.id.clone(),
        });
        next.review.decisions.push(transferred);
    }
    next.review.needs_update_confirmation =
        next.review.mode == ReviewMode::Guided && reviews::coverage(&next).complete;
    let steps: Vec<_> = next.review.topics.iter().flat_map(|t| &t.steps).collect();
    let previous = source.review.position.step_id.as_deref();
    let selected = steps
        .iter()
        .find(|s| Some(s.id.as_str()) == previous)
        .copied()
        .or_else(|| {
            let old: Vec<_> = source.review.topics.iter().flat_map(|t| &t.steps).collect();
            let index = old.iter().position(|s| Some(s.id.as_str()) == previous)?;
            old[index + 1..]
                .iter()
                .chain(old[..index].iter().rev())
                .filter(|s| reused.contains(&s.id))
                .find_map(|s| steps.iter().find(|n| n.id == s.id).copied())
        })
        .or_else(|| steps.first().copied());
    next.review.position = if let Some(step) = selected {
        let anchor = step.anchors.first();
        ReadingPosition {
            context: ReadingContext::Guided,
            step_id: Some(step.id.clone()),
            change_id: anchor.map(|a| a.change_id.clone()),
            passage_id: anchor.map(|a| a.passage_id.clone()),
            scroll_top: if Some(step.id.as_str()) == previous
                && reused.contains(&step.id)
                && decision_documents_unchanged(&source, &next, &step.id)
            {
                source.review.position.scroll_top
            } else {
                0.0
            },
            split: source.review.position.split,
            ..Default::default()
        }
    } else {
        reviews::file_position(&next.snapshot, &next.review.files)
    };
    let position = &source.review.position;
    if position.context == ReadingContext::Guided
        && position.step_id == next.review.position.step_id
        && position.step_id.as_ref().is_some_and(|id| {
            reused.contains(id) && decision_documents_unchanged(&source, &next, id)
        })
        && let Some(old_change) = source
            .snapshot
            .changes
            .iter()
            .find(|c| Some(&c.id) == position.change_id.as_ref())
        && let Some(new_change) = mapped_change(old_change, &next.snapshot)
    {
        next.review.position.change_id = Some(new_change.id.clone());
        next.review.position.line = position.line;
        next.review.position.passage_id = position
            .passage_id
            .as_ref()
            .and_then(|id| {
                mapped_anchors(
                    &source.snapshot,
                    &next.snapshot,
                    &[CodeAnchor {
                        snapshot_id: source.snapshot.id.clone(),
                        change_id: old_change.id.clone(),
                        passage_id: id.clone(),
                    }],
                )
            })
            .and_then(|anchors| anchors.into_iter().next())
            .map(|a| a.passage_id);
    }
    next.review.position.file_id = source
        .review
        .position
        .file_id
        .as_ref()
        .filter(|id| next.review.files.iter().any(|f| &f.id == *id))
        .cloned();
    if source.review.position.context == ReadingContext::Files
        && let Some(file) = source
            .review
            .files
            .iter()
            .find(|f| Some(&f.id) == source.review.position.file_id.as_ref())
        && let Some(next_file) = next.review.files.iter().find(|f| f.path == file.path)
    {
        let step_id = next.review.position.step_id.clone();
        next.review.position =
            reviews::file_position(&next.snapshot, std::slice::from_ref(next_file));
        next.review.position.step_id = step_id;
        next.review.position.split = source.review.position.split;
        if file.change_ids.len() == next_file.change_ids.len()
            && file
                .change_ids
                .iter()
                .all(|id| mapping.contains_key(&format!("change:{id}:before")))
        {
            next.review.position.scroll_top = source.review.position.scroll_top;
            next.review.position.line = source.review.position.line;
        }
    }
    let contents = next
        .review
        .files
        .iter()
        .map(|f| reader::read_file(storage, &update.candidate_review_id, &f.id))
        .collect::<AppResult<Vec<_>>>()?;
    let mut value = serde_json::to_value(&next.review)?;
    value["generatedFiles"] = serde_json::to_value(contents)?;
    value["adaptationCommit"] = serde_json::to_value(update)?;
    let expected = if next.review.id == source.review.id {
        source.review.revision
    } else {
        next.review.revision - 1
    };
    storage.write_batch(vec![("review", &next.review.id, Some(expected), value)])?;
    // Committed state is authoritative even if subsequent garbage collection fails.
    let _ = storage.collect_review_garbage(&next.review.repository_id);
    reviews::load(storage, &next.review.id)
}
