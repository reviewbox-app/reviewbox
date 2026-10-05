use super::*;
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicBool, Ordering},
};
use tauri::{Emitter, State};

#[derive(Default, Clone)]
pub struct EditorState {
    pub mutation: Arc<Mutex<()>>,
    pub dirty: Arc<AtomicBool>,
    pub allow_exit: Arc<AtomicBool>,
    pub(crate) searches: super::search::SearchState,
    inventories: Arc<Mutex<super::inventory::Inventories>>,
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn editor_search_content(
    storage: State<'_, Storage>,
    state: State<'_, EditorState>,
    repository_id: String,
    owner: String,
    query: String,
    request_id: String,
    buffers: Vec<EditorSearchBuffer>,
    paths: Option<Vec<String>>,
    on_batch: tauri::ipc::Channel<EditorSearchBatch>,
) -> AppResult<EditorSearchResult> {
    state
        .searches
        .search(
            storage.inner().clone(),
            repository_id,
            owner,
            query,
            request_id,
            buffers,
            paths,
            Arc::new(move |batch| on_batch.send(batch).is_ok()),
        )
        .await
}
#[tauri::command]
pub fn editor_cancel_search(
    state: State<'_, EditorState>,
    owner: String,
    repository_id: String,
    request_id: String,
) {
    state.searches.cancel(owner, repository_id, request_id);
}

#[tauri::command]
pub async fn editor_watch(
    storage: State<'_, Storage>,
    repository_id: String,
    owner: String,
    release: bool,
) -> AppResult<EditorWatchStatus> {
    let storage = storage.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let root = crate::repositories::root(&storage, &repository_id)?;
        if release {
            Ok(storage.repository_cache.release_lease(&root, &owner))
        } else {
            storage.repository_cache.lease(&storage, &root, &owner)
        }
    })
    .await
    .map_err(|e| AppError::new("watch_task", e.to_string()))?
}
#[tauri::command]
pub async fn editor_watch_status(
    storage: State<'_, Storage>,
    repository_id: String,
) -> AppResult<EditorWatchStatus> {
    let storage = storage.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let root = crate::repositories::root(&storage, &repository_id)?;
        storage.repository_cache.watch_status(&storage, &root)
    })
    .await
    .map_err(|e| AppError::new("watch_task", e.to_string()))?
}
#[tauri::command]
pub async fn editor_inventory(
    storage: State<'_, Storage>,
    state: State<'_, EditorState>,
    repository_id: String,
    show_ignored: bool,
    expanded_paths: Option<Vec<String>>,
    change: Option<RepositoryReadChange>,
) -> AppResult<Vec<EditorEntry>> {
    let storage = storage.inner().clone();
    let inventories = state.inventories.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let root = crate::repositories::root(&storage, &repository_id)?;
        let watch = storage.repository_cache.watch_status(&storage, &root)?;
        inventories
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .snapshot(
                &root,
                show_ignored,
                &expanded_paths.unwrap_or_default(),
                change.as_ref(),
                Some(&watch),
            )
    })
    .await
    .map_err(|e| AppError::new("task", e.to_string()))?
}
#[tauri::command]
pub async fn editor_read(
    storage: State<'_, Storage>,
    repository_id: String,
    path: String,
) -> AppResult<EditorFile> {
    let storage = storage.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        read(&crate::repositories::root(&storage, &repository_id)?, &path)
    })
    .await
    .map_err(|e| AppError::new("task", e.to_string()))?
}
#[tauri::command]
pub async fn editor_revision(
    storage: State<'_, Storage>,
    repository_id: String,
    path: String,
) -> AppResult<String> {
    let storage = storage.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        revision(&super::path(
            &crate::repositories::root(&storage, &repository_id)?,
            &path,
        )?)
    })
    .await
    .map_err(|e| AppError::new("task", e.to_string()))?
}
#[tauri::command]
pub async fn editor_mutate(
    storage: State<'_, Storage>,
    state: State<'_, EditorState>,
    live: State<'_, crate::language_servers::live::LiveLanguages>,
    repository_id: String,
    mutation: EditorMutation,
) -> AppResult<()> {
    let storage = storage.inner().clone();
    let state = state.inner().clone();
    let notice = mutation.clone();
    let root = crate::repositories::root(&storage, &repository_id)?;
    let changed_root = root.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = state.mutation.lock().unwrap_or_else(|e| e.into_inner());
        mutate(&root, mutation.clone())?;
        storage
            .repository_cache
            .notify_editor_mutation(&root, &mutation);
        Ok::<(), AppError>(())
    })
    .await
    .map_err(|e| AppError::new("task", e.to_string()))??;
    let source_mutation = match &notice {
        EditorMutation::Rename {
            path, destination, ..
        } => !super::metadata_path(path) || !super::metadata_path(destination),
        EditorMutation::Save { path, .. }
        | EditorMutation::Create { path, .. }
        | EditorMutation::Trash { path, .. } => !super::metadata_path(path),
    };
    if source_mutation {
        live.changed(&changed_root, &notice).await;
    }
    Ok(())
}
#[tauri::command]
pub fn editor_recovery(
    storage: State<'_, Storage>,
    repository_id: String,
) -> AppResult<EditorRecovery> {
    recovery(&storage, &repository_id)
}
#[tauri::command]
pub fn editor_store_recovery(
    storage: State<'_, Storage>,
    state: State<'_, EditorState>,
    repository_id: String,
    mut recovery: EditorRecovery,
) -> AppResult<EditorRecovery> {
    let _guard = state.mutation.lock().unwrap_or_else(|e| e.into_inner());
    let root = crate::repositories::root(&storage, &repository_id)?;
    for draft in &recovery.drafts {
        super::path(&root, &draft.path)?;
        if draft.text.len() as u64 > MAX_TEXT {
            return Err(AppError::new(
                "file_size",
                "Draft exceeds the editor limit.",
            ));
        }
    }
    let previous = super::recovery(&storage, &repository_id)?;
    if recovery.revision != previous.revision {
        return Err(AppError::new(
            "stale_recovery",
            "Draft storage changed in another window. Reload the editor before replacing it.",
        ));
    }
    if storage
        .get::<EditorRecovery>("editor_recovery", &repository_id)
        .is_ok()
    {
        recovery.revision = previous.revision + 1;
        storage.replace(
            "editor_recovery",
            &repository_id,
            previous.revision,
            &recovery,
        )?;
    } else {
        storage.insert("editor_recovery", &repository_id, &recovery)?;
    }
    Ok(recovery)
}
#[tauri::command]
pub fn editor_navigation(
    storage: State<'_, Storage>,
    repository_id: String,
) -> AppResult<CheckoutNavigation> {
    crate::repositories::root(&storage, &repository_id)?;
    match storage.get("checkout_navigation", &repository_id) {
        Ok(value) => Ok(value),
        Err(error) if error.code == "not_found" => Ok(CheckoutNavigation::default()),
        Err(error) => Err(error),
    }
}

#[tauri::command]
pub fn editor_store_navigation(
    storage: State<'_, Storage>,
    state: State<'_, EditorState>,
    repository_id: String,
    navigation: CheckoutNavigation,
) -> AppResult<CheckoutNavigation> {
    store_navigation(&storage, &state, &repository_id, navigation)
}

pub(crate) fn store_navigation(
    storage: &Storage,
    state: &EditorState,
    repository_id: &str,
    mut navigation: CheckoutNavigation,
) -> AppResult<CheckoutNavigation> {
    let _guard = state.mutation.lock().unwrap_or_else(|e| e.into_inner());
    let root = crate::repositories::root(storage, repository_id)?;
    if navigation.trees.len() > 128 {
        return Err(AppError::new(
            "navigation_limit",
            "Too many saved file trees.",
        ));
    }
    for (key, tree) in &navigation.trees {
        if key.len() > 160
            || tree.expanded_paths.len() > 10_000
            || !tree.scroll_top.is_finite()
            || tree.scroll_top < 0.0
            || !matches!(tree.mode.as_str(), "all" | "changes")
        {
            return Err(AppError::new("navigation", "Invalid file tree state."));
        }
        for relative in tree.expanded_paths.iter().chain(tree.selected_path.iter()) {
            super::path(&root, relative)?;
        }
    }
    let previous: Option<CheckoutNavigation> =
        match storage.get("checkout_navigation", repository_id) {
            Ok(value) => Some(value),
            Err(error) if error.code == "not_found" => None,
            Err(error) => return Err(error),
        };
    if navigation.revision != previous.as_ref().map_or(0, |v| v.revision) {
        return Err(AppError::new(
            "stale_navigation",
            "Navigation changed in another window.",
        ));
    }
    if let Some(previous) = previous {
        navigation.revision = previous.revision + 1;
        storage.replace(
            "checkout_navigation",
            repository_id,
            previous.revision,
            &navigation,
        )?;
    } else {
        storage.insert("checkout_navigation", repository_id, &navigation)?;
    }
    Ok(navigation)
}

#[tauri::command]
pub fn editor_dirty(state: State<'_, EditorState>, dirty: bool) {
    state.dirty.store(dirty, Ordering::SeqCst);
}
#[tauri::command]
pub async fn editor_exit(app: tauri::AppHandle, state: State<'_, EditorState>) -> AppResult<()> {
    use tauri::Manager;
    let handle = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        handle.state::<crate::terminals::Terminals>().stop_all()
    })
    .await
    .map_err(|error| AppError::new("terminal_shutdown", error.to_string()))?;
    state.allow_exit.store(true, Ordering::SeqCst);
    app.exit(0);
    Ok(())
}
pub(crate) fn confirm_exit(app: &tauri::AppHandle) -> bool {
    use tauri::Manager;
    let state = app.state::<EditorState>();
    let terminals = app.state::<crate::terminals::Terminals>().active_count();
    if (state.dirty.load(Ordering::SeqCst) || terminals > 0)
        && !state.allow_exit.load(Ordering::SeqCst)
    {
        if let Some(window) = app.get_webview_window("main") {
            let _ = window.show();
            let _ = window.set_focus();
        }
        let _ = app.emit("reviewbox:editor-confirm-exit", terminals);
        true
    } else {
        false
    }
}
