//! Mutation admission for updates, and the final writer transaction precondition.
use super::*;

pub(crate) struct UpdateLease {
    storage: Storage,
    key: (String, String),
    owner: String,
}
impl Drop for UpdateLease {
    fn drop(&mut self) {
        let mut busy = self.storage.updating.lock().unwrap();
        if busy.get(&self.key) == Some(&self.owner) {
            busy.remove(&self.key);
        }
    }
}
impl Storage {
    pub(crate) fn pending_review_update(
        &self,
        repository: &str,
        review: &str,
    ) -> AppResult<Option<Review>> {
        let _read = self.read_consistently();
        self.sync_projects(false)?;
        let candidate = self
            .project_values("review")?
            .into_iter()
            .find(|(_, value)| {
                value["repositoryId"] == repository
                    && value["updateOrigin"]["sourceReviewId"] == review
            });
        candidate
            .map(|(id, _)| self.scoped(Some(repository)).get("review", &id))
            .transpose()
    }
    pub(crate) fn own_update(
        &self,
        repository: &str,
        review: &str,
        owner: &str,
    ) -> AppResult<(Self, UpdateLease)> {
        let _write = self.writes.lock();
        let key = (repository.to_owned(), review.to_owned());
        let mut busy = self.updating.lock().unwrap();
        if busy.contains_key(&key) {
            return Err(AppError::new(
                "review_busy",
                "A review update is already running.",
            ));
        }
        busy.insert(key.clone(), owner.into());
        let mut storage = self.clone();
        storage.update_owner = Some(owner.into());
        Ok((
            storage,
            UpdateLease {
                storage: self.clone(),
                key,
                owner: owner.into(),
            },
        ))
    }
    pub(crate) fn check_update_write(&self, repository: &str, review: &str) -> AppResult<()> {
        if self
            .updating
            .lock()
            .unwrap()
            .get(&(repository.into(), review.into()))
            .is_some_and(|owner| Some(owner.as_str()) != self.update_owner.as_deref())
        {
            return Err(AppError::new(
                "review_busy",
                "This review is read-only while Rev updates it.",
            ));
        }
        Ok(())
    }
    pub(super) fn commit_update(
        &self,
        repository: &str,
        old: &Documents,
        next: &mut Documents,
        destination: &str,
        value: &Value,
    ) -> AppResult<()> {
        let update: ReviewAdaptation = serde_json::from_value(value.clone())?;
        if self.update_owner.as_deref() != Some(update.candidate_review_id.as_str()) {
            return Err(AppError::new(
                "review_busy",
                "Only the update owner can install its result.",
            ));
        }
        let source = old
            .get(&("review".into(), update.source_review_id.clone()))
            .or_else(|| old.get(&("review_reference".into(), update.source_review_id.clone())))
            .ok_or_else(|| {
                AppError::new("conflict", "The source review is no longer available.")
            })?;
        // Match the optimistic revision exposed by the index (including an
        // externally edited document), not only the JSON revision on disk.
        let revision: Option<u32> = self.connection()?.query_row(
            "SELECT revision FROM project_index WHERE repository_id=?1 AND kind='review' AND id=?2",
            params![repository,update.source_review_id], |r|r.get(0)).optional()?;
        let revision = u64::from(revision.unwrap_or(0));
        if revision != u64::from(update.source_revision)
            || source["snapshotId"] != update.snapshot_id
            || destination != update.destination_review_id
        {
            return Err(AppError::new(
                "conflict",
                "The original review changed during its update.",
            ));
        }
        self.check_update_write(repository, &update.source_review_id)?;
        let candidate = old
            .get(&("review".into(), update.candidate_review_id.clone()))
            .ok_or_else(|| AppError::new("conflict", "The update candidate is missing."))?;
        if candidate["updateOrigin"]["sourceReviewId"] != update.source_review_id {
            return Err(AppError::new(
                "conflict",
                "The candidate belongs to another review.",
            ));
        }
        if destination != update.candidate_review_id {
            next.remove(&("review".into(), update.candidate_review_id));
        }
        Ok(())
    }
}
