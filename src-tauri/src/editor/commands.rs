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
}

#[tauri::command]
pub async fn editor_search_content(
    storage: State<'_, Storage>,
    state: State<'_, EditorState>,
    repository_id: String,
    query: String,
    request_id: String,
) -> AppResult<EditorSearchResult> {
    state
        .searches
        .search(storage.inner().clone(), repository_id, query, request_id)
        .await
}

#[tauri::command]
pub fn editor_cancel_search(state: State<'_, EditorState>, request_id: String) {
    state.searches.cancel(&request_id);
}

#[tauri::command]
pub async fn editor_inventory(
    storage: State<'_, Storage>,
    repository_id: String,
    show_ignored: bool,
) -> AppResult<Vec<EditorEntry>> {
    let storage = storage.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let root = crate::repositories::root(&storage, &repository_id)?;
        storage.repository_cache.entry(&storage, &root)?;
        inventory(&root, show_ignored)
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
    live.changed(&changed_root, &notice).await;
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
pub fn editor_dirty(state: State<'_, EditorState>, dirty: bool) {
    state.dirty.store(dirty, Ordering::SeqCst);
}
#[tauri::command]
pub fn editor_exit(app: tauri::AppHandle, state: State<'_, EditorState>) {
    state.allow_exit.store(true, Ordering::SeqCst);
    app.exit(0);
}
pub(crate) fn confirm_exit(app: &tauri::AppHandle) -> bool {
    use tauri::Manager;
    let state = app.state::<EditorState>();
    if state.dirty.load(Ordering::SeqCst) && !state.allow_exit.load(Ordering::SeqCst) {
        if let Some(window) = app.get_webview_window("main") {
            let _ = window.show();
            let _ = window.set_focus();
        }
        let _ = app.emit("reviewbox:editor-confirm-exit", ());
        true
    } else {
        false
    }
}
