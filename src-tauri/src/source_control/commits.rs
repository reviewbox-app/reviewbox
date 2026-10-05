use super::{git, history, working};
use crate::{contracts::*, storage::Storage};
use serde::{Deserialize, Serialize};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    path::{Path, PathBuf},
    sync::atomic::{AtomicBool, Ordering},
};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Batch {
    pub message: String,
    pub paths: Vec<String>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Plan {
    commits: Vec<Batch>,
}

pub(super) struct Frozen {
    pub head: Option<String>,
    pub branch: String,
    pub version: String,
    pub entries: BTreeMap<String, (String, String)>,
    pub files: Vec<LocalFile>,
    pub context: String,
}
pub(super) fn freeze(root: &Path, expected: &str) -> AppResult<Frozen> {
    let _lock = git::IndexLock::acquire(root)?;
    if let Some(reason) = history::in_progress(root)? {
        return Err(AppError::new("git_conflict", reason));
    }
    let branch = git::text(root, &["symbolic-ref", "--quiet", "--short", "HEAD"])
        .map_err(|_| AppError::new("detached_head", "Check out a branch before committing."))?;
    let version = working::index_version(root)?;
    if version != expected {
        return Err(AppError::new(
            "git_changed",
            "The staged changes changed. Reload them before committing.",
        ));
    }
    let files: Vec<_> = working::files(root)?
        .into_iter()
        .filter(|f| f.staged_status.is_some())
        .collect();
    if files.is_empty() {
        return Err(AppError::new(
            "nothing_staged",
            "Stage files before committing.",
        ));
    }
    let raw = git::read(root, &["ls-files", "--stage", "-z"])?;
    let mut entries = BTreeMap::new();
    for entry in raw.split(|b| *b == 0).filter(|s| !s.is_empty()) {
        let line = String::from_utf8(entry.to_vec())
            .map_err(|_| AppError::new("git_encoding", "Invalid file path."))?;
        let (metadata, path) = line
            .split_once('\t')
            .ok_or_else(|| AppError::new("git", "Invalid index entry."))?;
        let parts: Vec<_> = metadata.split(' ').collect();
        if parts.len() != 3 || parts[2] != "0" {
            return Err(AppError::new(
                "git_conflict",
                "Resolve index conflicts first.",
            ));
        }
        entries.insert(path.into(), (parts[0].into(), parts[1].into()));
    }
    // Freeze an addressable tree without touching the real index. The harness
    // inspects these Git objects itself, even if the live index changes later.
    let temporary = git::TempIndex::new(root)?;
    let cancel = AtomicBool::new(false);
    git::run(
        root,
        &["read-tree", "--empty"],
        Some(&temporary.0),
        &[],
        &cancel,
    )?;
    let empty_tree = String::from_utf8(git::run(
        root,
        &["write-tree"],
        Some(&temporary.0),
        &[],
        &cancel,
    )?)
    .map_err(|_| AppError::new("git_encoding", "Invalid Git tree ID."))?;
    git::run(
        root,
        &["update-index", "-z", "--index-info"],
        Some(&temporary.0),
        &raw,
        &cancel,
    )?;
    let staged_tree = String::from_utf8(git::run(
        root,
        &["write-tree"],
        Some(&temporary.0),
        &[],
        &cancel,
    )?)
    .map_err(|_| AppError::new("git_encoding", "Invalid Git tree ID."))?;
    let head = git::head(root);
    let context = serde_json::to_string(&serde_json::json!({
        "baseTree":head.as_deref().unwrap_or(empty_tree.trim()),
        "stagedTree":staged_tree.trim(),
        "files":files.iter().map(|f|serde_json::json!({"path":f.path,"previousPath":f.previous_path})).collect::<Vec<_>>(),
    }))?;
    Ok(Frozen {
        head,
        branch,
        version,
        entries,
        files,
        context,
    })
}
pub(super) fn plan(text: &str, frozen: &Frozen) -> AppResult<Vec<Batch>> {
    let text = text.trim();
    let text = text
        .strip_prefix("```json\n")
        .and_then(|t| t.strip_suffix("``` ").or_else(|| t.strip_suffix("```")))
        .unwrap_or(text);
    let plan: Plan = serde_json::from_str(text.trim())?;
    validate(&plan.commits, frozen)?;
    Ok(plan.commits)
}
fn validate(batches: &[Batch], frozen: &Frozen) -> AppResult<()> {
    let expected: BTreeSet<_> = frozen.files.iter().map(|f| f.path.as_str()).collect();
    let mut seen = BTreeSet::new();
    if batches.is_empty() {
        return Err(AppError::new(
            "commit_plan",
            "Rev did not provide any commits.",
        ));
    }
    for batch in batches {
        if batch.message.trim().is_empty() || batch.message.contains('\0') || batch.paths.is_empty()
        {
            return Err(AppError::new(
                "commit_plan",
                "Each commit needs a message and staged files.",
            ));
        }
        for path in &batch.paths {
            if !expected.contains(path.as_str()) || !seen.insert(path.as_str()) {
                return Err(AppError::new(
                    "commit_plan",
                    "The commit plan has an unknown or duplicate file.",
                ));
            }
        }
    }
    if seen != expected {
        return Err(AppError::new(
            "commit_plan",
            "The commit plan must include every staged file exactly once.",
        ));
    }
    Ok(())
}

#[derive(Serialize, Deserialize)]
struct Journal {
    operation: GitOperation,
    original_head: Option<String>,
    index_version: String,
    batches: Vec<Batch>,
    next: usize,
    pending_head: Option<String>,
    #[serde(default)]
    pending_tree: Option<String>,
}
fn journal_path(storage: &Storage, id: &str) -> PathBuf {
    storage
        .root()
        .join("git-operations")
        .join(format!("{}.json", fingerprint(id.as_bytes())))
}
fn write(storage: &Storage, journal: &Journal) -> AppResult<()> {
    let path = journal_path(storage, &journal.operation.id);
    fs::create_dir_all(path.parent().unwrap())?;
    let temp = path.with_extension("tmp");
    {
        use std::io::Write;
        let mut file = fs::File::create(&temp)?;
        file.write_all(&serde_json::to_vec_pretty(journal)?)?;
        file.sync_all()?;
    }
    fs::rename(temp, path)?;
    Ok(())
}
pub(super) fn last(storage: &Storage, repository_id: &str) -> AppResult<Option<GitOperation>> {
    let directory = storage.root().join("git-operations");
    if !directory.exists() {
        return Ok(None);
    }
    let mut entries = fs::read_dir(directory)?.collect::<Result<Vec<_>, _>>()?;
    entries.sort_by_key(|e| e.metadata().and_then(|m| m.modified()).ok());
    for entry in entries
        .into_iter()
        .rev()
        .filter(|e| e.path().extension().is_some_and(|e| e == "json"))
    {
        let mut journal: Journal = serde_json::from_slice(&fs::read(entry.path())?)?;
        if journal.operation.repository_id != repository_id {
            continue;
        }
        if journal.operation.status == "running" {
            journal.operation.status = "interrupted".into();
            journal.operation.message="The commit sequence was interrupted. Completed commits remain in Git. Inspect the branch and remaining staged changes before starting a new operation.".into();
            // An interruption between Git's ref update and checkpoint persistence is
            // never retried. Discover only children of the recorded expected HEAD.
            if let Some(tree) = &journal.pending_tree
                && let Ok(root) = crate::repositories::root(storage, repository_id)
                && let Some(head) = git::head(&root)
                && git::text(&root, &["rev-parse", &format!("{head}^")]).ok()
                    == journal.pending_head
                && git::text(&root, &["rev-parse", &format!("{head}^{{tree}}")])
                    .ok()
                    .as_ref()
                    == Some(tree)
                && !journal.operation.commits.iter().any(|c| c.oid == head)
            {
                journal
                    .operation
                    .commits
                    .push(history::commit(&root, &head)?);
            }
            write(storage, &journal)?;
        }
        return Ok(Some(journal.operation));
    }
    Ok(None)
}
pub(super) fn execute(
    storage: &Storage,
    root: &Path,
    request: &GitCommitRequest,
    frozen: &Frozen,
    batches: Vec<Batch>,
    cancel: &AtomicBool,
    notify: impl Fn(&GitOperation),
) -> AppResult<GitOperation> {
    validate(&batches, frozen)?;
    if journal_path(storage, &request.operation_id).exists() {
        return Err(AppError::new(
            "operation_exists",
            "This operation already ran. Inspect its results before starting another.",
        ));
    }
    let _lock = git::IndexLock::acquire(root)?;
    if working::index_version(root)? != frozen.version {
        return Err(AppError::new(
            "git_changed",
            "The index or branch changed while Rev was planning. No commits were created.",
        ));
    }
    let original_index = fs::read(git::git_path(root, "index")?)?;
    let mut journal = Journal {
        operation: GitOperation {
            id: request.operation_id.clone(),
            repository_id: request.repository_id.clone(),
            status: "running".into(),
            message: "Creating commits…".into(),
            commits: vec![],
            error: None,
        },
        original_head: frozen.head.clone(),
        index_version: frozen.version.clone(),
        batches,
        next: 0,
        pending_head: None,
        pending_tree: None,
    };
    write(storage, &journal)?;
    let result = (|| {
        let mut expected_head = frozen.head.clone();
        for index in 0..journal.batches.len() {
            if cancel.load(Ordering::Relaxed) {
                return Err(AppError::new(
                    "cancelled",
                    "Commit sequence stopped. Completed commits and remaining staged changes are preserved.",
                ));
            }
            if git::head(root) != expected_head
                || fs::read(git::git_path(root, "index")?)? != original_index
                || git::text(root, &["symbolic-ref", "--quiet", "--short", "HEAD"])?
                    != frozen.branch
            {
                return Err(AppError::new(
                    "git_changed",
                    "The branch or index changed in another tool. The sequence stopped.",
                ));
            }
            let batch = &journal.batches[index];
            let temporary = git::TempIndex::new(root)?;
            let tree = expected_head.as_deref().unwrap_or("--empty");
            git::run(root, &["read-tree", tree], Some(&temporary.0), &[], cancel)?;
            let paths: BTreeSet<_> = batch
                .paths
                .iter()
                .flat_map(|path| {
                    let file = frozen.files.iter().find(|f| &f.path == path).unwrap();
                    file.previous_path.iter().chain(std::iter::once(&file.path))
                })
                .collect();
            let mut data = Vec::new();
            let zeros = "0".repeat(
                git::text(root, &["rev-parse", "--show-object-format"])
                    .map_or(40, |f| if f == "sha256" { 64 } else { 40 }),
            );
            for path in &paths {
                let entry = match frozen.entries.get(*path) {
                    Some((mode, oid)) => format!("{mode} {oid}\t{path}\0"),
                    None => format!("0 {zeros}\t{path}\0"),
                };
                data.extend(entry.as_bytes());
            }
            git::run(
                root,
                &["update-index", "-z", "--index-info"],
                Some(&temporary.0),
                &data,
                cancel,
            )?;
            let planned_tree = String::from_utf8_lossy(&git::run(
                root,
                &["write-tree"],
                Some(&temporary.0),
                &[],
                cancel,
            )?)
            .trim()
            .to_string();
            verify_temporary_index(root, &temporary.0, &paths, frozen, cancel)?;
            journal.operation.message =
                format!("Creating commit {} of {}", index + 1, journal.batches.len());
            journal.pending_head = expected_head.clone();
            journal.pending_tree = Some(planned_tree.clone());
            write(storage, &journal)?;
            notify(&journal.operation);
            let commit_result = git::run(
                root,
                &["commit", "--file=-"],
                Some(&temporary.0),
                batch.message.as_bytes(),
                cancel,
            );
            // Hooks can fail after a commit or cancellation can race its ref update.
            // Record any actual new commit before returning an error.
            let actual = git::head(root);
            if actual != expected_head {
                let oid = actual.clone().ok_or_else(|| {
                    AppError::new("git_changed", "HEAD disappeared during commit.")
                })?;
                let parent = git::text(root, &["rev-parse", &format!("{oid}^")]).ok();
                if parent != expected_head
                    || git::text(root, &["symbolic-ref", "--quiet", "--short", "HEAD"])?
                        != frozen.branch
                {
                    return Err(AppError::new(
                        "git_changed",
                        "The branch moved during commit. Inspect Git before continuing; no commit will be repeated.",
                    ));
                }
                journal.operation.commits.push(history::commit(root, &oid)?);
                journal.next = index + 1;
                journal.pending_head = None;
                journal.pending_tree = None;
                write(storage, &journal)?;
                notify(&journal.operation);
                if git::text(root, &["rev-parse", &format!("{oid}^{{tree}}")])? != planned_tree {
                    return Err(AppError::new(
                        "hook_changed_index",
                        "A Git hook changed the committed content. The commit is preserved; inspect it before continuing.",
                    ));
                }
            }
            commit_result?;
            if actual == expected_head {
                return Err(AppError::new(
                    "git",
                    "Git did not create the expected commit.",
                ));
            }
            expected_head = actual;
        }
        Ok::<_, AppError>(())
    })();
    journal.operation.status = match &result {
        Ok(()) => "completed",
        Err(e) if e.code == "cancelled" => "cancelled",
        Err(_) => "failed",
    }
    .into();
    journal.operation.message = if result.is_ok() {
        "Commits created".into()
    } else {
        "Commit sequence stopped".into()
    };
    journal.operation.error = result.err().map(|e| e.message);
    write(storage, &journal)?;
    notify(&journal.operation);
    Ok(journal.operation)
}

/// Index-writing hooks may run even during plumbing commands. Verify the exact
/// planned paths and blobs before allowing the user-facing commit command.
fn verify_temporary_index(
    root: &Path,
    index: &Path,
    paths: &BTreeSet<&String>,
    frozen: &Frozen,
    cancel: &AtomicBool,
) -> AppResult<()> {
    let changed = git::run(
        root,
        &[
            "diff",
            "--cached",
            "--name-only",
            "--no-renames",
            "--no-ext-diff",
            "--no-textconv",
            "-z",
        ],
        Some(index),
        &[],
        cancel,
    )?;
    let invalid = || {
        AppError::new(
            "hook_changed_index",
            "A Git hook changed the temporary index outside the planned staged contents. No further commit was created; inspect the hook before retrying.",
        )
    };
    for path in changed.split(|b| *b == 0).filter(|b| !b.is_empty()) {
        let path = std::str::from_utf8(path).map_err(|_| invalid())?;
        if !paths.iter().any(|p| p.as_str() == path) {
            return Err(invalid());
        }
    }
    let raw = git::run(
        root,
        &["ls-files", "--stage", "-z"],
        Some(index),
        &[],
        cancel,
    )?;
    let mut entries = BTreeMap::new();
    for entry in raw.split(|b| *b == 0).filter(|b| !b.is_empty()) {
        let (metadata, path) = std::str::from_utf8(entry)
            .map_err(|_| invalid())?
            .split_once('\t')
            .ok_or_else(invalid)?;
        let fields: Vec<_> = metadata.split(' ').collect();
        if fields.len() != 3 || fields[2] != "0" {
            return Err(invalid());
        }
        entries.insert(path, (fields[0].to_string(), fields[1].to_string()));
    }
    for path in paths {
        if entries.get(path.as_str()) != frozen.entries.get(*path) {
            return Err(invalid());
        }
    }
    Ok(())
}
