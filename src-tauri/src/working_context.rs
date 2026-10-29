//! Author work briefs are frozen private context, never review evidence or instructions.
use crate::{contracts::*, project_storage, repositories, storage::Storage};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{fs, io::Read, path::Path};

const KIND: &str = "review_working_context";
const PATHS: [&str; 2] = [
    ".reviewbox/CURRENT_CHANGES.md",
    ".reviewbox/.local/CURRENT_CHANGES.md",
];
const LIMIT: u64 = 64 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct FrozenBrief {
    pub summary: WorkingContextFile,
    text: Option<String>,
    #[serde(default)]
    claimed: bool,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct FrozenContext {
    revision: u32,
    repository_id: String,
    review_id: String,
    snapshot_id: String,
    pub(crate) files: Vec<FrozenBrief>,
}
impl FrozenContext {
    fn key(&self) -> String {
        key(&self.repository_id, &self.review_id, &self.snapshot_id)
    }
    pub(crate) fn identity(&self) -> AppResult<String> {
        // Assessments and cleanup are mutable; only frozen author bytes identify a run.
        Ok(fingerprint(&serde_json::to_vec(
            &self
                .files
                .iter()
                .map(|file| (&file.summary.path, &file.summary.hash, &file.text))
                .collect::<Vec<_>>(),
        )?))
    }
    fn summary(&self) -> ReviewWorkingContext {
        ReviewWorkingContext {
            snapshot_id: self.snapshot_id.clone(),
            files: self.files.iter().map(|file| file.summary.clone()).collect(),
        }
    }
}
fn key(repository: &str, review: &str, snapshot: &str) -> String {
    format!("{repository}:{review}:{snapshot}")
}

pub(crate) fn load(
    storage: &Storage,
    repository: &str,
    review: &str,
    snapshot: &str,
) -> AppResult<Option<FrozenContext>> {
    match storage.get(KIND, &key(repository, review, snapshot)) {
        Ok(context) => Ok(Some(context)),
        Err(error) if error.code == "not_found" => Ok(None),
        Err(error) => Err(error),
    }
}

fn read_brief(root: &Path, relative: &str) -> AppResult<Option<(String, String)>> {
    let path = project_storage::checked(root, relative)?;
    let mut file = match fs::File::open(&path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.into()),
    };
    let metadata = file.metadata()?;
    if !metadata.is_file() || metadata.len() > LIMIT {
        return Err(AppError::new(
            "context_limit",
            "Work briefs must be regular UTF-8 files no larger than 64 KiB.",
        ));
    }
    let mut bytes = Vec::new();
    (&mut file).take(LIMIT + 1).read_to_end(&mut bytes)?;
    if bytes.len() as u64 > LIMIT || bytes.contains(&0) {
        return Err(AppError::new(
            "context_limit",
            "The work brief is too large or contains binary content.",
        ));
    }
    // Detect a concurrent replacement/write; never mix two versions of a brief.
    let after = fs::metadata(&path)?;
    if metadata.len() != after.len() || metadata.modified().ok() != after.modified().ok() {
        return Err(AppError::new(
            "context_changed",
            "The work brief changed while it was being captured.",
        ));
    }
    let hash = fingerprint(&bytes);
    let text = String::from_utf8(bytes)
        .map_err(|_| AppError::new("encoding", "The work brief is not UTF-8."))?;
    Ok(Some((hash, text)))
}

pub(crate) fn freeze(
    storage: &Storage,
    repository_id: &str,
    review_id: &str,
    snapshot_id: &str,
) -> AppResult<FrozenContext> {
    let root = repositories::root(storage, repository_id)?;
    let mut context = FrozenContext {
        revision: 0,
        repository_id: repository_id.into(),
        review_id: review_id.into(),
        snapshot_id: snapshot_id.into(),
        files: vec![],
    };
    for path in PATHS {
        let (hash, text, reason) = match read_brief(&root, path) {
            Ok(Some((hash, text))) => (
                hash,
                Some(text),
                "Waiting for Rev to compare this brief with the captured changes.".into(),
            ),
            Ok(None) => continue,
            Err(error) => (String::new(), None, error.message),
        };
        context.files.push(FrozenBrief {
            summary: WorkingContextFile {
                path: path.into(),
                hash,
                status: WorkingContextStatus::Unverified,
                reason,
                cleanup: "pending".into(),
                recovery_path: None,
            },
            text,
            claimed: false,
        });
    }
    persist(storage, &mut context)?;
    Ok(context)
}

pub(crate) fn persist(storage: &Storage, context: &mut FrozenContext) -> AppResult<()> {
    match storage.get::<FrozenContext>(KIND, &context.key()) {
        Ok(previous) => {
            context.revision = previous.revision + 1;
            storage.replace(KIND, &context.key(), previous.revision, context)
        }
        Err(error) if error.code == "not_found" => storage.insert(KIND, &context.key(), context),
        Err(error) => Err(error),
    }
}

/// Install the private context with the destination before an adaptation commits.
/// Copying twice is safe, including recovery after the review writer committed.
pub(crate) fn transfer(
    storage: &Storage,
    repository: &str,
    source: &str,
    destination: &str,
    snapshot: &str,
) -> AppResult<()> {
    if source == destination {
        return Ok(());
    }
    if let Some(mut context) = load(storage, repository, source, snapshot)? {
        if let Some(existing) = load(storage, repository, destination, snapshot)?
            && existing.identity()? == context.identity()?
        {
            return Ok(());
        }
        context.review_id = destination.into();
        context.revision = 0;
        persist(storage, &mut context)?;
    }
    Ok(())
}

pub(crate) fn validate_assessments(
    context: &FrozenContext,
    assessments: &[WorkingContextAssessment],
) -> AppResult<()> {
    if assessments.len() != context.files.len() {
        return Err(AppError::new(
            "invalid_context_assessment",
            "Assess each available work brief exactly once.",
        ));
    }
    let mut seen = std::collections::BTreeSet::new();
    for assessment in assessments {
        let file = context
            .files
            .iter()
            .find(|file| file.summary.path == assessment.path)
            .ok_or_else(|| {
                AppError::new(
                    "invalid_context_assessment",
                    "The assessment names an unknown work brief.",
                )
            })?;
        if !seen.insert(&assessment.path)
            || assessment.reason.trim().is_empty()
            || assessment.reason.len() > 2000
            || (file.text.is_none() && assessment.status != WorkingContextStatus::Unverified)
        {
            return Err(AppError::new(
                "invalid_context_assessment",
                "Give each work brief a valid status and a concise reason; unreadable files remain unverified.",
            ));
        }
    }
    Ok(())
}

pub(crate) fn assess(
    storage: &Storage,
    context: &mut FrozenContext,
    assessments: &[WorkingContextAssessment],
) -> AppResult<()> {
    validate_assessments(context, assessments)?;
    for assessment in assessments {
        if let Some(file) = context
            .files
            .iter_mut()
            .find(|file| file.summary.path == assessment.path)
        {
            file.summary.status = assessment.status.clone();
            file.summary.reason = assessment.reason.clone();
        }
    }
    persist(storage, context)
}

pub(crate) fn prompt_context(
    storage: &Storage,
    repository_id: &str,
    review_id: &str,
    snapshot_id: &str,
    planning: bool,
) -> AppResult<Value> {
    let context =
        match storage.get::<FrozenContext>(KIND, &key(repository_id, review_id, snapshot_id)) {
            Ok(context) => context,
            Err(error) if error.code == "not_found" => {
                return Ok(json!({"available":false,"files":[]}));
            }
            Err(error) => return Err(error),
        };
    Ok(json!({
        "available": !context.files.is_empty(),
        "priority": ".reviewbox/.local/CURRENT_CHANGES.md",
        "files": context.files.iter().map(|file| json!({
            "path": file.summary.path, "hash": file.summary.hash,
            "status": file.summary.status, "reason": file.summary.reason,
            "content": if planning || file.summary.status == WorkingContextStatus::Accepted { file.text.as_deref() } else { None },
        })).collect::<Vec<_>>()
    }))
}

pub(crate) fn cleanup(storage: &Storage, review: &Review) -> AppResult<ReviewWorkingContext> {
    cleanup_using(storage, review, |path| {
        trash::delete(path).map_err(|error| AppError::new("trash", error.to_string()))
    })
}

fn cleanup_using(
    storage: &Storage,
    review: &Review,
    mut trash_file: impl FnMut(&Path) -> AppResult<()>,
) -> AppResult<ReviewWorkingContext> {
    let mut context = match storage.get::<FrozenContext>(
        KIND,
        &key(&review.repository_id, &review.id, &review.snapshot_id),
    ) {
        Ok(context) => context,
        Err(error) if error.code == "not_found" => {
            return Ok(ReviewWorkingContext {
                snapshot_id: review.snapshot_id.clone(),
                files: vec![],
            });
        }
        Err(error) => return Err(error),
    };
    if !review.publication.is_complete() {
        return Ok(context.summary());
    }
    let root = repositories::root(storage, &review.repository_id)?;
    let project = project_storage::Project::open(&root, &review.repository_id)?;
    let _lock = project.lock()?;
    for index in 0..context.files.len() {
        let file = &context.files[index];
        if file.summary.status != WorkingContextStatus::Accepted
            || ["trashed", "changed", "missing"].contains(&file.summary.cleanup.as_str())
        {
            continue;
        }
        // Persist a receipt before moving anything. An external editor does not
        // participate in our lock, so Trash must target claimed bytes, not a path
        // at which the next work brief may already have appeared.
        if file.summary.recovery_path.is_none() {
            context.files[index].summary.recovery_path =
                Some(format!(".reviewbox/.local/context-trash/{}.md", id()));
            persist(storage, &mut context)?;
        }
        let receipt = context.files[index]
            .summary
            .recovery_path
            .clone()
            .unwrap_or_default();
        if !receipt.starts_with(".reviewbox/.local/context-trash/") {
            return Err(AppError::new(
                "invalid_context_receipt",
                "Invalid work context recovery path.",
            ));
        }
        let claimed_path = project_storage::checked(&root, &receipt)?;
        let source_path = project_storage::checked(&root, &context.files[index].summary.path)?;
        let result = (|| -> AppResult<String> {
            if !claimed_path.exists() {
                if context.files[index].claimed {
                    return Ok("trashed".into());
                }
                match read_brief(&root, &context.files[index].summary.path)? {
                    Some((hash, _)) if hash != context.files[index].summary.hash => {
                        context.files[index].summary.recovery_path = None;
                        return Ok("changed".into());
                    }
                    None => {
                        context.files[index].summary.recovery_path = None;
                        return Ok("missing".into());
                    }
                    _ => {}
                }
                fs::create_dir_all(
                    claimed_path
                        .parent()
                        .ok_or_else(|| AppError::new("path", "Missing receipt parent."))?,
                )?;
                project_storage::checked(&root, &receipt)?;
                fs::rename(&source_path, &claimed_path)?;
            }
            context.files[index].claimed = true;
            persist(storage, &mut context)?;
            if read_brief(&root, &receipt)?
                .is_none_or(|(hash, _)| hash != context.files[index].summary.hash)
            {
                // Restore only if no newer file exists. A hard link claims the
                // destination without replacement; otherwise keep recovery bytes.
                if fs::hard_link(&claimed_path, &source_path).is_ok() {
                    fs::remove_file(&claimed_path)?;
                    context.files[index].summary.recovery_path = None;
                }
                return Ok("changed".into());
            }
            trash_file(&claimed_path)?;
            context.files[index].summary.recovery_path = None;
            Ok("trashed".into())
        })();
        context.files[index].summary.cleanup =
            result.unwrap_or_else(|error| format!("error: {}", error.message));
        persist(storage, &mut context)?;
    }
    Ok(context.summary())
}

#[tauri::command]
pub async fn review_working_context(
    storage: tauri::State<'_, Storage>,
    repository_id: String,
    review_id: String,
) -> AppResult<ReviewWorkingContext> {
    let storage = storage.scoped(Some(&repository_id));
    tauri::async_runtime::spawn_blocking(move || {
        let review: Review = storage.get("review", &review_id)?;
        match storage
            .get::<FrozenContext>(KIND, &key(&repository_id, &review.id, &review.snapshot_id))
        {
            Ok(context) => Ok(context.summary()),
            Err(error) if error.code == "not_found" => Ok(ReviewWorkingContext {
                snapshot_id: review.snapshot_id,
                files: vec![],
            }),
            Err(error) => Err(error),
        }
    })
    .await
    .map_err(|e| AppError::new("task_failed", e.to_string()))?
}

#[tauri::command]
pub async fn retry_working_context_cleanup(
    storage: tauri::State<'_, Storage>,
    repository_id: String,
    review_id: String,
) -> AppResult<ReviewWorkingContext> {
    let storage = storage.scoped(Some(&repository_id));
    tauri::async_runtime::spawn_blocking(move || {
        cleanup(&storage, &storage.get("review", &review_id)?)
    })
    .await
    .map_err(|e| AppError::new("task_failed", e.to_string()))?
}

#[cfg(test)]
mod tests;
