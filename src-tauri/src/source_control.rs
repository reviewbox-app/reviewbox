//! Explicit source-control actions. No review, validation or publication is created here.
mod branches;
pub(crate) mod commands;
mod commits;
mod git;
mod history;
pub(crate) mod review_commit;
#[cfg(test)]
mod tests;
mod working;
use crate::contracts::*;
use std::{
    collections::HashMap,
    path::Path,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::Instant,
};

type ActiveOperations = HashMap<String, (String, Arc<AtomicBool>)>;

#[derive(Default, Clone)]
pub(crate) struct SourceControl {
    active: Arc<Mutex<ActiveOperations>>,
    checked: Arc<Mutex<HashMap<String, (Instant, GitRemoteCheck)>>>,
}
pub(super) struct OperationGuard {
    manager: SourceControl,
    root: String,
    pub cancel: Arc<AtomicBool>,
}
impl Drop for OperationGuard {
    fn drop(&mut self) {
        self.manager
            .active
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(&self.root);
    }
}
impl SourceControl {
    fn begin(&self, root: &Path, id: &str) -> AppResult<OperationGuard> {
        let key = root.to_string_lossy().into_owned();
        let mut active = self.active.lock().unwrap_or_else(|e| e.into_inner());
        if active.contains_key(&key) {
            return Err(AppError::new(
                "git_busy",
                "Another Git operation is running for this repository.",
            ));
        }
        let cancel = Arc::new(AtomicBool::new(false));
        active.insert(key.clone(), (id.into(), cancel.clone()));
        Ok(OperationGuard {
            manager: self.clone(),
            root: key,
            cancel,
        })
    }
    pub fn stop_all(&self) {
        for (_, flag) in self
            .active
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .values()
        {
            flag.store(true, Ordering::Relaxed);
        }
    }
    fn cancel(&self, id: &str) {
        for (operation, flag) in self
            .active
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .values()
        {
            if operation == id {
                flag.store(true, Ordering::Relaxed);
            }
        }
    }
    fn remote_check(&self, root: &Path) -> GitRemoteCheck {
        self.checked
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(&root.to_string_lossy().to_string())
            .map(|(_, s)| s.clone())
            .unwrap_or_default()
    }
}
