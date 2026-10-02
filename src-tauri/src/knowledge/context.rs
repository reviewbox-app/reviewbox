use crate::{contracts::*, snapshots, storage::Storage};
use tauri::State;

#[tauri::command]
pub async fn code_explain_context(
    storage: State<'_, Storage>,
    repository_id: String,
    current: Option<String>,
) -> AppResult<Snapshot> {
    let storage = storage.scoped(Some(&repository_id));
    let _ = current; // Existing native clients may still send this field.
    tauri::async_runtime::spawn_blocking(move || load(&storage, repository_id))
        .await
        .map_err(|e| AppError::new("task", e.to_string()))?
}
pub(crate) fn load(storage: &Storage, repository_id: String) -> AppResult<Snapshot> {
    let _pin = storage.pin_source_cache();
    let root = crate::repositories::root(storage, &repository_id)?;
    let entry = storage.repository_cache.entry(storage, &root)?;
    let mut data = entry.data.lock().unwrap_or_else(|e| e.into_inner());
    entry.refresh(&root, &mut data)?;
    if data.context_fingerprint == data.fingerprint
        && let Some(snapshot) = &data.context
    {
        return Ok(snapshot.clone());
    }
    let version = data.fingerprint.clone();
    let mut snapshot = snapshots::prepare_capture_cached(
        storage,
        CaptureRequest {
            repository_id,
            scope: Scope::Local,
            base: None,
            target: None,
            include_untracked: true,
        },
        &mut |_, _, _, _| Ok(()),
        &mut data.sources,
        true,
    )?;
    snapshot.id = format!("source-{}", id());
    if crate::repository_cache::inventory_fingerprint(&root)? != version {
        data.sources.working.clear();
        return Err(AppError::new(
            "capture_changed",
            "The repository changed during capture. Please retry.",
        ));
    }
    storage.store_context(&snapshot)?;
    let hashes: std::collections::BTreeSet<_> = crate::reader::sources(&snapshot)
        .into_iter()
        .map(|s| s.hash)
        .chain(snapshot.files.iter().map(|f| f.content.hash.clone()))
        .collect();
    data.sources
        .objects
        .retain(|_, blob| hashes.contains(&blob.hash));
    data.sources
        .working
        .retain(|_, (_, blob)| hashes.contains(&blob.hash));
    let previous = data.context.replace(snapshot.clone());
    data.context_fingerprint = version;
    if let Some(previous) = previous {
        data.retired_contexts.push(previous);
    }
    // Keep the displayed context alive until the WebView acknowledges replacement.
    // Bound abandoned clients; active readers/agents still retain their leases.
    while data.retired_contexts.len() > 2 {
        let old = data.retired_contexts.remove(0);
        storage.release_context(&old.id)?;
    }
    Ok(snapshot)
}

#[tauri::command]
pub async fn release_code_context(
    storage: State<'_, Storage>,
    repository_id: String,
    context_id: String,
) -> AppResult<()> {
    let storage = storage.scoped(Some(&repository_id));
    tauri::async_runtime::spawn_blocking(move || {
        let root = crate::repositories::root(&storage, &repository_id)?;
        let entry = storage.repository_cache.entry(&storage, &root)?;
        let mut data = entry.data.lock().unwrap_or_else(|e| e.into_inner());
        if data.context.as_ref().is_some_and(|s| s.id == context_id) {
            return Ok(());
        }
        data.retired_contexts.retain(|s| s.id != context_id);
        storage.release_context(&context_id)
    })
    .await
    .map_err(|e| AppError::new("task", e.to_string()))?
}
