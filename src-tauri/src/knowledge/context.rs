use crate::{contracts::*, snapshots, storage::Storage};
use tauri::State;

/// Contexts are temporary; history belongs to the project, including after
/// closing the view or freezing a newer version of its sources.
pub(crate) fn history(storage: &Storage, context_id: &str) -> AppResult<Vec<AgentRun>> {
    let context = storage.source_context(context_id)?;
    Ok(storage
        .list::<AgentRun>("agent_run")?
        .into_iter()
        .filter(|run| {
            run.context_id.is_some() && run.repository_id.as_deref() == Some(&context.repository_id)
        })
        .collect())
}

pub(crate) fn proposals(storage: &Storage, context_id: &str) -> AppResult<Vec<Proposal>> {
    let runs: std::collections::BTreeSet<_> = history(storage, context_id)?
        .into_iter()
        .map(|r| r.id)
        .collect();
    Ok(storage
        .list::<Proposal>("knowledge_proposal")?
        .into_iter()
        .filter(|proposal| proposal.run_id.as_ref().is_some_and(|id| runs.contains(id)))
        .collect())
}

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
