//! Native, checkpointed ownership of review preparation. UI polling is optional.
mod adaptation;
#[cfg(all(test, unix))]
mod adaptation_tests;
mod batches;
mod parallel;
#[cfg(test)]
mod tests;

use crate::{agents, contracts::*, knowledge, reader, reviews, storage::Storage};
use batches::*;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, HashMap, HashSet},
    path::{Path, PathBuf},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
};

const KIND: &str = "review_preparation";
const MAX_EVENTS: usize = 200;
const MAX_COORDINATORS: usize = 8;

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Checkpoint {
    revision: u32,
    review_revision: u32,
    repository_id: String,
    state: PreparationState,
    source_hash: String,
    prompt_hash: String,
    provider_hash: String,
    #[serde(default)]
    helper_model: Option<String>,
    results: BTreeMap<String, Value>,
    #[serde(default)]
    definitions: BTreeMap<String, parallel::Definition>,
    #[serde(default)]
    measurements: Vec<Value>,
}
impl Checkpoint {
    fn key(&self) -> String {
        format!("{}:{}", self.repository_id, self.state.review_id)
    }
}
struct Active {
    state: PreparationState,
    cancel: Arc<AtomicBool>,
    sequence: u32,
    measurements: Vec<Value>,
    finished: Arc<AtomicBool>,
}

/// Blocks a new provider task while refresh/delete commits its storage change.
/// Dropping it after an error makes the preserved capture resumable again.
pub(crate) struct PreparationPauseGuard {
    paused: Arc<Mutex<HashSet<String>>>,
    key: String,
}
impl Drop for PreparationPauseGuard {
    fn drop(&mut self) {
        if let Ok(mut paused) = self.paused.lock() {
            paused.remove(&self.key);
        }
    }
}
struct PreparationFinished(Arc<AtomicBool>);
impl Drop for PreparationFinished {
    fn drop(&mut self) {
        self.0.store(true, Ordering::Release);
    }
}
#[derive(Clone)]
pub(crate) struct PreparationManager {
    active: Arc<Mutex<HashMap<String, Active>>>,
    paused: Arc<Mutex<HashSet<String>>>,
    stopping: Arc<AtomicBool>,
    slots: Arc<tokio::sync::Semaphore>,
    throttled: Arc<AtomicBool>,
    retry_slot: Arc<tokio::sync::Semaphore>,
}
impl Default for PreparationManager {
    fn default() -> Self {
        Self {
            active: Default::default(),
            paused: Default::default(),
            stopping: Default::default(),
            slots: Arc::new(tokio::sync::Semaphore::new(MAX_COORDINATORS)),
            throttled: Default::default(),
            retry_slot: Arc::new(tokio::sync::Semaphore::new(1)),
        }
    }
}
impl PreparationManager {
    pub(crate) fn start(
        &self,
        storage: Storage,
        resources: PathBuf,
        request: PreparationRequest,
    ) -> AppResult<PreparationState> {
        self.start_run(storage, resources, request, None, None)
    }
    fn start_run(
        &self,
        storage: Storage,
        resources: PathBuf,
        request: PreparationRequest,
        adaptation: Option<ReviewAdaptation>,
        lease: Option<crate::storage::UpdateLease>,
    ) -> AppResult<PreparationState> {
        if self.stopping.load(Ordering::Relaxed) {
            return Err(AppError::new(
                "shutting_down",
                "The application is closing.",
            ));
        }
        if !["codex", "claude"].contains(&request.provider.as_str()) {
            return Err(AppError::new("provider", "Unknown preparation provider."));
        }
        let review: Review = storage.get("review", &request.review_id)?;
        storage.check_update_write(&review.repository_id, &review.id)?;
        if adaptation.is_none() {
            if storage
                .pending_review_update(&review.repository_id, &review.id)?
                .is_some()
            {
                return Err(AppError::new(
                    "update_pending",
                    "Resume or discard this review's update first.",
                ));
            }
            reviews::require_draft(&review)?;
        }
        let key = format!("{}:{}", review.repository_id, request.review_id);
        let paused = self.paused.lock().map_err(|_| state_error())?;
        if paused.contains(&key) {
            return Err(AppError::new(
                "review_busy",
                "Wait for this review's refresh to finish.",
            ));
        }
        let mut active = self.active.lock().map_err(|_| state_error())?;
        if let Some(operation) = active.get(&key)
            && operation.state.status == PreparationStatus::Running
        {
            if operation.state.adaptation.is_some()
                || adaptation.is_some()
                || operation.state.snapshot_id != review.snapshot_id
            {
                return Err(AppError::new(
                    "preparation_changed",
                    "The previous capture is still being prepared. Cancel it before starting the new capture.",
                ));
            }
            return Ok(operation.state.clone());
        }
        if active
            .values()
            .filter(|operation| operation.state.status == PreparationStatus::Running)
            .count()
            >= 2
        {
            return Err(AppError::new(
                "agent_busy",
                "Wait for an active preparation to finish.",
            ));
        }
        if !active
            .values()
            .any(|operation| operation.state.status == PreparationStatus::Running)
        {
            self.throttled.store(false, Ordering::Relaxed);
        }
        active.retain(|_, operation| operation.state.status == PreparationStatus::Running);
        let previous = optional_checkpoint(&storage, &key)?;
        let state = PreparationState {
            adaptation: adaptation.clone(),
            active_batches: vec![],
            phases: vec![],
            id: adaptation
                .as_ref()
                .map_or_else(id, |update| update.operation_id.clone()),
            review_id: request.review_id.clone(),
            snapshot_id: if let Some(update) = &adaptation {
                storage
                    .get::<Review>("review", &update.candidate_review_id)?
                    .snapshot_id
            } else {
                review.snapshot_id
            },
            provider: request.provider,
            status: PreparationStatus::Running,
            phase: PreparationPhase::Context,
            completed_batches: 0,
            total_batches: 1,
            steps: vec![],
            events: vec![],
            error: None,
            started_at: now(),
            updated_at: now(),
            can_resume: false,
        };
        let checkpoint = Checkpoint {
            revision: previous.as_ref().map_or(0, |old| old.revision + 1),
            review_revision: review.revision,
            repository_id: review.repository_id,
            state: state.clone(),
            source_hash: String::new(),
            prompt_hash: String::new(),
            provider_hash: String::new(),
            helper_model: None,
            definitions: BTreeMap::new(),
            results: BTreeMap::new(),
            measurements: vec![],
        };
        match previous {
            Some(old) => storage.replace(KIND, &key, old.revision, &checkpoint)?,
            None => storage.insert(KIND, &key, &checkpoint)?,
        }
        let cancel = Arc::new(AtomicBool::new(false));
        let finished = Arc::new(AtomicBool::new(false));
        active.insert(
            key,
            Active {
                state: state.clone(),
                cancel: cancel.clone(),
                sequence: 0,
                measurements: vec![],
                finished: finished.clone(),
            },
        );
        drop(active);
        drop(paused);
        self.launch(storage, resources, checkpoint, cancel, finished, lease);
        Ok(state)
    }
    pub(crate) fn get(
        &self,
        storage: &Storage,
        review_id: &str,
        after_sequence: Option<u32>,
    ) -> AppResult<Option<PreparationState>> {
        let review: Review = storage.get("review", review_id)?;
        let key = format!("{}:{}", review.repository_id, review_id);
        // Recovery can write a missing checkpoint. Keep it under the same lock
        // as start/resume, so concurrent polls cannot create it twice or replace
        // the checkpoint of an operation that has just started.
        let active = self.active.lock().map_err(|_| state_error())?;
        let state = active.get(&key).map(|active| active.state.clone());
        let live = state.is_some();
        let mut state = match state {
            Some(state) => state,
            None => match adaptation::recover_checkpoint(storage, &review)?
                .or(optional_checkpoint(storage, &key)?)
            {
                Some(checkpoint) => checkpoint.state,
                None => return Ok(None),
            },
        };
        drop(active);
        if state.adaptation.is_none()
            && (state.snapshot_id != review.snapshot_id || review.publication.is_complete())
        {
            return Ok(None);
        }
        if (!live || state.status != PreparationStatus::Running)
            && adaptation::committed(storage, &state)?
        {
            state.status = PreparationStatus::Ready;
            state.can_resume = false;
            state.error = None;
        }
        // An operation read from disk is never automatically relaunched.
        if state.status == PreparationStatus::Running && !live {
            state.status = PreparationStatus::Interrupted;
            state.can_resume = true;
        }
        if let Some(after) = after_sequence {
            state.events.retain(|event| event.sequence > after);
        }
        if state.status == PreparationStatus::Interrupted {
            state.can_resume = true;
        }
        if state.status != PreparationStatus::Running
            && state.status != PreparationStatus::Ready
            && state.adaptation.as_ref().is_some_and(|u| {
                u.source_revision != review.revision || u.snapshot_id != review.snapshot_id
            })
        {
            state.can_resume = false;
            state.error = Some(AppError::new(
                "preparation_changed",
                "The original review changed. Discard this update before capturing again.",
            ));
        }
        Ok(Some(state))
    }
    pub(crate) fn resume(
        &self,
        storage: Storage,
        resources: PathBuf,
        review_id: &str,
    ) -> AppResult<PreparationState> {
        if self.stopping.load(Ordering::Relaxed) {
            return Err(AppError::new(
                "shutting_down",
                "The application is closing.",
            ));
        }
        let review: Review = storage.get("review", review_id)?;

        let key = format!("{}:{}", review.repository_id, review_id);
        let paused = self.paused.lock().map_err(|_| state_error())?;
        if paused.contains(&key) {
            return Err(AppError::new(
                "review_busy",
                "Wait for this review's refresh to finish.",
            ));
        }
        let mut active = self.active.lock().map_err(|_| state_error())?;
        if let Some(operation) = active.get(&key)
            && operation.state.status == PreparationStatus::Running
        {
            return Ok(operation.state.clone());
        }
        if active
            .values()
            .filter(|operation| operation.state.status == PreparationStatus::Running)
            .count()
            >= 2
        {
            return Err(AppError::new(
                "agent_busy",
                "Wait for an active preparation to finish.",
            ));
        }
        let mut checkpoint = adaptation::recover_checkpoint(&storage, &review)?
            .or(optional_checkpoint(&storage, &key)?)
            .ok_or_else(|| AppError::new("not_found", "No preparation is available to resume."))?;

        if adaptation::committed(&storage, &checkpoint.state)? {
            checkpoint.state.status = PreparationStatus::Ready;
            checkpoint.state.can_resume = false;
            checkpoint.state.error = None;
            save(&storage, &mut checkpoint)?;
            return Ok(checkpoint.state);
        }
        if checkpoint.state.adaptation.as_ref().map_or(
            review.snapshot_id != checkpoint.state.snapshot_id,
            |update| {
                update.snapshot_id != review.snapshot_id
                    || update.source_revision != review.revision
            },
        ) {
            return Err(AppError::new(
                "preparation_changed",
                "The capture changed. Start a new preparation.",
            ));
        }
        if checkpoint.state.status == PreparationStatus::Ready {
            return Ok(checkpoint.state);
        }
        if review.revision != checkpoint.review_revision
            && review.preparation_id.as_deref() != Some(checkpoint.state.id.as_str())
        {
            return Err(AppError::new(
                "conflict",
                "The review changed during preparation. Start a new preparation to keep those changes safe.",
            ));
        }
        let (storage, lease) = if let Some(update) = &checkpoint.state.adaptation {
            let (storage, lease) = storage.own_update(
                &review.repository_id,
                review_id,
                &update.candidate_review_id,
            )?;
            let candidate: Review = storage.get("review", &update.candidate_review_id)?;
            if candidate.snapshot_id != checkpoint.state.snapshot_id {
                return Err(state_error());
            }
            (storage, Some(lease))
        } else {
            reviews::require_draft(&review)?;
            (storage, None)
        };
        checkpoint.state.active_batches.clear();
        checkpoint.state.status = PreparationStatus::Running;
        checkpoint.state.error = None;
        checkpoint.state.can_resume = false;
        checkpoint.state.updated_at = now();
        save(&storage, &mut checkpoint)?;
        let state = checkpoint.state.clone();
        let sequence = state.events.last().map_or(0, |event| event.sequence);
        let cancel = Arc::new(AtomicBool::new(false));
        let finished = Arc::new(AtomicBool::new(false));
        active.insert(
            key,
            Active {
                state: state.clone(),
                cancel: cancel.clone(),
                sequence,
                measurements: checkpoint.measurements.clone(),
                finished: finished.clone(),
            },
        );
        drop(active);
        drop(paused);
        self.launch(storage, resources, checkpoint, cancel, finished, lease);
        Ok(state)
    }
    pub(crate) async fn quiesce(
        &self,
        storage: &Storage,
        review_id: &str,
    ) -> AppResult<PreparationPauseGuard> {
        let review: Review = storage.get("review", review_id)?;
        let key = format!("{}:{}", review.repository_id, review_id);
        storage.check_update_write(&review.repository_id, review_id)?;
        let (guard, pending) = {
            let mut paused = self.paused.lock().map_err(|_| state_error())?;
            if !paused.insert(key.clone()) {
                return Err(AppError::new(
                    "review_busy",
                    "Another refresh or deletion is already running.",
                ));
            }
            let guard = PreparationPauseGuard {
                paused: self.paused.clone(),
                key: key.clone(),
            };
            let active = self.active.lock().map_err(|_| state_error())?;
            let pending = active.get(&key).map(|operation| {
                operation.cancel.store(true, Ordering::Relaxed);
                operation.finished.clone()
            });
            (guard, pending)
        };
        if let Some(finished) = pending {
            tokio::time::timeout(std::time::Duration::from_secs(30), async {
                while !finished.load(Ordering::Acquire) {
                    tokio::time::sleep(std::time::Duration::from_millis(25)).await;
                }
            }).await.map_err(|_| AppError::new("preparation_stopping", "Preparation is still stopping. The original capture is unchanged; retry shortly."))?;
        }
        self.active.lock().map_err(|_| state_error())?.remove(&key);
        Ok(guard)
    }
    pub(crate) fn cancel(&self, storage: &Storage, review_id: &str) -> AppResult<()> {
        let review: Review = storage.get("review", review_id)?;
        let key = format!("{}:{}", review.repository_id, review_id);
        if let Some(active) = self.active.lock().map_err(|_| state_error())?.get(&key) {
            active.cancel.store(true, Ordering::Relaxed);
        }
        Ok(())
    }
    pub(crate) fn stop_all(&self) {
        self.stopping.store(true, Ordering::Relaxed);
        if let Ok(active) = self.active.lock() {
            for operation in active.values() {
                operation.cancel.store(true, Ordering::Relaxed);
            }
        }
    }
    fn launch(
        &self,
        storage: Storage,
        resources: PathBuf,
        checkpoint: Checkpoint,
        cancel: Arc<AtomicBool>,
        finished: Arc<AtomicBool>,
        lease: Option<crate::storage::UpdateLease>,
    ) {
        let manager = self.clone();
        tauri::async_runtime::spawn(async move {
            let _finished = PreparationFinished(finished);
            let lease = lease;
            let mut run = Run {
                key: checkpoint.key(),
                manager,
                storage,
                resources,
                checkpoint,
                cancel,
                templates: BTreeMap::new(),
                config: None,
                language: String::new(),
            };
            let result = run.execute().await;
            let status = match &result {
                Ok(()) => PreparationStatus::Ready,
                Err(_) if run.manager.stopping.load(Ordering::Relaxed) => {
                    PreparationStatus::Interrupted
                }
                Err(error) if error.code == "cancelled" => PreparationStatus::Cancelled,
                Err(_) => PreparationStatus::Failed,
            };
            let final_state = run.manager.active.lock().ok().and_then(|active| {
                active
                    .get(&run.key)
                    .map(|operation| operation.state.clone())
            });
            if let Some(state) = final_state {
                run.checkpoint.state = state;
            }
            run.checkpoint.state.active_batches.clear();
            for step in &mut run.checkpoint.state.steps {
                if step.status != PreparationStepStatus::Ready {
                    step.status = if status == PreparationStatus::Failed {
                        PreparationStepStatus::Failed
                    } else {
                        PreparationStepStatus::Interrupted
                    };
                }
            }
            run.checkpoint.state.status = status;
            run.checkpoint.state.can_resume = result.as_ref().err().is_some_and(|error| {
                !matches!(
                    error.code.as_str(),
                    "preparation_changed" | "stale_preparation" | "conflict"
                )
            });
            run.checkpoint.state.error = result.err();
            run.checkpoint.state.updated_at = now();
            if run.checkpoint.state.status == PreparationStatus::Ready
                && run.checkpoint.state.adaptation.is_some()
            {
                run.checkpoint.results.clear();
            }
            let saved = run.save_checkpoint().await;
            drop(lease);
            if let Err(error) = saved {
                run.update(|state| {
                    state.status = PreparationStatus::Failed;
                    state.error = Some(error);
                });
            } else {
                run.update(|state| *state = run.checkpoint.state.clone());
            }
        });
    }
    fn event(&self, review_id: &str, mut event: AgentEvent, namespace: &str) {
        if let Ok(mut active) = self.active.lock()
            && let Some(operation) = active.get_mut(review_id)
        {
            if event
                .run_id
                .strip_prefix("preparation:")
                .is_some_and(|id| id != operation.state.id)
                || operation.cancel.load(Ordering::Relaxed)
                || operation.state.status != PreparationStatus::Running
            {
                return;
            }
            operation.sequence = operation.sequence.saturating_add(1);
            event.batch_id = Some(namespace.into());
            event.run_id = operation.state.id.clone();
            event.sequence = operation.sequence;
            if let Some(
                AgentProgress::Activity { id, .. }
                | AgentProgress::Message { id, .. }
                | AgentProgress::Delegation { id, .. }
                | AgentProgress::Usage { id, .. },
            ) = &mut event.progress
            {
                *id = format!("{namespace}:{id}");
            }
            if let Some(AgentProgress::Delegation {
                id, model, task, ..
            }) = &mut event.progress
                && let Some(AgentProgress::Delegation {
                    model: previous_model,
                    task: previous_task,
                    ..
                }) = operation
                    .state
                    .events
                    .iter()
                    .rev()
                    .find_map(|old| match &old.progress {
                        Some(progress @ AgentProgress::Delegation { id: previous, .. })
                            if previous == id =>
                        {
                            Some(progress)
                        }
                        _ => None,
                    })
            {
                if model.is_none() {
                    *model = previous_model.clone();
                }
                if task == "Delegated preparation work" {
                    *task = previous_task.clone();
                }
            }
            // Streaming JSON and token counters must not evict useful comments
            // or agent identities before the next UI poll. Keep their latest
            // scoped value, with the new global sequence still in order.
            operation.state.events.retain(|old| {
                if old.batch_id != event.batch_id { return true; }
                !matches!((&old.progress, &event.progress),
                    (Some(AgentProgress::Draft { .. }), Some(AgentProgress::Draft { .. })) |
                    (Some(AgentProgress::Plan { .. }), Some(AgentProgress::Plan { .. })))
                    && !matches!((&old.progress, &event.progress),
                        (Some(AgentProgress::Usage { id: previous, .. }), Some(AgentProgress::Usage { id, .. })) |
                        (Some(AgentProgress::Delegation { id: previous, .. }), Some(AgentProgress::Delegation { id, .. })) if previous == id)
            });
            operation.state.events.push(event);
            if operation.state.events.len() > MAX_EVENTS {
                let index = operation
                    .state
                    .events
                    .iter()
                    .position(|event| {
                        let active = event.batch_id.as_ref().is_some_and(|id| {
                            operation
                                .state
                                .active_batches
                                .iter()
                                .any(|b| id.starts_with(&format!("{}:", b.id)))
                        });
                        !(active
                            && matches!(
                                event.progress,
                                Some(AgentProgress::Plan { .. } | AgentProgress::Delegation { .. })
                            ))
                    })
                    .unwrap_or(0);
                operation.state.events.remove(index);
            }
            operation.state.updated_at = now();
        }
    }
}
fn state_error() -> AppError {
    AppError::new("state", "Preparation state is unavailable.")
}
fn optional_checkpoint(storage: &Storage, review_id: &str) -> AppResult<Option<Checkpoint>> {
    match storage.get(KIND, review_id) {
        Ok(checkpoint) => Ok(Some(checkpoint)),
        Err(error) if error.code == "not_found" => Ok(None),
        Err(error) => Err(error),
    }
}
fn save(storage: &Storage, checkpoint: &mut Checkpoint) -> AppResult<()> {
    let previous = checkpoint.revision;
    checkpoint.revision += 1;
    storage.replace(KIND, &checkpoint.key(), previous, checkpoint)
}

struct Run {
    key: String,
    manager: PreparationManager,
    storage: Storage,
    resources: PathBuf,
    checkpoint: Checkpoint,
    cancel: Arc<AtomicBool>,
    templates: BTreeMap<String, String>,
    config: Option<ProviderConfig>,
    language: String,
}
impl Run {
    fn update(&self, update: impl FnOnce(&mut PreparationState)) {
        if let Ok(mut active) = self.manager.active.lock()
            && let Some(operation) = active.get_mut(&self.key)
            && operation.state.id == self.checkpoint.state.id
        {
            update(&mut operation.state);
            operation.state.updated_at = now();
        }
    }
    async fn persist(&mut self) -> AppResult<()> {
        if let Some(operation) = self
            .manager
            .active
            .lock()
            .map_err(|_| state_error())?
            .get(&self.key)
        {
            self.checkpoint.state = operation.state.clone();
        }
        self.save_checkpoint().await
    }
    async fn save_checkpoint(&mut self) -> AppResult<()> {
        if let Ok(active) = self.manager.active.lock()
            && let Some(operation) = active.get(&self.key)
            && operation.state.id == self.checkpoint.state.id
        {
            self.checkpoint.measurements = operation.measurements.clone();
        }
        let storage = self.storage.clone();
        let mut checkpoint = self.checkpoint.clone();
        self.checkpoint.revision = tokio::task::spawn_blocking(move || {
            save(&storage, &mut checkpoint)?;
            Ok::<_, AppError>(checkpoint.revision)
        })
        .await
        .map_err(|error| AppError::new("task", error.to_string()))??;
        Ok(())
    }
    fn check_cancel(&self) -> AppResult<()> {
        if self.cancel.load(Ordering::Relaxed) {
            Err(AppError::new(
                "cancelled",
                "Review preparation stopped. Completed batches can be resumed.",
            ))
        } else {
            Ok(())
        }
    }
    fn notice(&self, text: &str) {
        self.manager.event(
            &self.key,
            AgentEvent {
                batch_id: None,
                run_id: String::new(),
                sequence: 0,
                kind: "status".into(),
                text: text.into(),
                progress: None,
            },
            "preparation",
        );
    }
    async fn execute(&mut self) -> AppResult<()> {
        let _cache = self.storage.pin_source_cache();
        let _candidate = self
            .storage
            .pin_snapshot(&self.checkpoint.state.snapshot_id);
        let _baseline = self
            .checkpoint
            .state
            .adaptation
            .as_ref()
            .map(|update| self.storage.pin_snapshot(&update.snapshot_id));
        self.check_cancel()?;
        self.notice("Preparing the frozen source catalogue…");
        let storage = self.storage.clone();
        let resources = self.resources.clone();
        let state = self.checkpoint.state.clone();
        let (workspace, sources, config, language, templates) =
            tokio::task::spawn_blocking(move || {
                let workspace = reviews::load(
                    &storage,
                    state
                        .adaptation
                        .as_ref()
                        .map_or(state.review_id.as_str(), |u| u.candidate_review_id.as_str()),
                )?;
                if workspace.snapshot.id != state.snapshot_id {
                    return Err(AppError::new(
                        "preparation_changed",
                        "The capture changed. Start a new preparation.",
                    ));
                }
                let sources = reader::sources(&workspace.snapshot);
                let config = agents::settings(&storage)?
                    .providers
                    .into_iter()
                    .find(|config| config.provider == state.provider)
                    .ok_or_else(|| {
                        AppError::new("provider", "The preparation provider is not configured.")
                    })?;
                let config = agents::models::for_project(
                    config,
                    storage.project_settings(&workspace.review.repository_id)?,
                );
                let language = knowledge::load(&storage, &workspace.review.repository_id)?.language;
                let templates = templates(&resources)?;
                Ok::<_, AppError>((workspace, sources, config, language, templates))
            })
            .await
            .map_err(|error| AppError::new("task", error.to_string()))??;
        let source_hash = fingerprint(&serde_json::to_vec(&workspace.snapshot)?);
        let prompt_hash = fingerprint(&serde_json::to_vec(&(&templates, &language))?);
        let provider_hash = fingerprint(&serde_json::to_vec(&config)?);
        compatible(&self.checkpoint, &source_hash, &prompt_hash, &provider_hash)?;
        self.checkpoint.source_hash = source_hash;
        self.checkpoint.prompt_hash = prompt_hash;
        self.checkpoint.provider_hash = provider_hash;
        self.templates = templates;
        self.config = Some(config);
        self.language = language;
        self.persist().await?;
        self.execute_parallel(workspace, sources).await
    }
}

fn templates(root: &Path) -> AppResult<BTreeMap<String, String>> {
    let common = std::fs::read_to_string(root.join("preparation/common.md"))?;
    let reading_skill = std::fs::read_to_string(root.join("skills/review/SKILL.md"))?;
    ["outline", "documents", "adaptation"]
        .into_iter()
        .map(|name| {
            Ok((
                name.to_owned(),
                format!(
                    "{common}\n\n{reading_skill}\n\n{}",
                    std::fs::read_to_string(root.join(format!("preparation/{name}.md")))?
                ),
            ))
        })
        .collect()
}
fn compatible(
    checkpoint: &Checkpoint,
    source: &str,
    prompt: &str,
    provider: &str,
) -> AppResult<()> {
    if (!checkpoint.source_hash.is_empty() && checkpoint.source_hash != source)
        || (!checkpoint.prompt_hash.is_empty() && checkpoint.prompt_hash != prompt)
        || (!checkpoint.provider_hash.is_empty() && checkpoint.provider_hash != provider)
    {
        return Err(AppError::new(
            "preparation_changed",
            "The capture, provider configuration, language or preparation instructions changed. Start a new preparation.",
        ));
    }
    Ok(())
}
