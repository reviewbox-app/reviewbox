use crate::{contracts::*, repositories, repository_cache::Request, storage::Storage};

pub(crate) fn read(
    storage: &Storage,
    request: CaptureRequest,
    details: bool,
    task: &Request,
) -> AppResult<ReviewPreview> {
    let cache = &storage.repository_cache;
    task.check()?;
    let root = repositories::root(storage, &request.repository_id)?;
    let entry = cache.entry(storage, &root)?;
    let mut data = entry.data.lock().unwrap_or_else(|e| e.into_inner());
    task.check()?;
    entry.refresh(&root, &mut data)?;

    let mut normalized = request.clone();
    if !matches!(request.scope, Scope::Commit | Scope::Range) {
        normalized.base = None;
        normalized.target = None;
    }
    let key = format!("{}:{details}", serde_json::to_string(&normalized)?);
    if let Some(value) = data.previews.get(&key) {
        return Ok(value.clone());
    }
    let version = data.fingerprint.clone();
    let mut value = super::preview_selected(
        storage,
        &request,
        details,
        &|| task.check(),
        &mut data.statistics,
    )?;
    task.check()?;
    if crate::repository_cache::inventory_fingerprint(&root)? != version {
        return Err(AppError::new(
            "capture_changed",
            "The repository changed while counting. Please retry.",
        ));
    }
    if data.previews.len() >= 32 {
        data.previews.clear();
    }
    value.revision = version;
    data.previews.insert(key, value.clone());
    if details {
        data.previews.insert(
            format!("{}:false", serde_json::to_string(&normalized)?),
            value.clone(),
        );
    }
    Ok(value)
}
