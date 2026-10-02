use crate::{contracts::*, snapshots, storage::Storage};
use tauri::State;

#[tauri::command]
pub async fn code_explain_context(
    storage: State<'_, Storage>,
    repository_id: String,
    current: Option<String>,
) -> AppResult<Snapshot> {
    let storage = storage.scoped(Some(&repository_id));
    tauri::async_runtime::spawn_blocking(move || {
        let _pin = storage.pin_source_cache();
        if let Some(current) = current
            && let Ok(snapshot) = storage.source_context(&current)
            && !snapshots::repository_changed(&storage, &snapshot)?
        {
            return Ok(snapshot);
        }
        let mut snapshot = snapshots::prepare_capture(
            &storage,
            CaptureRequest {
                repository_id,
                scope: Scope::Local,
                base: None,
                target: None,
                include_untracked: true,
            },
            &mut |_, _, _, _| Ok(()),
        )?;
        snapshot.id = format!("source-{}", id());
        storage.store_context(&snapshot)?;
        Ok(snapshot)
    })
    .await
    .map_err(|e| AppError::new("task", e.to_string()))?
}
#[tauri::command]
pub async fn release_code_context(
    storage: State<'_, Storage>,
    repository_id: String,
    context_id: String,
) -> AppResult<()> {
    let storage = storage.scoped(Some(&repository_id));
    tauri::async_runtime::spawn_blocking(move || storage.release_context(&context_id))
        .await
        .map_err(|e| AppError::new("task", e.to_string()))?
}
