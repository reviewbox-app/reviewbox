use super::{SourceControl, commits, history, working};
use crate::{contracts::*, repositories, storage::Storage};
use tauri::{State, ipc::Channel};

async fn blocking<T: Send + 'static>(
    work: impl FnOnce() -> AppResult<T> + Send + 'static,
) -> AppResult<T> {
    tauri::async_runtime::spawn_blocking(work)
        .await
        .map_err(|e| AppError::new("task", e.to_string()))?
}

#[tauri::command]
pub async fn local_git_state(
    storage: State<'_, Storage>,
    manager: State<'_, SourceControl>,
    repository_id: String,
) -> AppResult<LocalGitState> {
    let root = repositories::root(&storage, &repository_id)?;
    let manager = manager.inner().clone();
    blocking(move || history::state(&manager, &root, &repository_id)).await
}
#[tauri::command]
pub async fn local_file_diff(
    storage: State<'_, Storage>,
    repository_id: String,
    path: String,
    layer: String,
    version: String,
) -> AppResult<LocalFileDiff> {
    let root = repositories::root(&storage, &repository_id)?;
    blocking(move || working::diff(&root, &path, &layer, &version)).await
}
#[tauri::command]
pub async fn stage_local_file(
    storage: State<'_, Storage>,
    manager: State<'_, SourceControl>,
    repository_id: String,
    path: String,
    version: String,
    staged: bool,
) -> AppResult<LocalGitState> {
    let root = repositories::root(&storage, &repository_id)?;
    let _invalidation = storage.repository_cache.mutation(&root);
    let manager = manager.inner().clone();
    blocking(move || {
        let operation = manager.begin(&root, &id())?;
        working::stage(&root, &path, &version, staged, &operation.cancel)?;
        history::state(&manager, &root, &repository_id)
    })
    .await
}
#[tauri::command]
pub async fn git_commit_detail(
    storage: State<'_, Storage>,
    repository_id: String,
    oid: String,
) -> AppResult<GitCommitDetail> {
    let root = repositories::root(&storage, &repository_id)?;
    blocking(move || history::detail(&root, &oid)).await
}
#[tauri::command]
pub async fn fetch_git_remote(
    storage: State<'_, Storage>,
    manager: State<'_, SourceControl>,
    repository_id: String,
    force: bool,
) -> AppResult<LocalGitState> {
    let root = repositories::root(&storage, &repository_id)?;
    let _invalidation = storage.repository_cache.mutation(&root);
    let manager = manager.inner().clone();
    blocking(move || {
        let operation = manager.begin(&root, &id())?;
        let _ = history::fetch(&manager, &root, force, &operation.cancel);
        history::state(&manager, &root, &repository_id)
    })
    .await
}
#[tauri::command]
pub async fn push_git_branch(
    storage: State<'_, Storage>,
    manager: State<'_, SourceControl>,
    repository_id: String,
    branch: String,
    remote: Option<String>,
) -> AppResult<LocalGitState> {
    let root = repositories::root(&storage, &repository_id)?;
    let _invalidation = storage.repository_cache.mutation(&root);
    let manager = manager.inner().clone();
    blocking(move || {
        let operation = manager.begin(&root, &id())?;
        history::push(
            &manager,
            &root,
            &branch,
            remote.as_deref(),
            &operation.cancel,
        )?;
        history::state(&manager, &root, &repository_id)
    })
    .await
}
#[tauri::command]
pub async fn commit_local_changes(
    app: tauri::AppHandle,
    storage: State<'_, Storage>,
    manager: State<'_, SourceControl>,
    request: GitCommitRequest,
    channel: Channel<GitOperation>,
    activity: Channel<AgentEvent>,
) -> AppResult<GitOperation> {
    let s = storage.scoped(Some(&request.repository_id));
    let root = repositories::root(&s, &request.repository_id)?;
    let _invalidation = storage.repository_cache.mutation(&root);
    let operation = manager.begin(&root, &request.operation_id)?;
    let reading_root = root.clone();
    let expected = request.index_version.clone();
    let frozen = blocking(move || commits::freeze(&reading_root, &expected)).await?;
    let batches = if let Some(message) = &request.message {
        vec![commits::Batch {
            message: message.clone(),
            paths: frozen.files.iter().map(|f| f.path.clone()).collect(),
        }]
    } else {
        let _ = channel.send(GitOperation {
            id: request.operation_id.clone(),
            repository_id: request.repository_id.clone(),
            status: "running".into(),
            message: "Rev is organizing the staged changes…".into(),
            commits: vec![],
            error: None,
        });
        let resources = crate::commands::resource_root(&app)?;
        let text = crate::agents::commit::plan(
            &s,
            &root,
            &resources,
            &request,
            frozen.context.clone(),
            operation.cancel.clone(),
            activity,
        )
        .await?;
        commits::plan(&text, &frozen)?
    };
    blocking(move || {
        let result = commits::execute(
            &s,
            &root,
            &request,
            &frozen,
            batches,
            &operation.cancel,
            |state| {
                let _ = channel.send(state.clone());
            },
        );
        drop(operation);
        result
    })
    .await
}
#[tauri::command]
pub fn cancel_git_operation(manager: State<'_, SourceControl>, operation_id: String) {
    manager.cancel(&operation_id)
}
#[tauri::command]
pub async fn last_git_operation(
    storage: State<'_, Storage>,
    manager: State<'_, SourceControl>,
    repository_id: String,
) -> AppResult<Option<GitOperation>> {
    let root = repositories::root(&storage, &repository_id)?;
    // Recovery must not classify an active operation as interrupted.
    if manager
        .active
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .contains_key(&root.to_string_lossy().to_string())
    {
        return Ok(None);
    }
    let s = storage.inner().clone();
    blocking(move || commits::last(&s, &repository_id)).await
}

#[tauri::command]
pub async fn stage_local_files(
    storage: State<'_, Storage>,
    manager: State<'_, SourceControl>,
    repository_id: String,
    files: Vec<LocalFileSelection>,
    staged: bool,
) -> AppResult<LocalGitState> {
    let root = repositories::root(&storage, &repository_id)?;
    let _invalidation = storage.repository_cache.mutation(&root);
    let manager = manager.inner().clone();
    blocking(move || {
        let operation = manager.begin(&root, &id())?;
        working::stage_files(&root, &files, staged, &operation.cancel)?;
        history::state(&manager, &root, &repository_id)
    })
    .await
}

#[tauri::command]
pub async fn reveal_local_path(
    storage: State<'_, Storage>,
    repository_id: String,
    path: String,
) -> AppResult<()> {
    let root = repositories::root(&storage, &repository_id)?;
    blocking(move || {
        crate::snapshots::safe_path(&path)?;
        let mut location = root.join(path);
        // Deleted paths reveal their nearest existing parent.
        while !location.exists() {
            if !location.pop() {
                return Err(AppError::new("path", "No existing parent."));
            }
        }
        if !location.canonicalize()?.starts_with(root.canonicalize()?) {
            return Err(AppError::new("unsafe_path", "Path leaves this repository."));
        }
        #[cfg(target_os = "macos")]
        let result = std::process::Command::new("open")
            .arg("-R")
            .arg(&location)
            .status()?;
        #[cfg(target_os = "windows")]
        let result = std::process::Command::new("explorer")
            .arg(format!("/select,{}", location.display()))
            .status()?;
        #[cfg(all(unix, not(target_os = "macos")))]
        let result = std::process::Command::new("xdg-open")
            .arg(if location.is_dir() {
                location.as_path()
            } else {
                location.parent().unwrap_or(&root)
            })
            .status()?;
        if !result.success() {
            return Err(AppError::new(
                "reveal_failed",
                "The file manager could not reveal this path.",
            ));
        }
        Ok(())
    })
    .await
}

#[tauri::command]
pub async fn discard_local_files(
    storage: State<'_, Storage>,
    manager: State<'_, SourceControl>,
    repository_id: String,
    files: Vec<LocalFileSelection>,
) -> AppResult<LocalGitState> {
    let root = repositories::root(&storage, &repository_id)?;
    let _invalidation = storage.repository_cache.mutation(&root);
    let manager = manager.inner().clone();
    blocking(move || {
        let operation = manager.begin(&root, &id())?;
        working::discard_files(&root, &files, &operation.cancel)?;
        history::state(&manager, &root, &repository_id)
    })
    .await
}
