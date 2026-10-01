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
    let mut lock = git::IndexLock::acquire(root)?;
    let file = current(root, path, expected)?;
    if file.conflicted {
        return Err(AppError::new(
            "git_conflict",
            "Resolve this conflict in another tool first.",
        ));
    }
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
    // A staged rename has already removed the old index path. Staging further
    // edits to its destination must not add an unrelated recreation at that path.
    let previous = file
        .previous_path
        .as_ref()
        .filter(|_| !stage || file.staged_status.is_none());
    let paths: Vec<_> = previous
        .into_iter()
        .chain(std::iter::once(&file.path))
        .map(String::as_str)
        .collect();
    let mut args = if stage {
        vec!["add", "-A", "--"]
    } else if git::head(root).is_some() {
        vec!["reset", "-q", "HEAD", "--"]
    } else {
        vec!["update-index", "--force-remove", "--"]
    };
    args.extend(paths);
    git::run(root, &args, Some(&temporary.0), &[], cancel)?;
    current(root, path, expected)?;
    if fs::read(git::git_path(root, "index")?).ok() != original {
        return Err(AppError::new(
            "git_changed",
            "The Git index changed in another tool.",
        ));
    }
    lock.publish(root, &temporary.0)
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
