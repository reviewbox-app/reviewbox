mod preview;
#[cfg(test)]
mod tests;

use crate::{contracts::*, reviews, snapshots, storage::Storage};
pub use preview::{preview, references};
use std::{
    collections::HashMap,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
};

#[derive(Default)]
pub struct CaptureManager {
    active: Mutex<HashMap<String, Arc<CaptureTask>>>,
}

pub struct CaptureTask {
    operation_id: String,
    cancelled: AtomicBool,
    // Cancellation and publication share a linearization point. Once committing,
    // the recoverable batch must finish rather than expose a half-written review.
    committed: Mutex<bool>,
}

impl CaptureManager {
    pub fn begin(&self, operation_id: &str) -> AppResult<Arc<CaptureTask>> {
        if operation_id.is_empty() || operation_id.len() > 128 {
            return Err(AppError::new(
                "invalid_operation",
                "Invalid capture operation ID.",
            ));
        }
        let mut active = self.active.lock().map_err(|_| state_error())?;
        if active.contains_key(operation_id) || !active.is_empty() {
            return Err(AppError::new(
                "capture_busy",
                "Wait for the active capture to finish.",
            ));
        }
        let task = Arc::new(CaptureTask {
            operation_id: operation_id.into(),
            cancelled: AtomicBool::new(false),
            committed: Mutex::new(false),
        });
        active.insert(operation_id.into(), task.clone());
        Ok(task)
    }
    pub fn cancel(&self, operation_id: &str) -> AppResult<()> {
        let task = self
            .active
            .lock()
            .map_err(|_| state_error())?
            .get(operation_id)
            .cloned();
        if let Some(task) = task {
            let committed = task.committed.try_lock().map_err(|error| match error {
                std::sync::TryLockError::WouldBlock => AppError::new(
                    "capture_committing",
                    "The captured review is being saved and can no longer be cancelled.",
                ),
                std::sync::TryLockError::Poisoned(_) => state_error(),
            })?;
            if *committed {
                return Err(AppError::new(
                    "capture_completed",
                    "The review has already been created.",
                ));
            }
            task.cancelled.store(true, Ordering::Relaxed);
        }
        Ok(())
    }
    pub fn finish(&self, operation_id: &str) {
        if let Ok(mut active) = self.active.lock() {
            active.remove(operation_id);
        }
    }
    pub fn cancel_all(&self) {
        if let Ok(active) = self.active.lock() {
            for task in active.values() {
                task.cancelled.store(true, Ordering::Relaxed);
            }
        }
    }
}

fn state_error() -> AppError {
    AppError::new("state", "Capture state unavailable.")
}

impl CaptureTask {
    fn check(&self) -> AppResult<()> {
        if self.cancelled.load(Ordering::Relaxed) {
            Err(AppError::new("cancelled", "Review creation was cancelled."))
        } else {
            Ok(())
        }
    }
}

pub fn create(
    storage: &Storage,
    request: CaptureRequest,
    task: Arc<CaptureTask>,
    mut progress: impl FnMut(CaptureProgress) -> AppResult<()>,
) -> AppResult<Workspace> {
    let _sources = storage.pin_source_cache();
    let mut last_phase = String::new();
    let mut last_update = std::time::Instant::now();
    let mut notify = |phase: &str, completed, total, path: Option<&str>| {
        task.check()?;
        if phase != last_phase
            || total == Some(completed)
            || last_update.elapsed() >= std::time::Duration::from_millis(50)
        {
            progress(CaptureProgress {
                operation_id: task.operation_id.clone(),
                phase: phase.into(),
                completed,
                total,
                path: path.map(String::from),
            })?;
            last_phase = phase.into();
            last_update = std::time::Instant::now();
        }
        task.check()
    };
    let snapshot = snapshots::prepare_capture(storage, request, &mut notify)?;
    if snapshot.changes.is_empty() {
        return Err(AppError::new(
            "empty_scope",
            "There are no changes in this scope. Choose another scope.",
        ));
    }
    notify("publishing", 0, Some(1), None)?;
    let mut committed = task.committed.lock().map_err(|_| state_error())?;
    task.check()?;
    let workspace = reviews::publish_creation(storage, snapshot)?;
    *committed = true;
    // Losing the frontend after publication must not turn a successful creation
    // into a retry that duplicates it.
    let _ = progress(CaptureProgress {
        operation_id: task.operation_id.clone(),
        phase: "completed".into(),
        completed: 1,
        total: Some(1),
        path: None,
    });
    Ok(workspace)
}
