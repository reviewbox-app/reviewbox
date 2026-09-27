use crate::{
    agents::AgentManager, contracts::*, repositories, reviews, snapshots, storage::Storage,
};
use std::{
    collections::BTreeMap,
    process::Stdio,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};
use tauri::ipc::Channel;
use tokio::io::{AsyncRead, AsyncReadExt};

pub fn prepare(storage: &Storage, review_id: &str, command: Vec<String>) -> AppResult<TestRun> {
    if command.is_empty()
        || command.len() > 100
        || command.iter().any(|s| s.contains('\0') || s.len() > 8192)
    {
        return Err(AppError::new(
            "invalid_command",
            "Provide an executable and bounded argument list.",
        ));
    }
    let w = reviews::load(storage, review_id)?;
    let run = TestRun {
        id: id(),
        review_id: review_id.into(),
        snapshot_id: w.snapshot.id,
        cwd: repositories::root(storage, &w.review.repository_id)?
            .to_string_lossy()
            .into(),
        command,
        status: "awaiting_permission".into(),
        output: String::new(),
        exit_code: None,
        started_at: None,
        finished_at: None,
        before_fingerprint: None,
        after_fingerprint: None,
        snapshot_matches: false,
    };
    storage.insert("test_run", &run.id, &run)?;
    Ok(run)
}
async fn drain(mut input: impl AsyncRead + Unpin, sender: tokio::sync::mpsc::Sender<String>) {
    let mut buffer = [0; 4096];
    loop {
        match input.read(&mut buffer).await {
            Ok(0) | Err(_) => break,
            Ok(count) => {
                if sender
                    .send(String::from_utf8_lossy(&buffer[..count]).into())
                    .await
                    .is_err()
                {
                    break;
                }
            }
        }
    }
}
pub async fn run(
    storage: Storage,
    id: String,
    approved: bool,
    cancel: Arc<AtomicBool>,
    channel: Channel<AgentEvent>,
) -> AppResult<TestRun> {
    let mut run: TestRun = storage.get("test_run", &id)?;
    if run.status != "awaiting_permission" {
        return Err(AppError::new(
            "permission_consumed",
            "This permission request was already answered.",
        ));
    }
    run.status = if approved { "running" } else { "declined" }.into();
    storage.replace("test_run", &id, 0, &run)?;
    if !approved {
        return Ok(run);
    }
    let result = execute(&storage, &mut run, cancel, channel).await;
    if let Err(error) = &result {
        run.status = "failed".into();
        run.output.push_str(&format!("\n{}", error.message));
    }
    run.finished_at = Some(now());
    storage.replace("test_run", &id, 1, &run)?;
    result.map(|()| run)
}
async fn execute(
    storage: &Storage,
    run: &mut TestRun,
    cancel: Arc<AtomicBool>,
    channel: Channel<AgentEvent>,
) -> AppResult<()> {
    let snapshot: Snapshot = storage.get("snapshot", &run.snapshot_id)?;
    let root = repositories::root(storage, &snapshot.repository_id)?;
    if root.to_string_lossy() != run.cwd {
        return Err(AppError::new(
            "repository_moved",
            "The approved working directory changed.",
        ));
    }
    use notify::Watcher;
    let touched = Arc::new(AtomicBool::new(false));
    let flag = touched.clone();
    let tracked: Vec<_> = snapshot.files.iter().map(|f| root.join(&f.path)).collect();
    let mut watcher =
        notify::recommended_watcher(move |event: notify::Result<notify::Event>| match event {
            Ok(event)
                if !event.kind.is_access()
                    && event.paths.iter().any(|path| {
                        tracked
                            .iter()
                            .any(|file| file == path || file.starts_with(path))
                    }) =>
            {
                flag.store(true, Ordering::Relaxed);
            }
            Err(_) => flag.store(true, Ordering::Relaxed),
            _ => {}
        })
        .map_err(|e| AppError::new("watcher", e.to_string()))?;
    watcher
        .watch(&root, notify::RecursiveMode::Recursive)
        .map_err(|e| AppError::new("watcher", e.to_string()))?;
    let store = storage.clone();
    let path = root.clone();
    let include = snapshot.request.include_untracked;
    let before = tauri::async_runtime::spawn_blocking(move || {
        snapshots::workspace_fingerprint(&store, &path, include)
    })
    .await
    .map_err(|_| AppError::new("task", "Fingerprint task failed."))??;
    run.before_fingerprint = Some(before.clone());
    run.started_at = Some(now());
    let mut command = tokio::process::Command::new(&run.command[0]);
    command
        .args(&run.command[1..])
        .current_dir(&root)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    #[cfg(unix)]
    command.process_group(0);
    let mut child = command.spawn()?;
    let group = crate::processes::ProcessGroup::new(
        child
            .id()
            .ok_or_else(|| AppError::new("process", "Missing process ID."))?,
    );
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| AppError::new("process", "Missing test output."))?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| AppError::new("process", "Missing test errors."))?;
    let (sender, mut receiver) = tokio::sync::mpsc::channel(32);
    let out = tauri::async_runtime::spawn(drain(stdout, sender.clone()));
    let err = tauri::async_runtime::spawn(drain(stderr, sender));
    let mut sequence = 0;
    let deadline = tokio::time::Instant::now() + Duration::from_secs(600);
    let mut truncated = false;
    loop {
        if cancel.load(Ordering::Relaxed) || tokio::time::Instant::now() > deadline {
            run.status = if cancel.load(Ordering::Relaxed) {
                "cancelled"
            } else {
                "timed_out"
            }
            .into();
            break;
        }
        if let Ok(Some(chunk)) =
            tokio::time::timeout(Duration::from_millis(100), receiver.recv()).await
        {
            if run.output.len() + chunk.len() <= 2 * 1024 * 1024 {
                run.output.push_str(&chunk);
                sequence += 1;
                if channel
                    .send(AgentEvent {
                        run_id: run.id.clone(),
                        sequence,
                        kind: "delta".into(),
                        text: chunk,
                        progress: None,
                    })
                    .is_err()
                {
                    run.status = "cancelled".into();
                    break;
                }
            } else {
                truncated = true;
            }
        }
        if let Some(status) = child.try_wait()? {
            run.exit_code = status.code();
            run.status = "observed".into();
            break;
        }
    }
    group.terminate();
    let _ = child.kill().await;
    let _ = child.wait().await;
    while let Ok(Some(chunk)) =
        tokio::time::timeout(Duration::from_millis(500), receiver.recv()).await
    {
        if run.output.len() + chunk.len() <= 2 * 1024 * 1024 {
            run.output.push_str(&chunk);
        } else {
            truncated = true;
        }
    }
    out.abort();
    err.abort();
    if truncated {
        run.output.push_str("\n[Output truncated at 2 MiB]\n");
    }
    let store = storage.clone();
    let path = root;
    let after = tauri::async_runtime::spawn_blocking(move || {
        snapshots::workspace_fingerprint(&store, &path, include)
    })
    .await
    .map_err(|_| AppError::new("task", "Fingerprint task failed."))??;
    let tree: BTreeMap<_, _> = snapshot
        .files
        .iter()
        .map(|f| (&f.path, &f.content))
        .collect();
    let target = fingerprint(&serde_json::to_vec(&tree)?);
    // Equality covers captured source files; dependencies and ignored inputs are not proven.
    // Let the native watcher flush its coalesced events before classifying the run.
    tokio::time::sleep(Duration::from_millis(300)).await;
    run.snapshot_matches = before == after && after == target && !touched.load(Ordering::Relaxed);
    run.after_fingerprint = Some(after);
    Ok(())
}
pub fn cancel(manager: &AgentManager, id: &str) -> AppResult<()> {
    manager.cancel(id)
}
