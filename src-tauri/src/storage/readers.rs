//! Retain captures for native readers until the last request/session releases it.
use super::*;
pub(crate) struct SnapshotLease {
    storage: Storage,
    id: String,
}
impl Storage {
    pub(crate) fn pin_snapshot(&self, id: &str) -> SnapshotLease {
        let _admission = self.writes.lock();
        *self
            .active_snapshots
            .lock()
            .unwrap()
            .entry(id.into())
            .or_default() += 1;
        SnapshotLease {
            storage: self.clone(),
            id: id.into(),
        }
    }
}
impl Drop for SnapshotLease {
    fn drop(&mut self) {
        let released = {
            let mut readers = self.storage.active_snapshots.lock().unwrap();
            if let Some(count) = readers.get_mut(&self.id) {
                *count -= 1;
                if *count == 0 {
                    readers.remove(&self.id);
                    true
                } else {
                    false
                }
            } else {
                false
            }
        };
        if released
            && self
                .storage
                .pending_snapshot_gc
                .lock()
                .unwrap()
                .remove(&self.id)
        {
            let repositories: Vec<_> = self
                .storage
                .projects
                .lock()
                .unwrap()
                .iter()
                .filter(|(_, m)| {
                    m.documents
                        .contains_key(&("snapshot".into(), self.id.clone()))
                })
                .map(|(id, _)| id.clone())
                .collect();
            for repository in repositories {
                let _ = self.storage.collect_review_garbage(&repository);
            }
        }
    }
}
