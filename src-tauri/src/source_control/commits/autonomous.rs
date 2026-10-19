//! Observe an explicit harness-owned commit operation without planning or writing Git.
use super::*;
use std::{future::Future, sync::Arc, time::Duration};

pub(in crate::source_control) async fn run(
    storage: &Storage,
    root: &Path,
    resources: &Path,
    request: &GitCommitRequest,
    stage_all: bool,
    cancel: Arc<AtomicBool>,
    notify: impl Fn(&GitOperation),
) -> AppResult<GitOperation> {
    monitor(
        storage,
        root,
        request,
        cancel.clone(),
        notify,
        crate::agents::commit::run(storage, root, resources, request, stage_all, cancel),
    )
    .await
}

async fn monitor(
    storage: &Storage,
    root: &Path,
    request: &GitCommitRequest,
    cancel: Arc<AtomicBool>,
    notify: impl Fn(&GitOperation),
    execution: impl Future<Output = AppResult<()>>,
) -> AppResult<GitOperation> {
    let data = storage.clone();
    let path = root.to_owned();
    let input = request.clone();
    let mut journal = tauri::async_runtime::spawn_blocking(move || begin(&data, &path, &input))
        .await
        .map_err(|e| AppError::new("task", e.to_string()))??;
    notify(&journal.operation);
    let mut observed_head = journal.original_head.clone();
    let mut ticker = tokio::time::interval(Duration::from_millis(800));
    ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    let mut observer_error = None;
    tokio::pin!(execution);
    let result = loop {
        tokio::select! {
            result = &mut execution => break result,
            _ = ticker.tick() => {
                let data = storage.clone();
                let path = root.to_owned();
                let previous = observed_head.clone();
                let check = journal.clone();
                let update = tauri::async_runtime::spawn_blocking(move || -> AppResult<_> {
                    let head = git::head(&path);
                    let mut next = check;
                    if head != previous {
                        observe(&path, &mut next)?;
                        write(&data, &next)?;
                    }
                    Ok((head, next))
                }).await.map_err(|e| AppError::new("task", e.to_string())).and_then(|r| r);
                match update {
                    Ok((head, next)) => {
                        if head != observed_head { notify(&next.operation); }
                        observed_head = head;
                        journal = next;
                    }
                    Err(error) => {
                        observer_error = Some(error);
                        cancel.store(true, Ordering::Relaxed);
                        // Let the provider finish cancellation and reap its process tree.
                        break execution.await;
                    }
                }
            }
        }
    };
    let data = storage.clone();
    let path = root.to_owned();
    let cancelled = cancel.load(Ordering::Relaxed);
    let operation = tauri::async_runtime::spawn_blocking(move || -> AppResult<_> {
        // Catch commits created between the final tick and provider termination,
        // including commits made before a hook/provider error or cancellation.
        let observation = observe(&path, &mut journal);
        let result = observer_error.map_or(result, Err).and(observation);
        match result {
            Ok(()) if !cancelled => {
                journal.operation.status = "completed".into();
                journal.operation.message = if journal.operation.commits.is_empty() {
                    "Rev finished. No new commits were observed in Git.".into()
                } else {
                    format!(
                        "Rev finished. {} commits observed in Git.",
                        journal.operation.commits.len()
                    )
                };
            }
            other => {
                let error = other.err();
                journal.operation.status = if error.as_ref().is_some_and(|e| e.code == "cancelled")
                    || (error.is_none() && cancelled)
                {
                    "cancelled"
                } else {
                    "failed"
                }
                .into();
                journal.operation.message =
                    "Rev stopped. Existing commits and remaining changes are available in Git."
                        .into();
                journal.operation.error = error.map(|e| match e.details {
                    Some(details) => format!("{}\n{details}", e.message),
                    None => e.message,
                });
            }
        }
        write(&data, &journal)?;
        Ok(journal.operation)
    })
    .await
    .map_err(|e| AppError::new("task", e.to_string()))??;
    notify(&operation);
    Ok(operation)
}

fn begin(storage: &Storage, root: &Path, request: &GitCommitRequest) -> AppResult<Journal> {
    if journal_path(storage, &request.operation_id).exists() {
        return Err(AppError::new(
            "operation_exists",
            "This operation already ran. Start a new operation.",
        ));
    }
    // Exclude all pre-existing tips, so switching to an existing branch does not
    // mislabel its history as commits created during this operation.
    let mut baseline: Vec<String> = git::text(root, &["for-each-ref", "--format=%(objectname)"])?
        .lines()
        .map(str::to_owned)
        .collect();
    let head = git::head(root);
    baseline.extend(head.clone());
    baseline.sort();
    baseline.dedup();
    let journal = Journal {
        operation: GitOperation {
            id: request.operation_id.clone(),
            repository_id: request.repository_id.clone(),
            status: "running".into(),
            message: "Rev is creating commits…".into(),
            commits: vec![],
            error: None,
        },
        observed_from: Some(baseline),
        original_head: head,
        index_version: request.index_version.clone(),
        batches: vec![],
        next: 0,
        pending_head: None,
        pending_tree: None,
        target_tree: None,
        worktree_before: None,
        branch: None,
        original_index_hash: None,
        pending_index: None,
    };
    write(storage, &journal)?;
    Ok(journal)
}

pub(super) fn observe(root: &Path, journal: &mut Journal) -> AppResult<()> {
    let Some(head) = git::head(root) else {
        return Ok(());
    };
    let mut refs = vec!["--reverse", "--topo-order", head.as_str()];
    if let Some(baseline) = &journal.observed_from
        && !baseline.is_empty()
    {
        refs.push("--not");
        refs.extend(baseline.iter().map(String::as_str));
    }
    for commit in history::summaries(root, &refs, None)? {
        if !journal
            .operation
            .commits
            .iter()
            .any(|c| c.oid == commit.oid)
        {
            journal.operation.commits.push(commit);
        }
    }
    if journal.operation.status == "running" && !journal.operation.commits.is_empty() {
        journal.operation.message = format!(
            "{} commits observed in Git. Rev is working…",
            journal.operation.commits.len()
        );
    }
    Ok(())
}

#[cfg(test)]
mod tests;
