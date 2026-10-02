//! Private source contexts for Code Explain. They are not reviews. Only saving
//! knowledge promotes its referenced captures into the shared v4 writer.
use super::*;
use std::collections::BTreeSet;

impl Storage {
    pub(crate) fn source_context(&self, id: &str) -> AppResult<Snapshot> {
        let snapshot: Snapshot = self.local_get("code_context", id)?;
        if self
            .scope
            .as_ref()
            .is_some_and(|scope| scope != &snapshot.repository_id)
        {
            return Err(AppError::new(
                "context",
                "This source context belongs to another repository.",
            ));
        }
        Ok(snapshot)
    }
    pub(crate) fn store_context(&self, snapshot: &Snapshot) -> AppResult<()> {
        let directory = self.root.join("code-contexts").join(&snapshot.id);
        fs::create_dir_all(&directory)?;
        let result = (|| {
            let hashes: BTreeSet<_> = crate::reader::sources(snapshot)
                .into_iter()
                .map(|s| s.hash)
                .chain(snapshot.files.iter().map(|f| f.content.hash.clone()))
                .collect();
            for hash in hashes {
                let bytes = self.read_blob(&hash)?;
                // Source cache eviction can unlink its copy; these private links
                // remain until the context is released or promoted.
                let target = directory.join(&hash);
                if fs::hard_link(self.root.join("blobs").join(&hash), &target).is_err() {
                    fs::write(target, bytes)?;
                }
            }
            self.insert("code_context", &snapshot.id, snapshot)
        })();
        if result.is_err() {
            let _ = fs::remove_dir_all(directory);
        }
        result
    }
    pub(crate) fn context_blob(&self, hash: &str) -> AppResult<Option<Vec<u8>>> {
        for snapshot in self.list::<Snapshot>("code_context")? {
            if self
                .scope
                .as_ref()
                .is_some_and(|r| r != &snapshot.repository_id)
            {
                continue;
            }
            if snapshot.files.iter().any(|f| f.content.hash == hash)
                || snapshot.changes.iter().any(|c| {
                    c.before
                        .iter()
                        .chain(c.after.iter())
                        .any(|b| b.hash == hash)
                })
            {
                let path = self.root.join("code-contexts").join(snapshot.id).join(hash);
                if !path.exists() {
                    continue;
                }
                let bytes = fs::read(path)?;
                if fingerprint(&bytes) != hash {
                    return Err(AppError::new(
                        "corrupt_content",
                        "A Code Explain source failed its checksum.",
                    ));
                }
                self.source_cache.store(&bytes)?;
                return Ok(Some(bytes));
            }
        }
        Ok(None)
    }
    pub(crate) fn release_context(&self, id: &str) -> AppResult<()> {
        let snapshot = match self.source_context(id) {
            Ok(s) => s,
            Err(e) if e.code == "not_found" => return Ok(()),
            Err(e) => return Err(e),
        };
        let used = self
            .list::<AgentRun>("agent_run")?
            .iter()
            .any(|r| r.context_id.as_deref() == Some(id) && r.status == "running")
            || self
                .list::<Proposal>("knowledge_proposal")?
                .iter()
                .any(|p| p.context_id.as_deref() == Some(id) && p.status == "pending");
        if used {
            self.pending_snapshot_gc.lock().unwrap().insert(id.into());
            return Ok(());
        }
        if self
            .active_snapshots
            .lock()
            .unwrap()
            .get(id)
            .is_some_and(|count| *count > 0)
        {
            self.pending_snapshot_gc.lock().unwrap().insert(id.into());
            return Ok(());
        }
        self.remove("code_context", id)?;
        self.pending_snapshot_gc.lock().unwrap().remove(id);
        let directory = self.root.join("code-contexts").join(snapshot.id);
        if directory.exists() {
            fs::remove_dir_all(directory)?;
        }
        Ok(())
    }
    pub(crate) fn shared_snapshot_exists(&self, id: &str) -> AppResult<bool> {
        self.sync_projects(false)?;
        Ok(self
            .project_values("snapshot")?
            .iter()
            .any(|(key, _)| key == id))
    }
}
