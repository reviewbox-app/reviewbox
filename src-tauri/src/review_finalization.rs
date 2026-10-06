//! Durable completion jobs, independent of the reader/webview lifecycle.
use crate::{contracts::*, reviews, storage::Storage};
use std::{
    collections::HashMap,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
};
use tauri::{Emitter, Manager, State};

pub(crate) type Progress<'a> =
    dyn FnMut(&str, FinalizationStepStatus, Option<AppError>) -> AppResult<()> + 'a;
const STEPS: [(&str, &str); 7] = [
    ("save", "Save review completion"),
    ("cleanup", "Clean up working context"),
    ("preserve", "Preserve review files"),
    ("commits", "Find matching commits"),
    ("archive", "Archive previous reviews"),
    ("verify", "Verify review integrity"),
    ("publish", "Save publication"),
];
#[derive(Clone, Default)]
pub(crate) struct Finalizations {
    active: Arc<Mutex<HashMap<String, ReviewFinalization>>>,
    stopping: Arc<AtomicBool>,
}
fn key(repository: &str, review: &str) -> String {
    format!("{repository}:{review}")
}
impl Finalizations {
    pub(crate) fn stop(&self) {
        self.stopping.store(true, Ordering::SeqCst);
    }
    fn read(
        &self,
        storage: &Storage,
        repository: &str,
        review: &str,
    ) -> AppResult<Option<ReviewFinalization>> {
        let key = key(repository, review);
        // Hold the reservation lock through recovery: a concurrent start must not
        // turn a newly persisted running job into a false interruption.
        let active = self.active.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(value) = active.get(&key) {
            return Ok(Some(value.clone()));
        }
        let mut value = match storage.local_get::<ReviewFinalization>("review_finalization", &key) {
            Ok(value) => value,
            Err(e) if e.code == "not_found" => return Ok(None),
            Err(e) => return Err(e),
        };
        if value.status == FinalizationStatus::Running {
            value.status = FinalizationStatus::Interrupted;
            value.sequence += 1;
            for step in &mut value.steps {
                if step.status == FinalizationStepStatus::Running {
                    step.status = FinalizationStepStatus::Failed;
                    step.finished_at = Some(now());
                    step.error = Some(AppError::new("interrupted", "This step was interrupted."));
                }
            }
            value.error = Some(AppError::new(
                "interrupted",
                "Finalization was interrupted. Resume it explicitly.",
            ));
            storage.save_finalization(&value)?;
        }
        Ok(Some(value))
    }
    fn publish(
        &self,
        storage: &Storage,
        value: &ReviewFinalization,
        emit: &dyn Fn(&ReviewFinalization),
    ) -> AppResult<()> {
        storage.save_finalization(value)?;
        self.active
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(key(&value.repository_id, &value.review_id), value.clone());
        emit(value);
        Ok(())
    }
}
fn initial(
    repository_id: String,
    review_id: String,
    action: ReviewAction,
    sequence: u32,
) -> ReviewFinalization {
    ReviewFinalization {
        id: id(),
        repository_id,
        review_id,
        action,
        sequence,
        status: FinalizationStatus::Running,
        error: None,
        steps: STEPS
            .iter()
            .map(|(id, title)| ReviewFinalizationStep {
                id: (*id).into(),
                title: (*title).into(),
                status: FinalizationStepStatus::Queued,
                started_at: None,
                finished_at: None,
                error: None,
            })
            .collect(),
    }
}
fn transition(
    value: &mut ReviewFinalization,
    step: &str,
    status: FinalizationStepStatus,
    error: Option<AppError>,
) {
    if step == "local_cleanup" && !value.steps.iter().any(|s| s.id == step) {
        value.steps.push(ReviewFinalizationStep {
            id: step.into(),
            title: "Clean up local review data".into(),
            status: FinalizationStepStatus::Queued,
            started_at: None,
            finished_at: None,
            error: None,
        });
    }
    let Some(step) = value.steps.iter_mut().find(|s| s.id == step) else {
        return;
    };
    if status == FinalizationStepStatus::Running {
        step.started_at = Some(now());
        step.finished_at = None;
    } else {
        step.finished_at = Some(now());
    }
    step.status = status;
    step.error = error;
    value.sequence += 1;
}
fn run(
    storage: &Storage,
    review_id: &str,
    revision: u32,
    action: ReviewAction,
    progress: &mut Progress<'_>,
    changed: &dyn Fn(),
) -> AppResult<()> {
    progress("save", FinalizationStepStatus::Running, None)?;
    let workspace = reviews::save_finalization_decision(storage, review_id, revision, action)?;
    progress("save", FinalizationStepStatus::Completed, None)?;
    changed();
    progress("cleanup", FinalizationStepStatus::Running, None)?;
    let cleanup = crate::working_context::cleanup(storage, &workspace.review).and_then(|context| {
        let errors: Vec<_> = context
            .files
            .iter()
            .filter(|f| f.cleanup.starts_with("error:"))
            .map(|f| f.cleanup.clone())
            .collect();
        if errors.is_empty() {
            Ok(())
        } else {
            Err(AppError::new("context_cleanup", errors.join("\n")))
        }
    });
    match cleanup {
        Ok(()) => progress("cleanup", FinalizationStepStatus::Completed, None)?,
        Err(error) => progress("cleanup", FinalizationStepStatus::Failed, Some(error))?,
    }
    if workspace.review.publication.status == PublicationStatus::PublicationPending {
        let result = storage.publish_review_progress(review_id, progress)?;
        if result.review.publication.status == PublicationStatus::PublicationPending {
            return Err(AppError::new(
                "publication_failed",
                result
                    .review
                    .publication
                    .publication_error
                    .unwrap_or_else(|| "Publication did not complete.".into()),
            ));
        }
    } else {
        for step in ["preserve", "commits", "archive", "verify", "publish"] {
            progress(step, FinalizationStepStatus::Skipped, None)?;
        }
        if workspace.review.publication.status == PublicationStatus::CompletedLocal {
            progress("local_cleanup", FinalizationStepStatus::Running, None)?;
            storage.collect_review_garbage(&workspace.review.repository_id)?;
            progress("local_cleanup", FinalizationStepStatus::Completed, None)?;
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn get_review_finalization(
    storage: State<'_, Storage>,
    manager: State<'_, Finalizations>,
    repository_id: String,
    review_id: String,
) -> AppResult<Option<ReviewFinalization>> {
    let storage = storage.inner().clone();
    let manager = manager.inner().clone();
    tauri::async_runtime::spawn_blocking(move || manager.read(&storage, &repository_id, &review_id))
        .await
        .map_err(|e| AppError::new("task", e.to_string()))?
}

#[tauri::command]
pub async fn start_review_finalization(
    app: tauri::AppHandle,
    storage: State<'_, Storage>,
    manager: State<'_, Finalizations>,
    repository_id: String,
    review_id: String,
    revision: u32,
    action: ReviewAction,
) -> AppResult<ReviewFinalization> {
    if !matches!(
        action,
        ReviewAction::ValidateStep { .. }
            | ReviewAction::CompleteManualReview
            | ReviewAction::CompleteUpdatedReview
            | ReviewAction::RetryPublication
    ) {
        return Err(AppError::new(
            "invalid_action",
            "This action cannot finalize a review.",
        ));
    }
    let storage = storage.for_finalization(&repository_id);
    let manager = manager.inner().clone();
    let preparation = manager.clone();
    let data = storage.clone();
    let (value, created) = tauri::async_runtime::spawn_blocking(move || -> AppResult<_> {
        let mut active = preparation.active.lock().unwrap_or_else(|e| e.into_inner());
        let key = key(&repository_id, &review_id);
        if let Some(value) = active.get(&key) {
            return Ok((value.clone(), false));
        }
        let old = data.local_get::<ReviewFinalization>("review_finalization", &key);
        let sequence = match old {
            Ok(v) => v.sequence + 1,
            Err(e) if e.code == "not_found" => 0,
            Err(e) => return Err(e),
        };
        let value = initial(repository_id, review_id, action, sequence);
        data.save_finalization(&value)?;
        active.insert(key, value.clone());
        Ok((value, true))
    })
    .await
    .map_err(|e| AppError::new("task", e.to_string()))??;
    if !created {
        return Ok(value);
    }
    let initial = value.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let mut value = value;
        let emit = |state: &ReviewFinalization| {
            let _ = app.emit("reviewbox:review-finalization", state);
        };
        let repository = value.repository_id.clone();
        let review = value.review_id.clone();
        let changed = || {
            let _ = app.emit(
                "reviewbox:review-changed",
                serde_json::json!({"repositoryId":repository,"reviewId":review}),
            );
        };
        let action = value.action.clone();
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            run(
                &storage,
                &review,
                revision,
                action,
                &mut |step, status, error| {
                    if manager.stopping.load(Ordering::SeqCst) {
                        return Err(AppError::new(
                            "interrupted",
                            "Application is closing. Resume finalization after reopening.",
                        ));
                    }
                    transition(&mut value, step, status, error);
                    manager.publish(&storage, &value, &emit)
                },
                &changed,
            )
        }))
        .unwrap_or_else(|_| {
            Err(AppError::new(
                "finalization_panic",
                "Finalization stopped unexpectedly. Retry it.",
            ))
        });
        value.status = match &result {
            Ok(()) => FinalizationStatus::Completed,
            Err(e) if e.code == "interrupted" => FinalizationStatus::Interrupted,
            Err(_) => FinalizationStatus::Failed,
        };
        if let Err(error) = result {
            if let Some(step) = value
                .steps
                .iter_mut()
                .find(|s| s.status == FinalizationStepStatus::Running)
            {
                step.status = FinalizationStepStatus::Failed;
                step.finished_at = Some(now());
                step.error = Some(error.clone());
            }
            value.error = Some(error);
        }
        if let Some(error) = value
            .error
            .as_ref()
            .or_else(|| value.steps.iter().find_map(|s| s.error.as_ref()))
        {
            let _ = app
                .state::<Arc<crate::diagnostics::Diagnostics>>()
                .record(DiagnosticInput {
                    source: "native".into(),
                    operation: "review_finalization".into(),
                    code: error.code.clone(),
                    message: error.message.clone(),
                    details: serde_json::to_string(&value.steps).ok(),
                    stack: None,
                    context: std::collections::BTreeMap::from([
                        ("repositoryId".into(), repository.clone()),
                        ("reviewId".into(), review.clone()),
                        ("operationId".into(), value.id.clone()),
                    ]),
                });
        }
        value.sequence += 1;
        let _ = manager.publish(&storage, &value, &emit);
        manager
            .active
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(&key(&repository, &review));
        changed();
    });
    Ok(initial)
}

#[cfg(test)]
mod tests;
