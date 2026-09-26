use crate::{
    contracts::*,
    repositories::{git, resolve, root, text},
    storage::Storage,
};
use similar::{DiffTag, TextDiff};
use std::{
    collections::BTreeMap,
    fs,
    io::{BufRead, BufReader, Read, Write},
    path::{Component, Path},
    process::{Command, Stdio},
};

pub(crate) type Tree = BTreeMap<String, BlobRef>;
const EMPTY_TREE: &str = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
const MAX_FILE: u64 = 64 * 1024 * 1024;

pub fn is_metadata(path: &str) -> bool {
    path == ".reviewbox" || path.starts_with(".reviewbox/")
}

pub fn safe_path(path: &str) -> AppResult<()> {
    if path.is_empty()
        || Path::new(path).is_absolute()
        || Path::new(path)
            .components()
            .any(|c| !matches!(c, Component::Normal(_)))
    {
        return Err(AppError::new(
            "invalid_path",
            "Expected a repository-relative path.",
        ));
    }
    Ok(())
}
fn utf8(bytes: &[u8]) -> AppResult<String> {
    String::from_utf8(bytes.to_vec())
        .map_err(|_| AppError::new("unsupported_path", "A repository filename is not UTF-8."))
}
pub(crate) fn git_tree(storage: &Storage, root: &Path, reference: &str) -> AppResult<Tree> {
    let data = if reference == "INDEX" {
        git(root, &["ls-files", "--stage", "-z"])?
    } else {
        git(root, &["ls-tree", "-rz", reference])?
    };
    let mut child = Command::new("git")
        .args(["cat-file", "--batch"])
        .env("GIT_NO_LAZY_FETCH", "1")
        .env("GIT_NO_REPLACE_OBJECTS", "1")
        .current_dir(root)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()?;
    let result = (|| {
        let mut input = child
            .stdin
            .take()
            .ok_or_else(|| AppError::new("process", "Missing Git input."))?;
        let mut output = BufReader::new(
            child
                .stdout
                .take()
                .ok_or_else(|| AppError::new("process", "Missing Git output."))?,
        );
        let mut tree = Tree::new();
        let mut sources = Vec::new();
        for entry in data.split(|b| *b == 0).filter(|v| !v.is_empty()) {
            let separator = entry
                .iter()
                .position(|b| *b == b'\t')
                .ok_or_else(|| AppError::new("git", "Malformed Git tree."))?;
            let metadata = utf8(&entry[..separator])?;
            let fields: Vec<_> = metadata.split(' ').collect();
            if fields.len() != 3 {
                return Err(AppError::new("git", "Malformed Git entry."));
            }
            if reference == "INDEX" && fields[2] != "0" {
                return Err(AppError::new(
                    "merge_conflict",
                    "Resolve the index conflicts before capturing a review.",
                ));
            }
            let path = utf8(&entry[separator + 1..])?;
            safe_path(&path)?;
            if is_metadata(&path) {
                continue;
            }
            let object = if reference == "INDEX" {
                fields[1]
            } else {
                fields[2]
            };
            let blob = if fields[0] == "160000" {
                storage.blob(object.as_bytes(), fields[0].into())?
            } else {
                writeln!(input, "{object}")?;
                input.flush()?;
                let mut header = String::new();
                output.read_line(&mut header)?;
                let size = header
                    .split_whitespace()
                    .nth(2)
                    .and_then(|v| v.parse::<usize>().ok())
                    .ok_or_else(|| AppError::new("git", "Git object is unavailable."))?;
                if size as u64 > MAX_FILE {
                    return Err(AppError::new(
                        "large_file",
                        format!("{path} exceeds the 64 MiB capture limit."),
                    ));
                }
                let mut bytes = vec![0; size];
                output.read_exact(&mut bytes)?;
                let mut newline = [0];
                output.read_exact(&mut newline)?;
                storage.blob(&bytes, fields[0].into())?
            };
            if reference != "INDEX" && fields[0] != "160000" {
                sources.push((blob.hash.clone(), object.to_string()));
            }
            tree.insert(path, blob);
        }
        storage.record_git_blobs(root, reference, &sources)?;
        Ok(tree)
    })();
    let _ = child.kill();
    let _ = child.wait();
    result
}
fn working_tree(storage: &Storage, root: &Path, index: &Tree, untracked: bool) -> AppResult<Tree> {
    let mut paths: Vec<String> = index.keys().cloned().collect();
    if untracked {
        for path in git(root, &["ls-files", "--others", "--exclude-standard", "-z"])?
            .split(|b| *b == 0)
            .filter(|s| !s.is_empty())
        {
            paths.push(utf8(path)?);
        }
    }
    let mut tree = Tree::new();
    for path in paths {
        if is_metadata(&path) {
            continue;
        }
        safe_path(&path)?;
        let file = root.join(&path);
        let metadata = match fs::symlink_metadata(&file) {
            Ok(m) => m,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue,
            Err(e) => return Err(e.into()),
        };
        // Reject symlinked parent directories; leaf symlinks are captured as link text.
        if let Some(parent) = file.parent()
            && !parent.canonicalize()?.starts_with(root)
        {
            return Err(AppError::new(
                "external_path",
                format!("{path} points outside the repository."),
            ));
        }
        let (bytes, mode) = if metadata.is_symlink() {
            (
                fs::read_link(&file)?.to_string_lossy().as_bytes().to_vec(),
                "120000".into(),
            )
        } else if metadata.is_dir() {
            if let Some(blob) = index.get(&path) {
                tree.insert(path, blob.clone());
            }
            continue;
        } else {
            if metadata.len() > MAX_FILE {
                return Err(AppError::new(
                    "large_file",
                    format!("{path} exceeds the 64 MiB capture limit."),
                ));
            }
            #[cfg(unix)]
            let mode = {
                use std::os::unix::fs::PermissionsExt;
                if metadata.permissions().mode() & 0o111 != 0 {
                    "100755"
                } else {
                    "100644"
                }
            };
            #[cfg(not(unix))]
            let mode = "100644";
            (fs::read(file)?, mode.into())
        };
        tree.insert(path, storage.blob(&bytes, mode)?);
    }
    Ok(tree)
}
fn tree_hash(tree: &Tree) -> AppResult<String> {
    Ok(fingerprint(&serde_json::to_vec(tree)?))
}
pub fn workspace_fingerprint(storage: &Storage, root: &Path, untracked: bool) -> AppResult<String> {
    let index = git_tree(storage, root, "INDEX")?;
    tree_hash(&working_tree(storage, root, &index, untracked)?)
}
fn changed(storage: &Storage, before: &Tree, after: &Tree, layer: &str) -> AppResult<Vec<Change>> {
    let mut changes = Vec::new();
    let paths: std::collections::BTreeSet<_> = before.keys().chain(after.keys()).collect();
    for path in paths {
        let left = before.get(path);
        let right = after.get(path);
        if left.map(|v| (&v.hash, &v.mode)) == right.map(|v| (&v.hash, &v.mode)) {
            continue;
        }
        let old = left
            .map(|b| storage.read_blob(&b.hash))
            .transpose()?
            .unwrap_or_default();
        let new = right
            .map(|b| storage.read_blob(&b.hash))
            .transpose()?
            .unwrap_or_default();
        let binary = old.contains(&0)
            || new.contains(&0)
            || std::str::from_utf8(&old).is_err()
            || std::str::from_utf8(&new).is_err()
            || left.is_some_and(|v| v.mode == "160000")
            || right.is_some_and(|v| v.mode == "160000");
        let mut passages = Vec::new();
        if !binary {
            let old_text = std::str::from_utf8(&old)
                .map_err(|_| AppError::new("encoding", "Invalid text."))?;
            let new_text = std::str::from_utf8(&new)
                .map_err(|_| AppError::new("encoding", "Invalid text."))?;
            let diff = TextDiff::from_lines(old_text, new_text);
            let old_lines: Vec<_> = old_text.split_inclusive('\n').collect();
            let new_lines: Vec<_> = new_text.split_inclusive('\n').collect();
            for op in diff.ops() {
                if op.tag() == DiffTag::Equal {
                    continue;
                }
                let a = op.old_range();
                let b = op.new_range();
                let content = serde_json::to_vec(&(
                    old_lines[a.clone()].join(""),
                    new_lines[b.clone()].join(""),
                    left.map(|v| &v.mode),
                    right.map(|v| &v.mode),
                ))?;
                passages.push(Passage {
                    id: id(),
                    old_start: a.start as u32 + 1,
                    old_lines: a.len() as u32,
                    new_start: b.start as u32 + 1,
                    new_lines: b.len() as u32,
                    fingerprint: fingerprint(&content),
                });
            }
        }
        if passages.is_empty() {
            passages.push(Passage {
                id: id(),
                old_start: 1,
                old_lines: 0,
                new_start: 1,
                new_lines: 0,
                fingerprint: fingerprint(&serde_json::to_vec(&(left, right))?),
            });
        }
        changes.push(Change {
            id: id(),
            path: path.clone(),
            previous_path: None,
            layer: layer.into(),
            before: left.cloned(),
            after: right.cloned(),
            binary,
            passages,
        });
    }
    // Exact renames are explicit links; edited moves remain separate until reviewed.
    let removed: Vec<_> = changes
        .iter()
        .filter(|c| c.after.is_none())
        .filter_map(|c| c.before.as_ref().map(|b| (c.path.clone(), b.hash.clone())))
        .collect();
    for c in &mut changes {
        if c.before.is_none()
            && let Some(after) = &c.after
        {
            let matches: Vec<_> = removed
                .iter()
                .filter(|(_, hash)| hash == &after.hash)
                .collect();
            if matches.len() == 1 {
                c.previous_path = Some(matches[0].0.clone());
            }
        }
    }
    Ok(changes)
}
pub fn capture(storage: &Storage, request: CaptureRequest) -> AppResult<Snapshot> {
    let root = root(storage, &request.repository_id)?;
    let head =
        text(&root, &["rev-parse", "--verify", "HEAD"]).unwrap_or_else(|_| EMPTY_TREE.into());
    let head_tree = git_tree(storage, &root, &head)?;
    let index = git_tree(storage, &root, "INDEX")?;
    let working = working_tree(storage, &root, &index, request.include_untracked)?;
    let before_hash = tree_hash(&working)?;
    let mut git_refs = vec![head.clone()];
    let (changes, files) = match request.scope {
        Scope::Local => {
            let mut changes =
                changed(storage, &git_tree(storage, &root, &head)?, &index, "staged")?;
            changes.extend(changed(storage, &index, &working, "unstaged")?);
            (changes, working)
        }
        Scope::Staged => (
            changed(storage, &git_tree(storage, &root, &head)?, &index, "staged")?,
            index.clone(),
        ),
        Scope::Unstaged => (changed(storage, &index, &working, "unstaged")?, working),
        Scope::Commit | Scope::Range => {
            let target = resolve(&root, request.target.as_deref().unwrap_or("HEAD"))?;
            let base = if request.scope == Scope::Commit {
                text(&root, &["rev-parse", "--verify", &format!("{target}^1")])
                    .unwrap_or_else(|_| EMPTY_TREE.into())
            } else {
                resolve(&root, request.base.as_deref().unwrap_or("HEAD"))?
            };
            git_refs.extend([base.clone(), target.clone()]);
            let after = git_tree(storage, &root, &target)?;
            (
                changed(
                    storage,
                    &git_tree(storage, &root, &base)?,
                    &after,
                    "committed",
                )?,
                after,
            )
        }
    };
    if text(&root, &["rev-parse", "--verify", "HEAD"]).unwrap_or_else(|_| EMPTY_TREE.into()) != head
        || tree_hash(&git_tree(storage, &root, "INDEX")?)? != tree_hash(&index)?
        || workspace_fingerprint(storage, &root, request.include_untracked)? != before_hash
    {
        return Err(AppError::new(
            "capture_changed",
            "The repository changed during capture. Please retry.",
        ));
    }
    let snapshot = Snapshot {
        git_refs,
        head_fingerprint: tree_hash(&head_tree)?,
        id: id(),
        repository_id: request.repository_id.clone(),
        created_at: now(),
        request,
        head,
        workspace_fingerprint: before_hash,
        index_fingerprint: tree_hash(&index)?,
        changes,
        files: files
            .into_iter()
            .map(|(path, content)| SnapshotFile { path, content })
            .collect(),
    };
    storage.insert("snapshot", &snapshot.id, &snapshot)?;
    Ok(snapshot)
}
pub fn content(storage: &Storage, snapshot_id: &str, change_id: &str) -> AppResult<FileContent> {
    let snapshot: Snapshot = storage.get("snapshot", snapshot_id)?;
    let change = snapshot
        .changes
        .iter()
        .find(|c| c.id == change_id)
        .ok_or_else(|| AppError::new("not_found", "Change not found."))?;
    if change.binary {
        return Ok(FileContent{before:None,after:None,unavailable_reason:Some("Binary, submodule or unsupported text encoding. Review the content hashes before acknowledging this change.".into())});
    }
    let read = |blob: &Option<BlobRef>| -> AppResult<Option<String>> {
        blob.as_ref()
            .map(|b| {
                if b.size > 2 * 1024 * 1024 {
                    return Err(AppError::new(
                        "large_preview",
                        "This file exceeds the 2 MiB editor preview limit.",
                    ));
                }
                String::from_utf8(storage.read_blob(&b.hash)?)
                    .map_err(|_| AppError::new("encoding", "Unsupported text encoding."))
            })
            .transpose()
    };
    Ok(FileContent {
        before: read(&change.before)?,
        after: read(&change.after)?,
        unavailable_reason: None,
    })
}

pub fn repository_changed(storage: &Storage, snapshot: &Snapshot) -> AppResult<bool> {
    let root = root(storage, &snapshot.repository_id)?;
    let head =
        text(&root, &["rev-parse", "--verify", "HEAD"]).unwrap_or_else(|_| EMPTY_TREE.into());
    let index = git_tree(storage, &root, "INDEX")?;
    let head_changed = if snapshot.head_fingerprint.is_empty() {
        tree_hash(&git_tree(storage, &root, &head)?)?
            != tree_hash(&git_tree(storage, &root, &snapshot.head)?)?
    } else {
        tree_hash(&git_tree(storage, &root, &head)?)? != snapshot.head_fingerprint
    };
    Ok(head_changed
        || (!snapshot.index_fingerprint.is_empty()
            && tree_hash(&index)? != snapshot.index_fingerprint)
        || tree_hash(&working_tree(
            storage,
            &root,
            &index,
            snapshot.request.include_untracked,
        )?)? != snapshot.workspace_fingerprint)
}
