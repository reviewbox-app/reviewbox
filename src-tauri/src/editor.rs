//! Explicit human source editing. Captures, shared content commands and Git stay separate.
pub(crate) mod commands;
#[cfg(target_os = "macos")]
pub(crate) mod macos;
mod search;
#[cfg(test)]
mod tests;
use crate::{contracts::*, storage::Storage};
use std::{
    fs,
    io::Write,
    path::{Component, Path, PathBuf},
};

pub const MAX_TEXT: u64 = 16 * 1024 * 1024;

pub(crate) fn path(root: &Path, relative: &str) -> AppResult<PathBuf> {
    if relative.is_empty() || relative.contains('\\') || relative.contains('\0') {
        return Err(AppError::new(
            "invalid_path",
            "Choose a repository-relative path.",
        ));
    }
    let mut result = root.to_path_buf();
    for part in Path::new(relative).components() {
        let Component::Normal(name) = part else {
            return Err(AppError::new(
                "invalid_path",
                "The path must stay inside the repository.",
            ));
        };
        if name.to_str().is_some_and(|name| {
            name.eq_ignore_ascii_case(".git") || name.eq_ignore_ascii_case(".reviewbox")
        }) {
            return Err(AppError::new(
                "protected_path",
                "Application and Git metadata are managed separately.",
            ));
        }
        result.push(name);
        if fs::symlink_metadata(&result).is_ok_and(|m| m.file_type().is_symlink()) {
            return Err(AppError::new(
                "symbolic_link",
                "Open the original file instead of editing through a symbolic link.",
            ));
        }
    }
    Ok(result)
}

pub(crate) fn revision(path: &Path) -> AppResult<String> {
    let meta = fs::symlink_metadata(path)?;
    if meta.is_file() {
        if meta.len() > MAX_TEXT {
            return Ok(format!("large:{}:{:?}", meta.len(), meta.modified()?));
        }
        return Ok(fingerprint(&fs::read(path)?));
    }
    let mut entries = fs::read_dir(path)?.collect::<Result<Vec<_>, _>>()?;
    entries.sort_by_key(|e| e.file_name());
    let mut parts = Vec::new();
    for entry in entries {
        let meta = entry.file_type()?;
        let value = if meta.is_symlink() {
            format!("link:{:?}", fs::read_link(entry.path())?)
        } else {
            revision(&entry.path())?
        };
        parts.push((entry.file_name().to_string_lossy().into_owned(), value));
    }
    Ok(fingerprint(&serde_json::to_vec(&parts)?))
}

pub(crate) fn read(root: &Path, relative: &str) -> AppResult<EditorFile> {
    let target = path(root, relative)?;
    read_file(&target, relative.to_owned(), false)
}

pub(crate) fn read_file(target: &Path, display: String, external: bool) -> AppResult<EditorFile> {
    let meta = fs::metadata(target).map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            AppError::new("file_not_found", "This file no longer exists.")
        } else {
            e.into()
        }
    })?;
    if !meta.is_file() {
        return Err(AppError::new("not_file", "Select a regular file."));
    }
    let uri = url::Url::from_file_path(target)
        .map_err(|_| AppError::new("invalid_path", "Invalid file URI."))?
        .to_string();
    if meta.len() > MAX_TEXT {
        return Ok(EditorFile {
            path: display,
            uri,
            text: String::new(),
            revision: revision(target)?,
            read_only: true,
            reason: Some("This file exceeds the 16 MiB editor limit.".into()),
        });
    }
    let bytes = fs::read(target)?;
    let revision = fingerprint(&bytes);
    let text = String::from_utf8(bytes);
    let supported = text.as_ref().is_ok_and(|s| !s.contains('\0'));
    let reason = if !supported {
        Some("Binary or unsupported encoding. The original bytes are preserved.".into())
    } else if external {
        Some("Dependency outside this checkout.".into())
    } else if meta.permissions().readonly() {
        Some("This file is read-only.".into())
    } else {
        None
    };
    let text = text.ok().filter(|_| supported).unwrap_or_default();
    let text = text.strip_prefix('\u{feff}').unwrap_or(&text).to_owned();
    Ok(EditorFile {
        path: display,
        uri,
        text,
        revision,
        read_only: reason.is_some(),
        reason,
    })
}

pub(crate) fn inventory(root: &Path, ignored: bool) -> AppResult<Vec<EditorEntry>> {
    let mut result = Vec::new();
    let mut walk = ignore::WalkBuilder::new(root);
    walk.hidden(false)
        .git_ignore(!ignored)
        .git_exclude(!ignored)
        .git_global(!ignored)
        .follow_links(false)
        .filter_entry(|e| {
            e.depth() == 0 || !matches!(e.file_name().to_str(), Some(".git" | ".reviewbox"))
        });
    for entry in walk.build() {
        let entry = entry.map_err(|e| AppError::new("inventory", e.to_string()))?;
        if entry.depth() == 0 || entry.file_type().is_some_and(|t| t.is_symlink()) {
            continue;
        }
        let relative = entry
            .path()
            .strip_prefix(root)
            .map_err(|e| AppError::new("invalid_path", e.to_string()))?
            .to_str()
            .ok_or_else(|| AppError::new("unsupported_path", "A file name is not UTF-8."))?
            .replace('\\', "/");
        let directory = entry.file_type().is_some_and(|t| t.is_dir());
        // Mutation preconditions are read on demand; inventory must not hash every file.
        result.push(EditorEntry {
            path: relative,
            directory,
            revision: String::new(),
        });
    }
    result.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(result)
}

fn expect_revision(target: &Path, expected: &str) -> AppResult<()> {
    if revision(target)? != expected {
        return Err(AppError::new(
            "editor_conflict",
            "The file changed on disk. Compare it before saving.",
        ));
    }
    Ok(())
}

pub(crate) fn mutate(root: &Path, mutation: EditorMutation) -> AppResult<()> {
    match mutation {
        EditorMutation::Save {
            path: relative,
            text,
            expected_revision,
        } => {
            let target = path(root, &relative)?;
            expect_revision(&target, &expected_revision)?;
            if read(root, &relative)?.read_only {
                return Err(AppError::new("read_only", "This file cannot be edited."));
            }
            if text.contains('\0') {
                return Err(AppError::new(
                    "encoding",
                    "Text files cannot contain NUL bytes.",
                ));
            }
            if text.len() as u64 > MAX_TEXT {
                return Err(AppError::new(
                    "file_size",
                    "The file exceeds the editor limit.",
                ));
            }
            let original = fs::read(&target)?;
            let mut temporary = tempfile::NamedTempFile::new_in(
                target
                    .parent()
                    .ok_or_else(|| AppError::new("invalid_path", "Missing parent folder."))?,
            )?;
            if original.starts_with(&[0xef, 0xbb, 0xbf]) {
                temporary.write_all(&[0xef, 0xbb, 0xbf])?;
            }
            let original_text = std::str::from_utf8(&original)
                .map_err(|e| AppError::new("encoding", e.to_string()))?;
            let text = preserve_line_endings(original_text, &text);
            temporary.write_all(text.as_bytes())?;
            temporary
                .as_file()
                .set_permissions(fs::metadata(&target)?.permissions())?;
            temporary.as_file().sync_all()?;
            expect_revision(&target, &expected_revision)?;
            temporary
                .persist(&target)
                .map_err(|e| AppError::new("save", e.to_string()))?;
        }
        EditorMutation::Create {
            path: relative,
            directory,
        } => {
            let target = path(root, &relative)?;
            if directory {
                fs::create_dir(target)?;
            } else {
                fs::OpenOptions::new()
                    .write(true)
                    .create_new(true)
                    .open(target)?;
            }
        }
        EditorMutation::Rename {
            path: relative,
            destination,
            expected_revision,
        } => {
            let target = path(root, &relative)?;
            let destination = path(root, &destination)?;
            expect_revision(&target, &expected_revision)?;
            if destination.exists() {
                return Err(AppError::new(
                    "path_exists",
                    "The destination already exists.",
                ));
            }
            if destination.starts_with(&target) {
                return Err(AppError::new(
                    "invalid_path",
                    "A folder cannot be moved into itself.",
                ));
            }
            fs::rename(target, destination)?;
        }
        EditorMutation::Trash {
            path: relative,
            expected_revision,
        } => {
            let target = path(root, &relative)?;
            expect_revision(&target, &expected_revision)?;
            trash::delete(target).map_err(|e| AppError::new("trash", e.to_string()))?;
        }
    }
    Ok(())
}

pub(crate) fn recovery(storage: &Storage, repository: &str) -> AppResult<EditorRecovery> {
    match storage.get("editor_recovery", repository) {
        Ok(value) => Ok(value),
        Err(e) if e.code == "not_found" => Ok(EditorRecovery::default()),
        Err(e) => Err(e),
    }
}

/// Monaco may normalize input; retain the original newline convention on disk.
fn preserve_line_endings(original: &str, text: &str) -> String {
    let normalized = text.replace("\r\n", "\n").replace('\r', "\n");
    if original.contains("\r\n") && !original.replace("\r\n", "").contains(['\r', '\n']) {
        normalized.replace('\n', "\r\n")
    } else if original.contains('\r') && !original.contains('\n') {
        normalized.replace('\n', "\r")
    } else if original.contains('\r') {
        // Compare normalized lines, then reapply each unchanged/replaced line's
        // original terminator. Bound diff time for large, completely rewritten files.
        let source = original.strip_prefix('\u{feff}').unwrap_or(original);
        let mut endings = Vec::new();
        let bytes = source.as_bytes();
        let mut index = 0;
        while index < bytes.len() {
            match bytes[index] {
                b'\r' if bytes.get(index + 1) == Some(&b'\n') => {
                    endings.push("\r\n");
                    index += 1;
                }
                b'\r' => endings.push("\r"),
                b'\n' => endings.push("\n"),
                _ => {}
            }
            index += 1;
        }
        let default = ["\r\n", "\n", "\r"]
            .into_iter()
            .max_by_key(|e| endings.iter().filter(|v| *v == e).count())
            .unwrap_or("\n");
        let old = source.replace("\r\n", "\n").replace('\r', "\n");
        let new: Vec<_> = normalized.split_inclusive('\n').collect();
        let diff = similar::TextDiff::configure()
            .timeout(std::time::Duration::from_millis(100))
            .diff_lines(&old, &normalized);
        let mut result = String::new();
        for op in diff.ops() {
            let old_range = op.old_range();
            for (offset, line) in new[op.new_range()].iter().enumerate() {
                result.push_str(line.trim_end_matches('\n'));
                if line.ends_with('\n') {
                    let ending = if old_range.is_empty() {
                        default
                    } else {
                        endings
                            .get(old_range.start + offset.min(old_range.len() - 1))
                            .copied()
                            .unwrap_or(default)
                    };
                    result.push_str(ending);
                }
            }
        }
        result
    } else {
        normalized
    }
}
