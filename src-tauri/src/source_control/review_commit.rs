//! A user-started stage-all/Rev commit job survives navigation away from the summary.
use super::{SourceControl, commits, working};
use crate::{contracts::*, storage::Storage};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
};
use tauri::{Emitter, State, ipc::Channel};

#[derive(Default, Clone)]
pub(crate) struct ReviewCommits(Arc<Mutex<HashMap<String, ReviewCommitOperation>>>);
impl ReviewCommits {
    fn publish(
        &self,
        storage: &Storage,
        app: &tauri::AppHandle,
        state: &ReviewCommitOperation,
    ) -> AppResult<()> {
        storage.save_review_commit(state)?;
        self.0
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(state.operation.repository_id.clone(), state.clone());
        let _ = app.emit("reviewbox:review-commit", state);
        Ok(())
    }
}

struct JobCompletion {
    jobs: ReviewCommits,
    storage: Storage,
    app: tauri::AppHandle,
    repository_id: String,
}
impl Drop for JobCompletion {
    fn drop(&mut self) {
        let current = self
            .jobs
            .0
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(&self.repository_id)
            .cloned();
        if let Some(mut state) = current.filter(|s| s.operation.status == "running") {
            state.operation.status = "interrupted".into();
            state.operation.error = Some("The commit task stopped unexpectedly. Inspect the existing commits and index before trying again.".into());
            state.sequence += 1;
            let _ = self.jobs.publish(&self.storage, &self.app, &state);
        }
    }
}

fn stage_and_freeze(
    root: &std::path::Path,
    cancel: &std::sync::atomic::AtomicBool,
) -> AppResult<Option<commits::Frozen>> {
    let expected = working::index_version(root)?;
    let files = working::files(root)?;
    if files.is_empty() {
        return Ok(None);
    }
    if files.iter().any(|f| f.conflicted) {
        return Err(AppError::new(
            "git_conflict",
            "Resolve Git conflicts before committing.",
        ));
    }
    if working::index_version(root)? != expected {
        return Err(AppError::new(
            "git_changed",
            "The Git index changed. Try again.",
        ));
    }
    let selections: Vec<_> = files
        .into_iter()
        .filter(|f| f.unstaged_status.is_some())
        .map(|f| LocalFileSelection {
            path: f.path,
            version: f.version,
        })
        .collect();
    let version = if selections.is_empty() {
        expected
    } else {
        working::stage_files_version(root, &selections, true, cancel)?
    };
    commits::freeze(root, &version).map(Some)
}

#[tauri::command]
pub async fn start_review_commit(
    app: tauri::AppHandle,
    storage: State<'_, Storage>,
    manager: State<'_, SourceControl>,
    jobs: State<'_, ReviewCommits>,
    repository_id: String,
    review_id: String,
) -> AppResult<ReviewCommitOperation> {
    let s = storage.for_finalization(&repository_id);
    let manager = manager.inner().clone();
    let jobs = jobs.inner().clone();
    let data = s.clone();
    let native = manager.clone();
    let states = jobs.clone();
    let prepared = tauri::async_runtime::spawn_blocking(move || -> AppResult<_> {
        let old = states
            .0
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(&repository_id)
            .cloned();
        if let Some(old) = old.filter(|v| v.operation.status == "running") {
            if old.review_id == review_id {
                return Ok((old, None));
            }
            return Err(AppError::new(
                "git_busy",
                "Another review is committing changes in this project.",
            ));
        }
        let review: Review = data.get("review", &review_id)?;
        if review.repository_id != repository_id
            || !matches!(
                review.publication.status,
                PublicationStatus::Published
                    | PublicationStatus::CompletedLocal
                    | PublicationStatus::Archived
            )
        {
            return Err(AppError::new(
                "review_incomplete",
                "Finish finalizing the review before committing.",
            ));
        }
        match data.local_get::<ReviewFinalization>(
            "review_finalization",
            &format!("{repository_id}:{review_id}"),
        ) {
            Ok(value) if value.status != FinalizationStatus::Completed => {
                return Err(AppError::new(
                    "review_incomplete",
                    "Finish finalizing the review before committing.",
                ));
            }
            Err(error) if error.code != "not_found" => return Err(error),
            _ => {}
        }
        let root = crate::repositories::root(&data, &repository_id)?;
        let id = id();
        let guard = native.begin(&root, &id)?;
        let sequence = data
            .local_get::<ReviewCommitOperation>(
                "review_commit",
                &format!("{repository_id}:{review_id}"),
            )
            .map(|v| v.sequence + 1)
            .unwrap_or(0);
        let value = ReviewCommitOperation {
            review_id,
            sequence,
            phase: "stage".into(),
            operation: GitOperation {
                id,
                repository_id: repository_id.clone(),
                status: "running".into(),
                message: "Staging all saved changes…".into(),
                commits: vec![],
                error: None,
            },
        };
        data.save_review_commit(&value)?;
        states
            .0
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(repository_id, value.clone());
        Ok((value, Some((root, guard))))
    })
    .await
    .map_err(|e| AppError::new("task", e.to_string()))??;
    let (value, work) = prepared;
    let Some((root, guard)) = work else {
        return Ok(value);
    };
    let initial = value.clone();
    tauri::async_runtime::spawn(async move {
        let _completion = JobCompletion {
            jobs: jobs.clone(),
            storage: s.clone(),
            app: app.clone(),
            repository_id: value.operation.repository_id.clone(),
        };
        let _invalidation = s.repository_cache.git_mutation(&root);
        let mut state = value;
        let result = async {
            let staging_root = root.clone();
            let cancel = guard.cancel.clone();
            let frozen = tauri::async_runtime::spawn_blocking(move || {
                stage_and_freeze(&staging_root, &cancel)
            })
            .await
            .map_err(|e| AppError::new("task", e.to_string()))??;
            let Some(frozen) = frozen else {
                state.operation.message = "Nothing to commit".into();
                return Ok::<_, AppError>(());
            };
            let request = GitCommitRequest {
                operation_id: state.operation.id.clone(),
                repository_id: state.operation.repository_id.clone(),
                index_version: frozen.version.clone(),
                message: None,
            };
            state.phase = "plan".into();
            state.sequence += 1;
            state.operation.message = "Rev is preparing commits…".into();
            jobs.publish(&s, &app, &state)?;
            let resources = crate::commands::resource_root(&app)?;
            let plan = crate::agents::commit::plan(
                &s,
                &root,
                &resources,
                &request,
                frozen.context.clone(),
                guard.cancel.clone(),
                Channel::new(|_| Ok(())),
            )
            .await?;
            let batches = commits::plan(&plan, &frozen)?;
            state.phase = "commit".into();
            state.sequence += 1;
            state.operation.message = "Creating commits…".into();
            jobs.publish(&s, &app, &state)?;
            let data = s.clone();
            let root = root.clone();
            let cancel = guard.cancel.clone();
            let updates = jobs.clone();
            let handle = app.clone();
            let base = state.clone();
            state.operation = tauri::async_runtime::spawn_blocking(move || {
                commits::execute(
                    &data,
                    &root,
                    &request,
                    &frozen,
                    batches,
                    &cancel,
                    |operation| {
                        let mut progress = base.clone();
                        progress.operation = operation.clone();
                        progress.sequence += operation.commits.len() as u32 + 1;
                        let _ = updates.publish(&data, &handle, &progress);
                    },
                )
            })
            .await
            .map_err(|e| AppError::new("task", e.to_string()))??;
            Ok(())
        }
        .await;
        // Read the latest progress so a late error never hides already-created commits.
        if let Some(last) = jobs
            .0
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(&state.operation.repository_id)
            .cloned()
            && last.sequence > state.sequence
        {
            state.sequence = last.sequence;
            state.operation.commits = last.operation.commits;
        }
        match result {
            Ok(()) => {
                if state.operation.status == "running" {
                    state.operation.status = "completed".into();
                }
                if state.operation.status == "completed" {
                    state.phase = "done".into();
                }
            }
            Err(error) => {
                state.operation.status = if error.code == "cancelled" {
                    "cancelled"
                } else {
                    "failed"
                }
                .into();
                state.operation.message =
                    "Commit stopped; completed commits and staged changes are preserved.".into();
                state.operation.error = Some(error.message);
            }
        }
        state.sequence += 1;
        let _ = jobs.publish(&s, &app, &state);
        drop(guard);
    });
    Ok(initial)
}

#[tauri::command]
pub async fn get_review_commit(
    storage: State<'_, Storage>,
    jobs: State<'_, ReviewCommits>,
    manager: State<'_, SourceControl>,
    repository_id: String,
    review_id: String,
) -> AppResult<Option<ReviewCommitOperation>> {
    if let Some(value) = jobs
        .0
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get(&repository_id)
        .filter(|s| s.review_id == review_id)
        .cloned()
    {
        return Ok(Some(value));
    }
    let s = storage.inner().clone();
    let native = manager.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let key = format!("{repository_id}:{review_id}");
        let mut state = match s.local_get::<ReviewCommitOperation>("review_commit", &key) {
            Ok(v) => v,
            Err(e) if e.code == "not_found" => return Ok(None),
            Err(e) => return Err(e),
        };
        if state.operation.status == "running" {
            let root = crate::repositories::root(&s, &repository_id)?;
            let _guard = native.begin(&root, &id())?;
            if let Some(recovered) =
                commits::last(&s, &repository_id)?.filter(|v| v.id == state.operation.id)
            {
                state.operation = recovered;
            }
            if state.operation.status == "running" {
                state.operation.status = "interrupted".into();
            }
            state.sequence += 1;
            s.save_review_commit(&state)?;
        }
        Ok(Some(state))
    })
    .await
    .map_err(|e| AppError::new("task", e.to_string()))?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{fs, path::Path, process::Command, sync::atomic::AtomicBool};
    fn git(root: &Path, args: &[&str]) -> String {
        let out = Command::new("git")
            .args(args)
            .current_dir(root)
            .output()
            .unwrap();
        assert!(
            out.status.success(),
            "{}",
            String::from_utf8_lossy(&out.stderr)
        );
        String::from_utf8(out.stdout).unwrap()
    }
    #[test]
    fn stages_saved_changes_including_partial_and_untracked_but_not_ignored() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        git(root, &["init", "-q"]);
        git(root, &["config", "user.name", "Test"]);
        git(root, &["config", "user.email", "test@example.invalid"]);
        fs::write(root.join("a.ts"), "base\n").unwrap();
        fs::write(root.join("deleted.ts"), "old\n").unwrap();
        fs::write(root.join(".gitignore"), "ignored.txt\n").unwrap();
        git(root, &["add", "."]);
        git(root, &["commit", "-qm", "base"]);
        fs::write(root.join("a.ts"), "staged\n").unwrap();
        git(root, &["add", "a.ts"]);
        fs::write(root.join("a.ts"), "all saved\n").unwrap();
        fs::remove_file(root.join("deleted.ts")).unwrap();
        fs::write(root.join("new.ts"), "new\n").unwrap();
        fs::write(root.join("ignored.txt"), "private\n").unwrap();
        let frozen = stage_and_freeze(root, &AtomicBool::new(false))
            .unwrap()
            .unwrap();
        assert_eq!(git(root, &["show", ":a.ts"]), "all saved\n");
        assert_eq!(frozen.files.len(), 3);
        assert!(!frozen.files.iter().any(|f| f.path == "ignored.txt"));
        assert_eq!(git(root, &["diff", "--name-only"]), "");
        assert_eq!(
            fs::read_to_string(root.join("ignored.txt")).unwrap(),
            "private\n"
        );
    }
    #[test]
    fn clean_checkout_has_no_plan_and_cancel_does_not_stage() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        git(root, &["init", "-q"]);
        assert!(
            stage_and_freeze(root, &AtomicBool::new(false))
                .unwrap()
                .is_none()
        );
        fs::write(root.join("a.ts"), "saved\n").unwrap();
        assert!(stage_and_freeze(root, &AtomicBool::new(true)).is_err());
        assert_eq!(git(root, &["ls-files"]), "");
    }
}
