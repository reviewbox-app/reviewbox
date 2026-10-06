//! Immutable snapshots used to reconcile hook output without restaging personal edits.
use super::*;
pub(super) type Entries = BTreeMap<String, (String, String)>;

// Internal snapshot/index plumbing must not itself invoke post-index-change hooks.
// The actual `git commit` always uses the repository's configured hooks.
pub(super) fn plumbing(
    root: &Path,
    index: Option<&Path>,
    args: &[&str],
    input: &[u8],
) -> AppResult<Vec<u8>> {
    let empty_hooks = tempfile::tempdir()?;
    let config = format!("core.hooksPath={}", empty_hooks.path().display());
    let mut command = vec!["-c", config.as_str()];
    command.extend_from_slice(args);
    git::run(root, &command, index, input, &AtomicBool::new(false))
}
pub(super) fn read(root: &Path, tree: &str) -> AppResult<Entries> {
    let raw = plumbing(root, None, &["ls-tree", "-rz", tree], &[])?;
    let mut result = Entries::new();
    for entry in raw.split(|b| *b == 0).filter(|e| !e.is_empty()) {
        let line = std::str::from_utf8(entry)
            .map_err(|_| AppError::new("git_encoding", "Invalid Git path."))?;
        let (meta, path) = line
            .split_once('\t')
            .ok_or_else(|| AppError::new("git", "Invalid tree entry."))?;
        let parts: Vec<_> = meta.split(' ').collect();
        result.insert(path.into(), (parts[0].into(), parts[2].into()));
    }
    Ok(result)
}
pub(super) fn write_index(root: &Path, index: &Path, entries: &Entries) -> AppResult<String> {
    plumbing(root, Some(index), &["read-tree", "--empty"], &[])?;
    let mut data = Vec::new();
    for (path, (mode, oid)) in entries {
        data.extend(format!("{mode} {oid}\t{path}\0").as_bytes());
    }
    plumbing(
        root,
        Some(index),
        &["update-index", "-z", "--index-info"],
        &data,
    )?;
    index_tree(root, index)
}
pub(super) fn index_tree(root: &Path, index: &Path) -> AppResult<String> {
    Ok(
        String::from_utf8_lossy(&plumbing(root, Some(index), &["write-tree"], &[])?)
            .trim()
            .into(),
    )
}
pub(super) fn worktree(root: &Path) -> AppResult<String> {
    let temporary = git::TempIndex::new(root)?;
    fs::copy(git::git_path(root, "index")?, &temporary.0)?;
    let paths = plumbing(
        root,
        Some(&temporary.0),
        &[
            "ls-files",
            "-z",
            "--cached",
            "--others",
            "--exclude-standard",
        ],
        &[],
    )?;
    if !paths.is_empty() {
        plumbing(
            root,
            Some(&temporary.0),
            &["add", "-A", "--pathspec-from-file=-", "--pathspec-file-nul"],
            &paths,
        )?;
    }
    index_tree(root, &temporary.0)
}
pub(super) fn changed(a: &Entries, b: &Entries) -> BTreeSet<String> {
    a.keys()
        .chain(b.keys())
        .filter(|p| a.get(*p) != b.get(*p))
        .cloned()
        .collect()
}
pub(super) fn copy_path(target: &mut Entries, source: &Entries, path: &str) {
    if let Some(entry) = source.get(path) {
        target.insert(path.into(), entry.clone());
    } else {
        target.remove(path);
    }
}
