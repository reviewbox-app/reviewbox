use crate::{contracts::*, storage::Storage};
use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
};

pub(super) struct SourceTree {
    pub snapshot_id: String,
    pub key: String,
    pub files: BTreeMap<String, BlobRef>,
    pub change_id: Option<String>,
    pub side: Option<LanguageSide>,
}

fn reverse_layer(tree: &mut BTreeMap<String, BlobRef>, changes: &[Change], layer: &str) {
    // Remove all destinations first: an exact rename is stored as an addition plus a removal.
    for change in changes.iter().filter(|change| change.layer == layer) {
        if change.after.is_some() {
            tree.remove(&change.path);
        }
    }
    for change in changes.iter().filter(|change| change.layer == layer) {
        if let Some(before) = &change.before {
            tree.insert(
                change
                    .previous_path
                    .as_ref()
                    .unwrap_or(&change.path)
                    .clone(),
                before.clone(),
            );
        }
    }
}

pub(super) fn source_tree(
    snapshot: &Snapshot,
    document: &LanguageDocument,
) -> AppResult<SourceTree> {
    crate::snapshots::safe_path(&document.path)?;
    if snapshot.id != document.snapshot_id {
        return Err(AppError::new(
            "invalid_location",
            "The language request refers to another snapshot.",
        ));
    }
    let mut files = snapshot
        .files
        .iter()
        .map(|file| (file.path.clone(), file.content.clone()))
        .collect::<BTreeMap<_, _>>();
    if let Some(change_id) = &document.change_id {
        let change = snapshot
            .changes
            .iter()
            .find(|change| &change.id == change_id)
            .ok_or_else(|| {
                AppError::new("invalid_location", "The change is not in this snapshot.")
            })?;
        let side = document.side.ok_or_else(|| {
            AppError::new(
                "invalid_location",
                "Choose the captured side of this change.",
            )
        })?;
        let valid_layer = match snapshot.request.scope {
            Scope::Local => matches!(change.layer.as_str(), "staged" | "unstaged"),
            Scope::Staged => change.layer == "staged",
            Scope::Unstaged => change.layer == "unstaged",
            Scope::Commit | Scope::Range => change.layer == "committed",
        };
        if !valid_layer {
            return Err(AppError::new(
                "invalid_location",
                "This change has no coherent captured source layer.",
            ));
        }
        // The change selects a coherent tree. Cross-file definitions retain this
        // same context while changing path/hash to their own captured bytes.
        match snapshot.request.scope {
            Scope::Local => {
                if change.layer == "staged" || side == LanguageSide::Before {
                    reverse_layer(&mut files, &snapshot.changes, "unstaged");
                }
                if change.layer == "staged" && side == LanguageSide::Before {
                    reverse_layer(&mut files, &snapshot.changes, "staged");
                }
            }
            _ if side == LanguageSide::Before => {
                reverse_layer(&mut files, &snapshot.changes, &change.layer)
            }
            _ => {}
        }
    } else if document.side.is_some() {
        return Err(AppError::new(
            "invalid_location",
            "A diff side needs a captured change.",
        ));
    }
    let blob = files.get(&document.path).ok_or_else(|| {
        AppError::new(
            "invalid_location",
            "This file is absent from the selected snapshot version.",
        )
    })?;
    if blob.hash != document.content_hash {
        return Err(AppError::new(
            "stale_language_document",
            "This model no longer matches its captured source.",
        ));
    }
    if !matches!(blob.mode.as_str(), "100644" | "100755") {
        return Err(AppError::new(
            "unsupported_content",
            "Language services require a regular captured text file.",
        ));
    }
    let key = fingerprint(&serde_json::to_vec(&(&snapshot.id, &files))?);
    Ok(SourceTree {
        snapshot_id: snapshot.id.clone(),
        key,
        files,
        change_id: document.change_id.clone(),
        side: document.side,
    })
}

pub(super) struct Workspace {
    pub source: SourceTree,
    _directory: tempfile::TempDir,
    root: PathBuf,
}

impl Workspace {
    pub fn create(storage: &Storage, source: SourceTree) -> AppResult<Self> {
        let directory = tempfile::Builder::new()
            .prefix("reviewbox-language-")
            .tempdir()?;
        for (path, blob) in &source.files {
            if !matches!(blob.mode.as_str(), "100644" | "100755") {
                continue;
            }
            crate::snapshots::safe_path(path)?;
            let destination = directory.path().join(path);
            if let Some(parent) = destination.parent() {
                std::fs::create_dir_all(parent)?;
            }
            let bytes = storage.read_blob(&blob.hash)?;
            if bytes.len() != blob.size as usize || fingerprint(&bytes) != blob.hash {
                return Err(AppError::new(
                    "corrupt_content",
                    "Captured source failed its integrity check.",
                ));
            }
            std::fs::write(&destination, bytes)?;
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                std::fs::set_permissions(&destination, std::fs::Permissions::from_mode(0o444))?;
            }
        }
        let root = directory.path().canonicalize()?;
        Ok(Self {
            source,
            _directory: directory,
            root,
        })
    }
    pub fn root(&self) -> &Path {
        &self.root
    }
    pub fn uri(&self, path: &str) -> AppResult<url::Url> {
        url::Url::from_file_path(self.root().join(path))
            .map_err(|_| AppError::new("invalid_location", "Invalid captured source URI."))
    }
    pub fn text(&self, path: &str) -> AppResult<String> {
        crate::snapshots::safe_path(path)?;
        let blob = self.source.files.get(path).ok_or_else(|| {
            AppError::new(
                "external_definition",
                "The target is outside this captured version.",
            )
        })?;
        let bytes = std::fs::read(self.root().join(path))?;
        if fingerprint(&bytes) != blob.hash {
            return Err(AppError::new(
                "stale_language_document",
                "The language workspace no longer matches the captured source.",
            ));
        }
        let text = String::from_utf8(bytes).map_err(|_| {
            AppError::new(
                "unsupported_content",
                "This captured file is not UTF-8 text.",
            )
        })?;
        if text.contains('\0') {
            return Err(AppError::new(
                "unsupported_content",
                "Binary files have no language services.",
            ));
        }
        Ok(text)
    }
    pub fn location(&self, uri: &str, range: &serde_json::Value) -> AppResult<LanguageLocation> {
        let absolute = url::Url::parse(uri)
            .ok()
            .and_then(|uri| uri.to_file_path().ok())
            .ok_or_else(|| {
                AppError::new("external_definition", "The target is not a captured file.")
            })?;
        let relative: PathBuf = absolute
            .strip_prefix(self.root())
            .map_err(|_| {
                AppError::new(
                    "external_definition",
                    "The target is outside this captured version.",
                )
            })?
            .into();
        let path = relative
            .to_str()
            .ok_or_else(|| AppError::new("invalid_location", "The target path is not UTF-8."))?
            .replace('\\', "/");
        let text = self.text(&path)?;
        let range = parse_range(&text, range)?;
        Ok(LanguageLocation {
            document: LanguageDocument {
                snapshot_id: self.source.snapshot_id.clone(),
                content_hash: self.source.files[&path].hash.clone(),
                path,
                change_id: self.source.change_id.clone(),
                side: self.source.side,
            },
            range,
        })
    }
}

pub(super) fn validate_position(text: &str, line: u32, column: u32) -> AppResult<()> {
    if line == 0 || column == 0 {
        return Err(AppError::new(
            "invalid_location",
            "Source positions are one-based.",
        ));
    }
    let row = text
        .split('\n')
        .nth(line as usize - 1)
        .ok_or_else(|| AppError::new("invalid_location", "The source line does not exist."))?
        .trim_end_matches('\r');
    validate_row_position(row, column)
}

pub(super) fn validate_row_position(row: &str, column: u32) -> AppResult<()> {
    let target = column
        .checked_sub(1)
        .ok_or_else(|| AppError::new("invalid_location", "Source positions are one-based."))?
        as usize;
    let mut offset = 0;
    for character in row.chars() {
        if offset == target {
            return Ok(());
        }
        offset += character.len_utf16();
    }
    if offset == target {
        Ok(())
    } else {
        Err(AppError::new(
            "invalid_location",
            "The UTF-16 source column is invalid.",
        ))
    }
}

pub(super) fn parse_range(text: &str, value: &serde_json::Value) -> AppResult<LanguageRange> {
    let coordinate = |part: &str, key: &str| {
        value[part][key]
            .as_u64()
            .and_then(|value| u32::try_from(value).ok())
            .and_then(|value| value.checked_add(1))
            .ok_or_else(|| AppError::new("lsp_protocol", "The server returned an invalid range."))
    };
    let range = LanguageRange {
        start_line: coordinate("start", "line")?,
        start_column: coordinate("start", "character")?,
        end_line: coordinate("end", "line")?,
        end_column: coordinate("end", "character")?,
    };
    validate_position(text, range.start_line, range.start_column)?;
    validate_position(text, range.end_line, range.end_column)?;
    if (range.start_line, range.start_column) > (range.end_line, range.end_column) {
        return Err(AppError::new(
            "lsp_protocol",
            "The server returned a reversed range.",
        ));
    }
    Ok(range)
}
