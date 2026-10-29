pub(super) mod autonomous;
mod trees;
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
#[cfg(test)]
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
    let head = git::head(root);
    Ok(Frozen {
        head,
        branch,
        version,
        entries,
        files,
    })
}
#[cfg(test)]
pub(super) fn plan(text: &str, frozen: &Frozen) -> AppResult<Vec<Batch>> {
    let text = text.trim();
    let text = text
        .strip_prefix("```json\n")
        .and_then(|t| t.strip_suffix("``` ").or_else(|| t.strip_suffix("```")))
        .unwrap_or(text);
    let plan: Plan = serde_json::from_str(text.trim())
        .map_err(|e| AppError::new("commit_plan", format!("Invalid plan JSON: {e}")))?;
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
            if !expected.contains(path.as_str()) {
                return Err(AppError::new(
                    "commit_plan",
                    format!(
                        "Unknown path {path:?}. Use only exact file paths from the frozen manifest, never directories or ignored/unselected files."
                    ),
                ));
            }
            if !seen.insert(path.as_str()) {
                return Err(AppError::new(
                    "commit_plan",
                    format!(
                        "Duplicate path {path:?}. Each manifest file must belong to exactly one commit."
                    ),
                ));
            }
        }
    }
    if seen != expected {
        return Err(AppError::new(
            "commit_plan",
            format!(
                "Missing staged files: {}. Include each manifest file exactly once.",
                expected
                    .difference(&seen)
                    .copied()
                    .collect::<Vec<_>>()
                    .join(", ")
            ),
        ));
    }
    Ok(())
}

#[derive(Clone, Serialize, Deserialize)]
struct Journal {
    operation: GitOperation,
    #[serde(default)]
    observed_from: Option<Vec<String>>,
    original_head: Option<String>,
    index_version: String,
    batches: Vec<Batch>,
    next: usize,
    pending_head: Option<String>,
    #[serde(default)]
    pending_tree: Option<String>,
    #[serde(default)]
    target_tree: Option<String>,
    #[serde(default)]
    worktree_before: Option<String>,
    #[serde(default)]
    branch: Option<String>,
    #[serde(default)]
    original_index_hash: Option<String>,
    #[serde(default)]
    pending_index: Option<PathBuf>,
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
        if journal.operation.repository_id != repository_id
            || journal.operation.status == "dismissed"
        {
            continue;
        }
        if journal.operation.status == "running" {
            journal.operation.status = "interrupted".into();
            journal.operation.message="The commit sequence was interrupted. Completed commits remain in Git. Inspect the branch and remaining staged changes before starting a new operation.".into();
            // An interruption between Git's ref update and checkpoint persistence is
            // never retried. Discover only children of the recorded expected HEAD.
            if journal.pending_tree.is_some()
                && let Ok(root) = crate::repositories::root(storage, repository_id)
                && let Some(head) = git::head(&root)
                && git::text(&root, &["rev-parse", &format!("{head}^")]).ok()
                    == journal.pending_head
                && journal.branch.as_ref().is_none_or(|branch| {
                    git::text(&root, &["symbolic-ref", "--quiet", "--short", "HEAD"])
                        .ok()
                        .as_ref()
                        == Some(branch)
                })
                && !journal.operation.commits.iter().any(|c| c.oid == head)
            {
                journal
                    .operation
                    .commits
                    .push(history::commit(&root, &head)?);
            }
            if journal.observed_from.is_some() {
                let root = crate::repositories::root(storage, repository_id)?;
                autonomous::observe(&root, &mut journal)?;
            } else {
                recover_index(storage, &mut journal)?;
            }
            write(storage, &journal)?;
        }
        return Ok(Some(journal.operation));
    }
    Ok(None)
}
pub(super) fn dismiss(storage: &Storage, repository_id: &str) -> AppResult<()> {
    // Complete interruption reconciliation before hiding its receipt.
    while let Some(operation) = last(storage, repository_id)? {
        let path = journal_path(storage, &operation.id);
        let mut journal: Journal = serde_json::from_slice(&fs::read(path)?)?;
        journal.operation.status = "dismissed".into();
        write(storage, &journal)?;
    }
    Ok(())
}

// Recovery only reconciles an unchanged original index on the recorded branch.
// It never invokes commit or rewrites worktree files.
fn recover_index(storage: &Storage, journal: &mut Journal) -> AppResult<()> {
    let (Some(target_tree), Some(index_hash), Some(branch)) = (
        &journal.target_tree,
        &journal.original_index_hash,
        &journal.branch,
    ) else {
        return Ok(());
    };
    let root = crate::repositories::root(storage, &journal.operation.repository_id)?;
    let mut lock = git::IndexLock::acquire(&root)?;
    if fingerprint(&fs::read(git::git_path(&root, "index")?)?) != *index_hash
        || git::text(&root, &["symbolic-ref", "--quiet", "--short", "HEAD"])? != *branch
    {
        return Ok(());
    }
    let head = git::head(&root);
    let recorded = journal
        .operation
        .commits
        .last()
        .map(|c| c.oid.clone())
        .or_else(|| journal.original_head.clone());
    if head != recorded {
        return Ok(());
    }
    let mut target = trees::read(&root, target_tree)?;
    let recovery_baseline = target.clone();
    if let (Some(planned), Some(head)) = (&journal.pending_tree, &head)
        && git::text(&root, &["rev-parse", &format!("{head}^")]).ok() == journal.pending_head
    {
        let planned = trees::read(&root, planned)?;
        let actual = trees::read(&root, head)?;
        for path in trees::changed(&planned, &actual) {
            trees::copy_path(&mut target, &actual, &path);
        }
    }
    if let (Some(index), Some(before_tree), Some(head)) =
        (&journal.pending_index, &journal.worktree_before, &head)
    {
        let owned = index.parent() == git::git_path(&root, "index")?.parent()
            && index
                .file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| name.starts_with("reviewbox-") && name.ends_with(".index"));
        if owned && index.is_file() {
            let staged = trees::read(&root, &trees::index_tree(&root, index)?)?;
            let actual = trees::read(&root, head)?;
            let before = trees::read(&root, before_tree)?;
            for path in trees::changed(&actual, &staged) {
                if before.get(&path) == recovery_baseline.get(&path) {
                    trees::copy_path(&mut target, &staged, &path);
                }
            }
        }
    }
    // Worktree-only residuals remain visible unstaged after a crash. They cannot
    // be attributed to the hook across an unbounded offline interval.
    let temporary = git::TempIndex::new(&root)?;
    journal.target_tree = Some(trees::write_index(&root, &temporary.0, &target)?);
    lock.publish(&root, &temporary.0)
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
    let mut lock = git::IndexLock::acquire(root)?;
    if working::index_version(root)? != frozen.version {
        return Err(AppError::new(
            "git_changed",
            "The index or branch changed while Rev was planning. No commits were created.",
        ));
    }
    let original_index = fs::read(git::git_path(root, "index")?)?;
    let target_index = git::TempIndex::new(root)?;
    let mut target = frozen.entries.clone();
    let mut journal = Journal {
        operation: GitOperation {
            id: request.operation_id.clone(),
            repository_id: request.repository_id.clone(),
            status: "running".into(),
            message: "Creating commits…".into(),
            commits: vec![],
            error: None,
        },
        observed_from: None,
        original_head: frozen.head.clone(),
        index_version: frozen.version.clone(),
        batches,
        next: 0,
        pending_head: None,
        pending_tree: None,
        target_tree: Some(trees::write_index(root, &target_index.0, &target)?),
        worktree_before: None,
        branch: Some(frozen.branch.clone()),
        original_index_hash: Some(fingerprint(&original_index)),
        pending_index: None,
    };
    write(storage, &journal)?;
    let mut expected_head = frozen.head.clone();
    let mut observed_worktree = trees::worktree(root)?;
    let mut result = (|| {
        for index in 0..journal.batches.len() {
            let batch = journal.batches[index].clone();
            let mut planned = match &expected_head {
                Some(head) => trees::read(root, head)?,
                None => BTreeMap::new(),
            };
            for path in &batch.paths {
                let file = frozen.files.iter().find(|f| &f.path == path).unwrap();
                for path in file.previous_path.iter().chain(std::iter::once(&file.path)) {
                    trees::copy_path(&mut planned, &target, path);
                }
            }
            for extra in [false, true] {
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
                    || trees::worktree(root)? != observed_worktree
                {
                    return Err(AppError::new(
                        "git_changed",
                        "The branch, index or working files changed in another tool. The sequence stopped.",
                    ));
                }
                let temporary = git::TempIndex::new(root)?;
                let planned_tree = trees::write_index(root, &temporary.0, &planned)?;
                if expected_head.as_ref().is_some_and(|head| {
                    git::text(root, &["rev-parse", &format!("{head}^{{tree}}")])
                        .ok()
                        .as_ref()
                        == Some(&planned_tree)
                }) {
                    break;
                }
                let before = trees::read(root, &observed_worktree)?;
                let target_before = target.clone();
                journal.operation.message = if extra {
                    "Committing Git hook changes…".into()
                } else {
                    format!("Creating commit {} of {}", index + 1, journal.batches.len())
                };
                journal.pending_head = expected_head.clone();
                journal.pending_tree = Some(planned_tree.clone());
                journal.worktree_before = Some(observed_worktree.clone());
                journal.pending_index = Some(temporary.0.clone());
                write(storage, &journal)?;
                notify(&journal.operation);
                // Recheck after notifying listeners; no live contents are staged here.
                if trees::worktree(root)? != observed_worktree {
                    return Err(AppError::new(
                        "git_changed",
                        "Working files changed before the commit.",
                    ));
                }
                let commit_result = git::run(
                    root,
                    &["commit", "--file=-"],
                    Some(&temporary.0),
                    if extra {
                        b"chore: apply git hook changes"
                    } else {
                        batch.message.as_bytes()
                    },
                    cancel,
                );
                let actual = git::head(root);
                let created = actual != expected_head;
                let mut committed = planned.clone();
                if actual != expected_head {
                    let oid = actual.as_ref().ok_or_else(|| {
                        AppError::new("git_changed", "HEAD disappeared during commit.")
                    })?;
                    if git::text(root, &["rev-parse", &format!("{oid}^")]).ok() != expected_head
                        || git::text(root, &["symbolic-ref", "--quiet", "--short", "HEAD"])?
                            != frozen.branch
                    {
                        return Err(AppError::new(
                            "git_changed",
                            "The branch moved during commit. Inspect Git before continuing; no commit will be repeated.",
                        ));
                    }
                    committed = trees::read(root, oid)?;
                    journal.operation.commits.push(history::commit(root, oid)?);
                    expected_head = actual.clone();
                    for path in trees::changed(&planned, &committed) {
                        trees::copy_path(&mut target, &committed, &path);
                    }
                    journal.target_tree = Some(trees::write_index(root, &target_index.0, &target)?);
                    // Keep the pending snapshot until residual hook output is captured.
                    write(storage, &journal)?;
                    notify(&journal.operation);
                }
                let after_tree = trees::worktree(root)?;
                let after = trees::read(root, &after_tree)?;
                let index_after = trees::read(root, &trees::index_tree(root, &temporary.0)?)?;
                let mut residual = committed.clone();
                let mut ambiguity = None;
                for path in trees::changed(&planned, &committed)
                    .union(&trees::changed(&committed, &index_after))
                {
                    if before.get(path) != target_before.get(path) {
                        ambiguity = Some(path.clone());
                    }
                }
                for path in trees::changed(&committed, &index_after) {
                    if before.get(&path) != target_before.get(&path) {
                        ambiguity = Some(path);
                        continue;
                    }
                    trees::copy_path(&mut residual, &index_after, &path);
                }
                for path in trees::changed(&before, &after) {
                    if before.get(&path) != target_before.get(&path) {
                        ambiguity = Some(path);
                        continue;
                    }
                    if after.get(&path) != committed.get(&path) {
                        trees::copy_path(&mut residual, &after, &path);
                    }
                }
                for path in trees::changed(&committed, &residual) {
                    trees::copy_path(&mut target, &residual, &path);
                }
                journal.target_tree = Some(trees::write_index(root, &target_index.0, &target)?);
                journal.pending_head = None;
                journal.pending_tree = None;
                journal.pending_index = None;
                observed_worktree = after_tree;
                write(storage, &journal)?;
                if let Some(path) = ambiguity {
                    return Err(AppError::new(
                        "hook_overlap",
                        format!(
                            "Git hook changes overlap pre-existing personal changes in {path}. Completed commits and remaining changes are preserved; inspect this file before continuing."
                        ),
                    ));
                }
                commit_result?;
                if !created {
                    return Err(AppError::new(
                        "git",
                        "Git did not create the expected commit.",
                    ));
                }
                if residual == committed {
                    break;
                }
                if extra {
                    return Err(AppError::new(
                        "hook_unstable",
                        "The Git hook still changes files after the additional commit. Completed commits and remaining staged changes are preserved.",
                    ));
                }
                planned = residual;
            }
            journal.next = index + 1;
            write(storage, &journal)?;
        }
        Ok::<_, AppError>(())
    })();
    // Publish only when the index and branch still belong to this operation.
    // The target contains actual hook output plus all uncommitted planned batches.
    if git::head(root) == expected_head
        && fs::read(git::git_path(root, "index")?)? == original_index
        && git::text(root, &["symbolic-ref", "--quiet", "--short", "HEAD"])? == frozen.branch
    {
        if let Err(error) = trees::write_index(root, &target_index.0, &target)
            .and_then(|_| lock.publish(root, &target_index.0))
        {
            result = Err(error);
        }
    } else {
        result = Err(AppError::new(
            "git_changed",
            "The branch or index changed externally. Completed commits are preserved; inspect the index before continuing.",
        ));
    }
    journal.operation.status = match &result {
        Ok(()) => "completed",
        Err(e) if e.code == "cancelled" => "cancelled",
        Err(_) => "failed",
    }
    .into();
    journal.operation.message = if result.is_ok() {
        "Commits created"
    } else {
        "Commit sequence stopped"
    }
    .into();
    journal.operation.error = result.err().map(|e| e.message);
    write(storage, &journal)?;
    notify(&journal.operation);
    Ok(journal.operation)
}
