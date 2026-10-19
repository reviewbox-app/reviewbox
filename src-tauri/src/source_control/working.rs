use super::git;
use crate::{contracts::*, snapshots};
use std::{fs, path::Path, sync::atomic::AtomicBool};

fn string(bytes: &[u8]) -> AppResult<String> {
    String::from_utf8(bytes.to_vec())
        .map_err(|_| AppError::new("git_encoding", "A Git path is not UTF-8."))
}
fn status(s: &str) -> Option<String> {
    (s != ".").then(|| s.to_string())
}

pub(super) fn files(root: &Path) -> AppResult<Vec<LocalFile>> {
    files_matching(root, None)
}
fn files_matching(root: &Path, only: Option<&str>) -> AppResult<Vec<LocalFile>> {
    let head = git::head(root);
    let index = git::read(root, &["ls-files", "--stage", "-z"])?;
    let mut entries = std::collections::BTreeMap::new();
    for record in index.split(|b| *b == 0).filter(|b| !b.is_empty()) {
        if let Some(tab) = record.iter().position(|b| *b == b'\t') {
            entries.insert(string(&record[tab + 1..])?, record.to_vec());
        }
    }
    let bytes = git::read(
        root,
        &["status", "--porcelain=v2", "-z", "--untracked-files=all"],
    )?;
    let mut records = bytes.split(|b| *b == 0).filter(|b| !b.is_empty());
    let mut files = Vec::new();
    while let Some(record) = records.next() {
        let line = string(record)?;
        let (path, old, xy, conflict) = match line.as_bytes()[0] {
            b'?' => (line[2..].to_string(), None, ".U".to_string(), false),
            b'1' => {
                let p: Vec<_> = line.splitn(9, ' ').collect();
                if p.len() != 9 {
                    return Err(AppError::new("git_status", "Invalid Git status."));
                }
                (p[8].into(), None, p[1].into(), false)
            }
            b'2' => {
                let p: Vec<_> = line.splitn(10, ' ').collect();
                if p.len() != 10 {
                    return Err(AppError::new("git_status", "Invalid rename status."));
                }
                let old = string(
                    records
                        .next()
                        .ok_or_else(|| AppError::new("git_status", "Missing rename source."))?,
                )?;
                (p[9].into(), Some(old), p[1].into(), false)
            }
            b'u' => {
                let p: Vec<_> = line.splitn(11, ' ').collect();
                if p.len() != 11 {
                    return Err(AppError::new("git_status", "Invalid conflict status."));
                }
                (p[10].into(), None, p[1].into(), true)
            }
            _ => continue,
        };
        snapshots::safe_path(&path)?;
        let mut file = LocalFile {
            path,
            previous_path: old,
            staged_status: status(&xy[..1]),
            unstaged_status: status(&xy[1..2]),
            conflicted: conflict,
            version: String::new(),
        };
        if only.is_some_and(|path| path != file.path) {
            continue;
        }
        file.version = version(root, &file, &head, &entries)?;
        files.push(file);
    }
    files.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(files)
}

pub(super) fn index_version(root: &Path) -> AppResult<String> {
    Ok(fingerprint(&serde_json::to_vec(&(
        git::head(root),
        git::text(root, &["symbolic-ref", "--quiet", "HEAD"]).ok(),
        git::read(root, &["ls-files", "--stage", "-z"])?,
    ))?))
}

pub(super) fn worktree(root: &Path, path: &str) -> AppResult<Option<(String, Vec<u8>)>> {
    snapshots::safe_path(path)?;
    let location = root.join(path);
    // A symlink leaf is content; symlink parents must not escape the repository.
    if let Some(parent) = location.parent().filter(|p| p.exists())
        && !parent.canonicalize()?.starts_with(root.canonicalize()?)
    {
        return Err(AppError::new(
            "unsafe_path",
            "A parent symlink leaves the repository.",
        ));
    }
    let meta = match fs::symlink_metadata(&location) {
        Ok(m) => m,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(e.into()),
    };
    if meta.file_type().is_symlink() {
        let target = fs::read_link(location)?;
        #[cfg(unix)]
        let bytes = {
            use std::os::unix::ffi::OsStrExt;
            target.as_os_str().as_bytes().to_vec()
        };
        #[cfg(not(unix))]
        let bytes = target.to_string_lossy().as_bytes().to_vec();
        return Ok(Some(("120000".into(), bytes)));
    }
    if meta.is_dir() {
        return Ok(Some((
            "160000".into(),
            git::head(&location).unwrap_or_default().into_bytes(),
        )));
    }
    if !meta.is_file() {
        return Err(AppError::new(
            "unsupported_file",
            "Only regular files and symlinks can be read.",
        ));
    }
    if meta.len() > 64 * 1024 * 1024 {
        use sha2::{Digest, Sha256};
        use std::io::Read;
        let mut input = fs::File::open(&location)?;
        let mut hash = Sha256::new();
        let mut buffer = [0u8; 65536];
        loop {
            let count = input.read(&mut buffer)?;
            if count == 0 {
                break;
            }
            hash.update(&buffer[..count]);
        }
        return Ok(Some(("oversized".into(), hash.finalize().to_vec())));
    }
    #[cfg(unix)]
    let executable = {
        use std::os::unix::fs::PermissionsExt;
        meta.permissions().mode() & 0o111 != 0
    };
    #[cfg(not(unix))]
    let executable = false;
    Ok(Some((
        if executable { "100755" } else { "100644" }.into(),
        fs::read(location)?,
    )))
}
fn version(
    root: &Path,
    file: &LocalFile,
    head: &Option<String>,
    entries: &std::collections::BTreeMap<String, Vec<u8>>,
) -> AppResult<String> {
    let mut input = serde_json::to_vec(&(
        head,
        &file.staged_status,
        &file.unstaged_status,
        &file.previous_path,
    ))?;
    for path in file.previous_path.iter().chain(std::iter::once(&file.path)) {
        if let Some(entry) = entries.get(path) {
            input.extend(entry);
        }
        input.extend(serde_json::to_vec(
            &worktree(root, path)?.map(|(mode, bytes)| (mode, fingerprint(&bytes))),
        )?);
    }
    Ok(fingerprint(&input))
}
pub(super) fn current(root: &Path, path: &str, expected: &str) -> AppResult<LocalFile> {
    files_matching(root, Some(path))?.into_iter().find(|f|f.path==path&&f.version==expected).ok_or_else(||AppError::new("git_changed","This file changed. Its latest state has been reloaded; check it before trying again."))
}
pub(super) fn stage(
    root: &Path,
    path: &str,
    expected: &str,
    stage: bool,
    cancel: &AtomicBool,
) -> AppResult<()> {
    stage_files(
        root,
        &[LocalFileSelection {
            path: path.into(),
            version: expected.into(),
        }],
        stage,
        cancel,
    )
}

pub(super) fn selected_files(
    root: &Path,
    selections: &[LocalFileSelection],
) -> AppResult<Vec<LocalFile>> {
    if selections.is_empty() {
        return Err(AppError::new(
            "selection",
            "Select at least one changed file.",
        ));
    }
    let current = files(root)?;
    let mut seen = std::collections::BTreeSet::new();
    selections
        .iter()
        .map(|selection| {
            snapshots::safe_path(&selection.path)?;
            if !seen.insert(&selection.path) {
                return Err(AppError::new("selection", "Duplicate selected file."));
            }
            let file = current
                .iter()
                .find(|file| file.path == selection.path && file.version == selection.version)
                .ok_or_else(|| {
                    AppError::new(
                        "git_changed",
                        "Selected files changed. Reload and check them before trying again.",
                    )
                })?;
            if file.conflicted {
                return Err(AppError::new(
                    "git_conflict",
                    "Resolve conflicts in another tool first.",
                ));
            }
            Ok(file.clone())
        })
        .collect()
}

pub(super) fn stage_files(
    root: &Path,
    selections: &[LocalFileSelection],
    stage: bool,
    cancel: &AtomicBool,
) -> AppResult<()> {
    stage_files_version(root, selections, stage, cancel).map(|_| ())
}

pub(super) fn stage_files_version(
    root: &Path,
    selections: &[LocalFileSelection],
    stage: bool,
    cancel: &AtomicBool,
) -> AppResult<String> {
    let mut lock = git::IndexLock::acquire(root)?;
    let selected = selected_files(root, selections)?;
    let original = fs::read(git::git_path(root, "index")?).ok();
    let temporary = git::TempIndex::new(root)?;
    if let Some(bytes) = &original {
        fs::write(&temporary.0, bytes)?;
        // Copying an index must preserve its timestamp: otherwise Git can
        // mistake a same-size edit within the original index's timestamp tick
        // for a clean file (the racy-clean protection uses the index mtime).
        let modified = fs::metadata(git::git_path(root, "index")?)?.modified()?;
        fs::File::options()
            .write(true)
            .open(&temporary.0)?
            .set_times(fs::FileTimes::new().set_modified(modified))?;
    }
    // Preserve unrelated recreations of an already staged rename's old path.
    let mut paths = std::collections::BTreeSet::new();
    for file in &selected {
        if let Some(previous) = file
            .previous_path
            .as_ref()
            .filter(|_| !stage || file.staged_status.is_none())
        {
            paths.insert(previous.as_str());
        }
        paths.insert(file.path.as_str());
    }
    let encode = |paths: Vec<&str>| {
        paths
            .into_iter()
            .flat_map(|path| path.bytes().chain(std::iter::once(0)))
            .collect::<Vec<_>>()
    };
    if stage {
        // Updating tracked files must work even when a parent directory was
        // subsequently ignored. Never force-add ignored untracked siblings.
        let raw = git::run(root, &["ls-files", "-z"], Some(&temporary.0), &[], cancel)?;
        let tracked: std::collections::BTreeSet<_> = raw.split(|b| *b == 0).collect();
        for (update, flag) in [(true, "-u"), (false, "-A")] {
            let selected = paths
                .iter()
                .copied()
                .filter(|path| tracked.contains(path.as_bytes()) == update)
                .collect::<Vec<_>>();
            if !selected.is_empty() {
                git::run(
                    root,
                    &["add", flag, "--pathspec-from-file=-", "--pathspec-file-nul"],
                    Some(&temporary.0),
                    &encode(selected),
                    cancel,
                )?;
            }
        }
    } else {
        let args = if git::head(root).is_some() {
            vec![
                "reset",
                "-q",
                "HEAD",
                "--pathspec-from-file=-",
                "--pathspec-file-nul",
            ]
        } else {
            vec!["update-index", "--force-remove", "-z", "--stdin"]
        };
        git::run(
            root,
            &args,
            Some(&temporary.0),
            &encode(paths.into_iter().collect()),
            cancel,
        )?;
    }
    selected_files(root, selections)?;
    if fs::read(git::git_path(root, "index")?).ok() != original {
        return Err(AppError::new(
            "git_changed",
            "The Git index changed in another tool.",
        ));
    }
    // Compute the exact future index identity before releasing index.lock.
    // An external writer between publication and freeze must be detected.
    let version = fingerprint(&serde_json::to_vec(&(
        git::head(root),
        git::text(root, &["symbolic-ref", "--quiet", "HEAD"]).ok(),
        git::run(
            root,
            &["ls-files", "--stage", "-z"],
            Some(&temporary.0),
            &[],
            cancel,
        )?,
    ))?);
    lock.publish(root, &temporary.0)?;
    Ok(version)
}

fn blob(root: &Path, reference: &str, path: &str) -> AppResult<Option<(String, Vec<u8>)>> {
    let entries = if reference == "INDEX" {
        git::read(root, &["ls-files", "--stage", "-z", "--", path])?
    } else {
        if git::head(root).is_none() {
            return Ok(None);
        }
        git::read(root, &["ls-tree", "-z", reference, "--", path])?
    };
    let Some(entry) = entries.split(|b| *b == 0).find(|e| !e.is_empty()) else {
        return Ok(None);
    };
    let fields = string(entry)?.split('\t').next().unwrap_or("").to_string();
    let parts: Vec<_> = fields.split(' ').collect();
    let oid = parts
        .get(if reference == "INDEX" { 1 } else { 2 })
        .ok_or_else(|| AppError::new("git", "Invalid index entry."))?;
    if parts[0] != "160000"
        && git::text(root, &["cat-file", "-s", oid])?
            .parse::<u64>()
            .unwrap_or(u64::MAX)
            > 64 * 1024 * 1024
    {
        return Ok(Some(("oversized".into(), oid.as_bytes().to_vec())));
    }
    let bytes = if parts[0] == "160000" {
        oid.as_bytes().to_vec()
    } else {
        git::read(root, &["cat-file", "blob", oid])?
    };
    Ok(Some((parts[0].into(), bytes)))
}
pub(super) fn diff(
    root: &Path,
    path: &str,
    layer: &str,
    expected: &str,
) -> AppResult<LocalFileDiff> {
    if !["staged", "unstaged"].contains(&layer) {
        return Err(AppError::new("layer", "Unknown change layer."));
    }
    let file = current(root, path, expected)?;
    let previous = file.previous_path.as_deref().unwrap_or(path);
    let (before, after) = if layer == "staged" {
        (blob(root, "HEAD", previous)?, blob(root, "INDEX", path)?)
    } else {
        (blob(root, "INDEX", path)?, worktree(root, path)?)
    };
    current(root, path, expected)?;
    let binary = before.iter().chain(after.iter()).any(|(mode, b)| {
        mode == "160000" || mode == "oversized" || b.contains(&0) || std::str::from_utf8(b).is_err()
    });
    let reference = |value: &Option<(String, Vec<u8>)>| {
        value.as_ref().map(|(mode, bytes)| BlobRef {
            hash: fingerprint(bytes),
            size: bytes.len() as u32,
            mode: mode.clone(),
        })
    };
    Ok(LocalFileDiff{version:expected.into(),change:Change{id:fingerprint(format!("{path}/{layer}").as_bytes()),path:path.into(),previous_path:(layer=="staged").then_some(file.previous_path).flatten(),layer:layer.into(),before:reference(&before),after:reference(&after),binary,passages:vec![],untracked:file.unstaged_status.as_deref()==Some("U")},content:FileContent{before:before.map(|(_,b)|String::from_utf8_lossy(&b).into_owned()),after:after.map(|(_,b)|String::from_utf8_lossy(&b).into_owned()),unavailable_reason:binary.then(||"Binary, submodule or oversized content cannot be displayed as text. File-level staging remains available.".into())}})
}

/// Discard only worktree changes. Never reset the index or include sibling paths.
pub(super) fn discard_files(
    root: &Path,
    selections: &[LocalFileSelection],
    cancel: &AtomicBool,
) -> AppResult<()> {
    let _lock = git::IndexLock::acquire(root)?;
    let selected = selected_files(root, selections)?;
    let mut tracked = Vec::new();
    let mut untracked = Vec::new();
    for file in &selected {
        if file.unstaged_status.is_none() {
            return Err(AppError::new(
                "selection",
                "Only unstaged changes can be reverted.",
            ));
        }
        let location = root.join(&file.path);
        let mut ancestor = location.parent().unwrap_or(root);
        while !ancestor.exists() {
            ancestor = ancestor
                .parent()
                .ok_or_else(|| AppError::new("unsafe_path", "Missing repository parent."))?;
        }
        if !ancestor.canonicalize()?.starts_with(root.canonicalize()?) {
            return Err(AppError::new(
                "unsafe_path",
                "A parent symlink leaves the repository.",
            ));
        }
        let before = blob(root, "INDEX", &file.path)?;
        if before.as_ref().is_some_and(|(mode, _)| mode == "160000")
            || worktree(root, &file.path)?
                .as_ref()
                .is_some_and(|(mode, _)| mode == "160000")
        {
            return Err(AppError::new(
                "unsupported_file",
                "Revert submodule changes in another tool.",
            ));
        }
        if before.is_some() {
            tracked.push(file.path.as_str());
        } else {
            untracked.push(file);
        }
    }
    selected_files(root, selections)?;
    if !tracked.is_empty() {
        // Restore may refresh index stat data even for --worktree. Use a private
        // copy so the user's index remains byte-for-byte unchanged and locked.
        let temporary = git::TempIndex::new(root)?;
        fs::copy(git::git_path(root, "index")?, &temporary.0)?;
        let mut input = Vec::new();
        for path in tracked {
            input.extend_from_slice(path.as_bytes());
            input.push(0);
        }
        git::run(
            root,
            &[
                "restore",
                "--worktree",
                "--pathspec-from-file=-",
                "--pathspec-file-nul",
            ],
            Some(&temporary.0),
            &input,
            cancel,
        )?;
    }
    // Git restore cannot restore an untracked file. Remove only selected leaves,
    // never a directory tree; ignored and unselected siblings are untouched.
    for file in untracked {
        current(root, &file.path, &file.version)?;
        if cancel.load(std::sync::atomic::Ordering::Relaxed) {
            return Err(AppError::new(
                "cancelled",
                "Revert stopped; reload to see completed changes.",
            ));
        }
        fs::remove_file(root.join(&file.path))?;
    }
    Ok(())
}
