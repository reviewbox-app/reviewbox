use super::*;
use crate::project_storage::{
    content,
    publication::{self, ArchiveDecision},
};

fn reference_review(reference: &Value) -> Value {
    let mut value = reference.clone();
    value["revision"] = json!(0);
    value["topics"] = json!([]);
    value["files"] = json!([]);
    value["glossary"] = json!([]);
    value["decisions"] = json!([]);
    value["examined"] = json!([]);
    value["previousSnapshotIds"] = json!([]);
    value["preparationId"] = Value::Null;
    value["position"] = serde_json::to_value(ReadingPosition::default()).unwrap();
    value["assetIndex"] = json!({});
    value
}
impl Storage {
    pub(crate) fn enrich_publication(&self, review: &mut Value) -> AppResult<()> {
        if !self.enrich_reviews {
            return Ok(());
        }
        if !["published", "completedLocal"]
            .contains(&review["publication"]["status"].as_str().unwrap_or_default())
        {
            return Ok(());
        }
        let repository_id = review["repositoryId"].as_str().unwrap_or_default();
        let repository: Repository = self.get("repository", repository_id)?;
        let Some(head) = crate::repositories::text(
            std::path::Path::new(&repository.path),
            &["rev-parse", "--verify", "HEAD"],
        )
        .ok() else {
            return Ok(());
        };
        let shallow_path = crate::repositories::text(
            std::path::Path::new(&repository.path),
            &["rev-parse", "--git-path", "shallow"],
        )?;
        let shallow_file = std::path::Path::new(&repository.path).join(shallow_path);
        let history = fingerprint(&fs::read(shallow_file).unwrap_or_default());
        let key = format!(
            "{repository_id}:{}",
            review["id"].as_str().unwrap_or_default()
        );
        let scope = review["publication"]["completion"]["scopeFingerprint"]
            .as_str()
            .unwrap_or_default();
        let cached = self
            .local_get::<Value>("review_commit_association", &key)
            .ok();
        let matches = if let Some(cached) =
            cached.filter(|v| v["head"] == head && v["scope"] == scope && v["history"] == history)
        {
            cached["commits"].clone()
        } else {
            let snapshot: Snapshot = self.get(
                "snapshot",
                review["snapshotId"].as_str().unwrap_or_default(),
            )?;
            let project = self
                .projects
                .lock()
                .unwrap()
                .get(repository_id)
                .map(|m| m.project.clone())
                .ok_or_else(|| AppError::new("project", "Project not open."))?;
            let commits = match publication::matching_commits(&project, &snapshot) {
                Ok(commits) => json!(commits),
                Err(_) => {
                    review["publication"]["matchingCommitIds"] = json!([]);
                    return Ok(());
                }
            };
            self.connection()?.execute("INSERT INTO documents(kind,id,revision,body) VALUES('review_commit_association',?1,0,?2) ON CONFLICT(kind,id) DO UPDATE SET body=excluded.body",params![key,serde_json::to_string(&json!({"head":head,"scope":scope,"history":history,"commits":commits}))?])?;
            commits
        };
        review["publication"]["matchingCommitIds"] = matches;
        Ok(())
    }

    pub(crate) fn archived_value(&self, kind: &str, id: &str) -> AppResult<Option<Value>> {
        let mut candidates = if kind != "review" {
            self.archives
                .lock()
                .unwrap()
                .iter()
                .filter(|((repo, k, key), _)| {
                    k == kind && key == id && self.scope.as_ref().is_none_or(|scope| scope == repo)
                })
                .map(|((repo, _, _), value)| (repo.clone(), value.clone()))
                .collect::<Vec<_>>()
        } else {
            self.project_values("review_reference")?
                .into_iter()
                .filter(|(key, _)| key == id)
                .map(|(_, reference)| {
                    let repository = reference["repositoryId"].as_str().ok_or_else(|| {
                        AppError::new("invalid_project", "Archive repository missing.")
                    })?;
                    Ok((repository.to_string(), reference))
                })
                .collect::<AppResult<Vec<_>>>()?
        };
        if candidates.is_empty() {
            return Ok(None);
        }
        let current: Vec<_> = self
            .project_values(kind)?
            .into_iter()
            .filter(|(key, _)| key == id)
            .collect();
        let repositories: std::collections::BTreeSet<_> = candidates
            .iter()
            .map(|(repo, _)| repo.as_str())
            .chain(
                current
                    .iter()
                    .filter_map(|(_, value)| value["repositoryId"].as_str()),
            )
            .collect();
        if repositories.len() > 1 {
            return Err(AppError::new(
                "ambiguous_checkout",
                "This document exists in multiple open checkouts. Choose its checkout before opening the archive.",
            ));
        }
        // A retained shared capture can coexist with its previously loaded
        // archive. Prefer the current project's authoritative source index.
        if !current.is_empty() {
            return Ok(None);
        }
        let (repo, reference) = candidates.pop().expect("non-empty archive candidates");
        if kind != "review" {
            return Ok(Some(reference));
        }
        let project = self
            .projects
            .lock()
            .unwrap()
            .get(&repo)
            .map(|m| m.project.clone())
            .ok_or_else(|| AppError::new("not_found", "Open archive project first."))?;
        // Coordinate cache eviction with snapshot-reader admission and project
        // writes. A reader can never acquire a pin halfway through eviction.
        let _cache_write = self.writes.lock();
        let protected = self
            .active_snapshots
            .lock()
            .unwrap()
            .keys()
            .cloned()
            .collect();
        let docs = project.load_archive(&reference, &protected)?;
        let result = docs.get(&(kind.into(), id.into())).cloned();
        let mut archives = self.archives.lock().unwrap();
        for ((kind, id), value) in docs {
            archives.insert((repo.clone(), kind, id), value);
        }
        Ok(result)
    }
    pub(crate) fn append_archive_summaries(
        &self,
        values: &mut Vec<(String, Value)>,
    ) -> AppResult<()> {
        for (id, value) in self.project_values("review_reference")? {
            values.push((id, reference_review(&value)));
        }
        Ok(())
    }
    fn publication_attempt(
        &self,
        id: &str,
        progress: &mut crate::review_finalization::Progress<'_>,
    ) -> AppResult<()> {
        let write = self.writes.lock();
        self.sync_projects(true)?;
        let mounted = self.projects.lock().unwrap();
        let m = mounted
            .iter()
            .find(|(repo, m)| {
                self.scope.as_ref().is_none_or(|scope| scope == *repo)
                    && m.documents.contains_key(&("review".into(), id.into()))
            })
            .map(|(_, m)| m)
            .ok_or_else(|| AppError::new("not_found", "Review not found."))?;
        let project = m.project.clone();
        self.check_update_write(&project.repository_id, id)?;
        let _lock = project.lock()?;
        project.recover_locked()?;
        let old = project.read()?;
        drop(_lock);
        drop(mounted);
        drop(write);
        let project = &project;
        let publication_head = crate::repositories::text(
            project.root.parent().unwrap(),
            &["rev-parse", "--verify", "HEAD"],
        )
        .ok();
        let mut next = old.clone();
        let key = ("review".into(), id.into());
        let mut review = next
            .get(&key)
            .cloned()
            .ok_or_else(|| AppError::new("not_found", "Review missing."))?;
        if review["publication"]["status"] == "published" {
            return Ok(());
        }
        if review["publication"]["status"] != "publicationPending"
            || review["publication"]["completion"].is_null()
            || review["publication"]["keepLocal"] == true
        {
            return Err(AppError::new(
                "publication_state",
                "This review is not awaiting publication.",
            ));
        }
        let snapshot_id = review["snapshotId"]
            .as_str()
            .unwrap_or_default()
            .to_string();
        let snapshot = next
            .get_mut(&("snapshot".into(), snapshot_id.clone()))
            .ok_or_else(|| AppError::new("missing_snapshot", "Review capture is missing."))?;
        progress("preserve", FinalizationStepStatus::Running, None)?;
        let packs = content::portable_snapshot(project, snapshot)?;
        progress("preserve", FinalizationStepStatus::Completed, None)?;
        progress("commits", FinalizationStepStatus::Running, None)?;
        let captured: Snapshot = serde_json::from_value(snapshot.clone())?;
        review["publication"]["matchingCommitIds"] =
            json!(publication::matching_commits(project, &captured).unwrap_or_default());
        progress("commits", FinalizationStepStatus::Completed, None)?;
        progress("archive", FinalizationStepStatus::Running, None)?;
        review["publication"]["status"] = json!("published");
        review["publication"]["publicationError"] = Value::Null;
        let mut deferred: Vec<String> = old
            .iter()
            .filter(|((kind, _), _)| kind == "opaque_publication")
            .map(|((_, id), value)| {
                format!(
                    "{id}: complete copy retained because its metadata is invalid. {}",
                    value["reason"].as_str().unwrap_or_default()
                )
            })
            .collect();
        for ((kind, old_id), previous) in &old {
            if kind != "review" || old_id == id || previous["publication"]["status"] != "published"
            {
                continue;
            }
            if self
                .check_update_write(&project.repository_id, old_id)
                .is_err()
            {
                deferred.push(format!("{old_id}: Rev is updating this review."));
                continue;
            }
            let bundle = project.bundle_files(previous, &old)?;
            match publication::archive_candidate(project, old_id, &bundle, |files, commit| {
                content::verify_bundle_sources(project, files, commit)
            })? {
                ArchiveDecision::Deferred(reason) => deferred.push(format!(
                    "{}: {reason}",
                    previous["title"].as_str().unwrap_or(old_id)
                )),
                ArchiveDecision::Ready(location) => {
                    let mut metadata = previous["publication"].clone();
                    metadata["status"] = json!("archived");
                    metadata["archive"] = json!({"commitId":location.commit,"bundlePath":location.path,"bundleHash":location.bundle_hash});
                    if let Some(source) = old.get(&(
                        "snapshot".into(),
                        previous["snapshotId"].as_str().unwrap_or_default().into(),
                    )) {
                        metadata["matchingCommitIds"] = json!(
                            publication::matching_commits(
                                project,
                                &serde_json::from_value(source.clone())?
                            )
                            .unwrap_or_default()
                        );
                    }
                    metadata["fileCount"] = json!(previous["files"].as_array().map_or(0, Vec::len));
                    metadata["stepCount"] = json!(
                        previous["topics"]
                            .as_array()
                            .into_iter()
                            .flatten()
                            .map(|t| t["steps"].as_array().map_or(0, Vec::len))
                            .sum::<usize>()
                    );
                    let mut reference = json!({"id":old_id,"publication":metadata});
                    for key in [
                        "title",
                        "repositoryId",
                        "snapshotId",
                        "mode",
                        "createdAt",
                        "updatedAt",
                    ] {
                        reference[key] = previous[key].clone();
                    }
                    if let Some(source) = old.get(&(
                        "snapshot".into(),
                        previous["snapshotId"].as_str().unwrap_or_default().into(),
                    )) {
                        reference["scope"] = source["request"].clone();
                    }
                    next.remove(&("review".into(), old_id.clone()));
                    next.retain(|(kind, _), data| {
                        kind != "proposal" || data["reviewId"] != *old_id
                    });
                    next.insert(("review_reference".into(), old_id.clone()), reference);
                }
            }
        }
        progress("archive", FinalizationStepStatus::Completed, None)?;
        review["publication"]["archiveDeferredReason"] = if deferred.is_empty() {
            Value::Null
        } else {
            json!(deferred.join("\n"))
        };
        // A new publication may report deferred rotation. Published metadata is
        // immutable from this point onward; future attempts do not rewrite it.
        next.insert(key, review);
        prune_snapshots(
            &mut next,
            &self.active_snapshots.lock().unwrap(),
            &mut self.pending_snapshot_gc.lock().unwrap(),
        );
        let prefix = format!("published/{id}/");
        let prospective = project
            .files(&next, &packs, &old)?
            .into_iter()
            .filter_map(|(path, bytes)| path.strip_prefix(&prefix).map(|p| (p.to_string(), bytes)))
            .collect();
        progress("verify", FinalizationStepStatus::Running, None)?;
        publication::verify_bundle(&prospective)?;
        content::verify_bundle_sources(
            project,
            &prospective,
            publication_head.as_deref().unwrap_or("HEAD"),
        )?;
        progress("verify", FinalizationStepStatus::Completed, None)?;
        progress("publish", FinalizationStepStatus::Running, None)?;
        // Expensive Git/content work above does not hold application-wide locks.
        // Revalidate the authoritative project under its writer lock before committing.
        let _write = self.writes.lock();
        let mut mounted = self.projects.lock().unwrap();
        let m = mounted
            .get_mut(&project.repository_id)
            .ok_or_else(|| AppError::new("project", "Project closed during publication."))?;
        self.check_update_write(&project.repository_id, id)?;
        let _lock = project.lock()?;
        project.recover_locked()?;
        if project.read()? != old {
            return Err(AppError::new(
                "conflict",
                "Project data changed during publication. Retry finalization.",
            ));
        }
        if crate::repositories::text(
            project.root.parent().unwrap(),
            &["rev-parse", "--verify", "HEAD"],
        )
        .ok()
            != publication_head
        {
            return Err(AppError::new(
                "conflict",
                "HEAD changed during publication. Retry publication.",
            ));
        }
        project.commit_with_content(&old, &next, packs)?;
        m.documents = next;
        self.prune_preparation_checkpoints(&project.repository_id, &m.documents)?;
        self.index(project, &m.documents)?;
        m.dirty.store(true, Ordering::Release);
        progress("publish", FinalizationStepStatus::Completed, None)?;
        Ok(())
    }
    pub(crate) fn publish_review(&self, id: &str) -> AppResult<Workspace> {
        self.publish_review_progress(id, &mut |_, _, _| Ok(()))
    }
    pub(crate) fn publish_review_progress(
        &self,
        id: &str,
        progress: &mut crate::review_finalization::Progress<'_>,
    ) -> AppResult<Workspace> {
        if let Err(error) = self.publication_attempt(id, progress) {
            let mut review: Review = self.get("review", id)?;
            if review.publication.status == PublicationStatus::Published {
                return crate::reviews::load(self, id);
            }
            if review.publication.status != PublicationStatus::PublicationPending {
                return Err(error);
            }
            let revision = review.revision;
            review.revision += 1;
            review.publication.publication_error = Some(error.message);
            self.replace("review", id, revision, &review)?;
        }
        crate::reviews::load(self, id)
    }
    pub(crate) fn collect_review_garbage(&self, repository_id: &str) -> AppResult<()> {
        let _write = self.writes.lock();
        self.sync_projects(true)?;
        let mut mounted = self.projects.lock().unwrap();
        let m = mounted
            .get_mut(repository_id)
            .ok_or_else(|| AppError::new("not_found", "Project not mounted."))?;
        let _lock = m.project.lock()?;
        m.project.recover_locked()?;
        let old = m.project.read()?;
        let mut next = old.clone();
        prune_snapshots(
            &mut next,
            &self.active_snapshots.lock().unwrap(),
            &mut self.pending_snapshot_gc.lock().unwrap(),
        );
        if next != old {
            m.project.commit(&old, &next)?;
        }
        m.documents = next;
        self.index(&m.project, &m.documents)?;
        m.dirty.store(true, Ordering::Release);
        self.prune_preparation_checkpoints(repository_id, &m.documents)?;
        Ok(())
    }

    /// A checkpoint is only reusable by its exact unfinished review and capture.
    /// Completed output already lives in the review bundle; retain no second copy.
    fn prune_preparation_checkpoints(
        &self,
        repository_id: &str,
        docs: &Documents,
    ) -> AppResult<()> {
        let checkpoints: Vec<Value> = self.local_list("review_preparation")?;
        for checkpoint in checkpoints {
            if checkpoint["repositoryId"].as_str() != Some(repository_id) {
                continue;
            }
            let Some(review_id) = checkpoint["state"]["reviewId"].as_str() else {
                continue;
            };
            let update = &checkpoint["state"]["adaptation"];
            if !update.is_null() {
                // Candidates own both captures durably. Keep the terminal marker
                // too: it recovers a commit interrupted before checkpoint saving.
                let candidate = update["candidateReviewId"].as_str().unwrap_or_default();
                let destination = update["destinationReviewId"].as_str().unwrap_or_default();
                if docs
                    .get(&("review".into(), candidate.into()))
                    .is_some_and(|review| review["updateOrigin"]["sourceReviewId"] == review_id)
                    || docs
                        .get(&("review".into(), destination.into()))
                        .is_some_and(|review| review["preparationId"] == checkpoint["state"]["id"])
                {
                    continue;
                }
            }
            let compatible = docs
                .get(&("review".into(), review_id.into()))
                .is_some_and(|review| {
                    review["publication"]["status"] == "draft"
                        && review["snapshotId"] == checkpoint["state"]["snapshotId"]
                });
            if !compatible {
                self.remove(
                    "review_preparation",
                    &format!("{repository_id}:{review_id}"),
                )?;
            }
        }
        Ok(())
    }
}
fn prune_snapshots(
    docs: &mut Documents,
    active: &BTreeMap<String, usize>,
    pending: &mut std::collections::BTreeSet<String>,
) {
    fn gather(value: &Value, ids: &mut std::collections::BTreeSet<String>) {
        match value {
            Value::Object(map) => {
                for (key, value) in map {
                    if key == "carriedFrom" {
                        continue;
                    } // attribution, not a live source dependency
                    if key == "snapshotId"
                        && let Some(id) = value.as_str()
                    {
                        ids.insert(id.into());
                    }
                    gather(value, ids);
                }
            }
            Value::Array(values) => {
                for v in values {
                    gather(v, ids);
                }
            }
            _ => {}
        }
    }
    let mut retained = std::collections::BTreeSet::new();
    for ((kind, _), value) in docs.iter() {
        if kind != "snapshot" && kind != "review_reference" {
            gather(value, &mut retained);
        }
    }
    for (kind, id) in docs.keys() {
        if kind == "snapshot" && active.contains_key(id) && !retained.contains(id) {
            pending.insert(id.clone());
            retained.insert(id.clone());
        }
    }
    docs.retain(|(kind, id), _| kind != "snapshot" || retained.contains(id));
}

#[cfg(test)]
#[path = "publications_tests.rs"]
mod tests;
