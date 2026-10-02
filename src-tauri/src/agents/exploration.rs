use super::*;
use serde_json::json;
use std::{fs, path::Path};

#[derive(Clone)]
pub(super) struct ExplorationRequest {
    pub id: String,
    pub paths: Vec<String>,
}

/// Only discovery metadata is temporary. Frozen bytes stay in the existing
/// content-addressed cache; the harness runs in the real repository.
pub(super) struct Exploration {
    pub project: PathBuf,
    directory: PathBuf,
}
impl Drop for Exploration {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.directory);
    }
}

fn directory(storage: &Storage, request: &ExplorationRequest) -> PathBuf {
    storage
        .root()
        .join("agent-context")
        .join(fingerprint(request.id.as_bytes()))
}

pub(super) fn descriptor(
    storage: &Storage,
    workspace: &Workspace,
    request: &ExplorationRequest,
) -> AppResult<String> {
    descriptor_for(
        storage,
        &workspace.snapshot,
        Some(&workspace.review),
        request,
    )
}
pub(super) fn descriptor_for(
    storage: &Storage,
    snapshot: &Snapshot,
    review: Option<&Review>,
    request: &ExplorationRequest,
) -> AppResult<String> {
    let repository: Repository = storage.get("repository", &snapshot.repository_id)?;
    Ok(serde_json::to_string_pretty(&json!({
        "projectRoot": repository.path,
        "reviewId": review.map(|r| &r.id),
        "snapshotId": snapshot.id,
        "reviewManifest": directory(storage, request).join("manifest.json"),
        "focusPaths": request.paths,
    }))?)
}

fn frozen_content(storage: &Storage, blob: &Option<BlobRef>) -> Value {
    let Some(blob) = blob else {
        return Value::Null;
    };
    match storage.read_blob(&blob.hash) {
        Ok(bytes) => json!({
            "path": storage.root().join("blobs").join(&blob.hash),
            "hash": blob.hash,
            "size": blob.size,
            "mode": blob.mode,
            "binary": bytes.contains(&0) || std::str::from_utf8(&bytes).is_err(),
        }),
        Err(error) => json!({"hash":blob.hash,"unavailable":error.message}),
    }
}

fn write(path: &Path, value: &Value) -> AppResult<()> {
    fs::write(path, serde_json::to_vec_pretty(value)?)?;
    Ok(())
}

pub(super) fn materialize(
    storage: &Storage,
    workspace: &Workspace,
    request: &ExplorationRequest,
    cancel: &AtomicBool,
) -> AppResult<Exploration> {
    materialize_for(
        storage,
        &workspace.snapshot,
        Some(&workspace.review),
        request,
        cancel,
    )
}
pub(super) fn materialize_for(
    storage: &Storage,
    snapshot: &Snapshot,
    review: Option<&Review>,
    request: &ExplorationRequest,
    cancel: &AtomicBool,
) -> AppResult<Exploration> {
    let repository: Repository = storage.get("repository", &snapshot.repository_id)?;
    let directory = directory(storage, request);
    fs::create_dir_all(directory.parent().unwrap())?;
    // A running operation owns this directory exclusively. Never replace a
    // previously prepared operation or let a request ID escape the cache.
    fs::create_dir(&directory)?;
    let exploration = Exploration {
        project: PathBuf::from(repository.path),
        directory,
    };
    write(
        &exploration.directory.join("review.json"),
        &serde_json::to_value(review)?,
    )?;
    fs::create_dir(exploration.directory.join("changes"))?;
    let mut changes = Vec::new();
    for (index, change) in snapshot.changes.iter().enumerate() {
        if cancel.load(Ordering::Relaxed) {
            return Err(AppError::new("cancelled", "Agent request stopped."));
        }
        let metadata = exploration
            .directory
            .join("changes")
            .join(format!("{index}.json"));
        let anchors: Vec<_> = change
            .passages
            .iter()
            .map(|passage| CodeAnchor {
                snapshot_id: snapshot.id.clone(),
                change_id: change.id.clone(),
                passage_id: passage.id.clone(),
            })
            .collect();
        let sensitive =
            excluded(&change.path) || change.previous_path.as_deref().is_some_and(excluded);
        write(
            &metadata,
            &json!({
                "change": change,
                "anchors": anchors,
                "before": if sensitive { Value::Null } else { frozen_content(storage, &change.before) },
                "after": if sensitive { Value::Null } else { frozen_content(storage, &change.after) },
                "sensitive": sensitive,
            }),
        )?;
        changes.push(json!({"path":change.path,"layer":change.layer,"metadata":metadata}));
    }
    let focus: Vec<_> = snapshot
        .files
        .iter()
        .filter(|file| request.paths.contains(&file.path))
        .map(|file| {
            json!({
                "path": file.path,
                "content": if excluded(&file.path) { Value::Null }
                    else { frozen_content(storage, &Some(file.content.clone())) },
            })
        })
        .collect();
    let sources = {
        crate::reader::sources(snapshot)
            .into_iter()
            .map(|source| {
                if cancel.load(Ordering::Relaxed) {
                    return Err(AppError::new("cancelled", "Preparation stopped."));
                }
                let mut value = serde_json::to_value(&source)?;
                if excluded(&source.path) {
                    value["unavailable"] = json!("Sensitive content is excluded.");
                } else {
                    match storage.read_blob(&source.hash) {
                        Ok(_) => {
                            value["contentPath"] =
                                json!(storage.root().join("blobs").join(&source.hash))
                        }
                        Err(error) => value["unavailable"] = json!(error.message),
                    }
                }
                Ok(value)
            })
            .collect::<AppResult<Vec<_>>>()?
    };
    write(
        &exploration.directory.join("manifest.json"),
        &json!({
            "snapshotId": snapshot.id,
            "scope": snapshot.request,
            "head": snapshot.head,
            "reviewState": exploration.directory.join("review.json"),
            "changes": changes,
            "focus": focus,
            "sources": sources,
        }),
    )?;
    Ok(exploration)
}
