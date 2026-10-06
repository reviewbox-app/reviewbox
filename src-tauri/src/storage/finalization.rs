use super::*;

impl Storage {
    pub(crate) fn save_review_commit(&self, state: &ReviewCommitOperation) -> AppResult<()> {
        let key = format!("{}:{}", state.operation.repository_id, state.review_id);
        self.connection()?.execute(
            "INSERT INTO documents(kind,id,revision,body) VALUES('review_commit',?1,0,?2) ON CONFLICT(kind,id) DO UPDATE SET revision=revision+1,body=excluded.body",
            params![key, serde_json::to_string(state)?],
        )?;
        Ok(())
    }

    // Progress must remain readable while a project transaction is running.
    pub(crate) fn save_finalization(&self, state: &ReviewFinalization) -> AppResult<()> {
        let key = format!("{}:{}", state.repository_id, state.review_id);
        self.connection()?.execute(
            "INSERT INTO documents(kind,id,revision,body) VALUES('review_finalization',?1,0,?2) ON CONFLICT(kind,id) DO UPDATE SET revision=revision+1,body=excluded.body",
            params![key, serde_json::to_string(state)?],
        )?;
        Ok(())
    }
}

/// Only review metadata changes reload the reader, never content/source events.
pub(super) fn changed_review_id(root: &std::path::Path, path: &std::path::Path) -> Option<String> {
    if path.file_name()? != "review.json" {
        return None;
    }
    let parts: Vec<_> = path
        .strip_prefix(root)
        .ok()?
        .components()
        .filter_map(|c| c.as_os_str().to_str())
        .collect();
    match parts.as_slice() {
        [".local", "reviews", id, ..] | ["published", id, ..] => Some((*id).to_string()),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn watch_events_target_review_metadata_only() {
        let root = std::path::Path::new("/repo/.reviewbox");
        assert_eq!(
            changed_review_id(root, &root.join(".local/reviews/id/review.json")),
            Some("id".into())
        );
        assert_eq!(
            changed_review_id(root, &root.join("published/id/reviews/id/review.json")),
            Some("id".into())
        );
        assert_eq!(
            changed_review_id(root, &root.join(".local/captures/id/snapshot.json")),
            None
        );
        assert_eq!(
            changed_review_id(
                root,
                std::path::Path::new("/other/.local/reviews/id/review.json")
            ),
            None
        );
    }
}
