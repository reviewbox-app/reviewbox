//! Snapshot-local source indexes and immutable, bounded byte-delta packs.
use super::{Document, Documents, Files, Project, VERSION, checked, identifier};
use crate::{contracts::*, storage::Storage};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::PathBuf;
use std::{collections::BTreeMap, fs, path::Path};

const SOURCE_LIMIT: usize = 64 * 1024 * 1024;
const PACK_LIMIT: usize = 140 * 1024 * 1024;
pub type SourceIndex = BTreeMap<String, ContentSource>;

#[derive(Clone, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub enum ContentSource {
    Git { oid: String, size: u32 },
    Pack { path: String, size: u32 },
}
impl ContentSource {
    fn size(&self) -> u32 {
        match self {
            Self::Git { size, .. } | Self::Pack { size, .. } => *size,
        }
    }
}
#[derive(Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub(super) struct StoredSnapshot {
    #[serde(flatten)]
    snapshot: Snapshot,
    source_index: SourceIndex,
}
#[derive(Clone)]
pub(super) struct LocatedSource {
    pub root: PathBuf,
    pub snapshot_id: String,
    source: ContentSource,
}
#[derive(Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ByteDelta {
    size: u32,
    base_oid: Option<String>,
    prefix: usize,
    suffix: usize,
    #[serde(flatten)]
    replacement: Replacement,
}
#[derive(Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
enum Replacement {
    Text(String),
    Hex(String),
}
#[derive(Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct ContentPack {
    format: String,
    version: u32,
    snapshot_id: String,
    entries: BTreeMap<String, ByteDelta>,
}
fn valid_hash(hash: &str) -> AppResult<()> {
    if hash.len() != 64 || !hash.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(AppError::new("invalid_hash", "Invalid content hash."));
    }
    Ok(())
}
fn valid_oid(oid: &str) -> AppResult<()> {
    if ![40, 64].contains(&oid.len()) || !oid.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(AppError::new(
            "invalid_oid",
            "Invalid Git object identifier.",
        ));
    }
    Ok(())
}
fn git_bytes(root: &Path, oid: &str) -> AppResult<Vec<u8>> {
    valid_oid(oid)?;
    let size = crate::repositories::text(root, &["cat-file", "-s", oid])
        .ok()
        .and_then(|s| s.parse::<u64>().ok());
    if size.is_some_and(|n| n > SOURCE_LIMIT as u64) {
        return Err(AppError::new(
            "content_limit",
            "Git source exceeds the 64 MiB content limit.",
        ));
    }
    crate::repositories::git(root, &["cat-file", "blob", oid]).map_err(|_| AppError::new("missing_git_object", format!("Git object {oid} is unavailable. Fetch the review's base commit; current code was not substituted.")))
}
fn blobs(snapshot: &Snapshot) -> BTreeMap<String, (BlobRef, Option<String>)> {
    let mut result = BTreeMap::new();
    for file in &snapshot.files {
        result.insert(file.content.hash.clone(), (file.content.clone(), None));
    }
    for change in &snapshot.changes {
        if let Some(before) = &change.before {
            result
                .entry(before.hash.clone())
                .or_insert((before.clone(), None));
        }
        if let Some(after) = &change.after {
            let candidate = (
                after.clone(),
                change.before.as_ref().map(|b| b.hash.clone()),
            );
            let entry = result
                .entry(after.hash.clone())
                .or_insert_with(|| candidate.clone());
            if entry.1.is_none() {
                *entry = candidate;
            }
        }
    }
    result
}
pub fn prepare_content(
    storage: &Storage,
    project: &Project,
    snapshot: &Snapshot,
) -> AppResult<(SourceIndex, Files)> {
    identifier(&snapshot.id)?;
    let root = project.root.parent().unwrap();
    let references = if snapshot.git_refs.is_empty() {
        vec![snapshot.head.clone()]
    } else {
        snapshot.git_refs.clone()
    };
    let git_sources = storage.git_sources(root, &references)?;
    let mut sources = SourceIndex::new();
    let mut deltas = BTreeMap::new();
    for (hash, (blob, base_hash)) in blobs(snapshot) {
        valid_hash(&hash)?;
        if blob.size as usize > SOURCE_LIMIT {
            return Err(AppError::new("content_limit", "Source exceeds 64 MiB."));
        }
        if let Some(oid) = git_sources.get(&hash) {
            sources.insert(
                hash,
                ContentSource::Git {
                    oid: oid.clone(),
                    size: blob.size,
                },
            );
            continue;
        }
        let content = storage.cached_blob(&hash)?;
        if content.len() != blob.size as usize {
            return Err(AppError::new(
                "corrupt_content",
                "Source size does not match the snapshot.",
            ));
        }
        // Only bases from this repository's pinned Git trees are portable.
        let base_oid = base_hash.as_ref().and_then(|h| git_sources.get(h)).cloned();
        let base = base_oid
            .as_deref()
            .map(|oid| git_bytes(root, oid))
            .transpose()?
            .unwrap_or_default();
        let prefix = base
            .iter()
            .zip(&content)
            .take_while(|(a, b)| a == b)
            .count();
        let suffix = base[prefix..]
            .iter()
            .rev()
            .zip(content[prefix..].iter().rev())
            .take_while(|(a, b)| a == b)
            .count();
        let inserted = &content[prefix..content.len() - suffix];
        let replacement = replacement(inserted);
        deltas.insert(
            hash,
            ByteDelta {
                size: blob.size,
                base_oid,
                prefix,
                suffix,
                replacement,
            },
        );
    }
    let packs = pack_deltas(&snapshot.id, deltas, &mut sources, PACK_LIMIT)?;
    Ok((sources, packs))
}
fn replacement(inserted: &[u8]) -> Replacement {
    // JSON control-character escaping can be 6x larger than the source. Hex
    // keeps every supported 64 MiB source below the 140 MiB single-pack cap.
    let escaped_len: usize = inserted
        .iter()
        .map(|b| match b {
            b'"' | b'\\' | b'\n' | b'\r' | b'\t' | 8 | 12 => 2,
            0..=31 => 6,
            _ => 1,
        })
        .sum();
    if escaped_len <= inserted.len() * 2
        && let Ok(text) = std::str::from_utf8(inserted)
    {
        Replacement::Text(text.into())
    } else {
        Replacement::Hex(inserted.iter().map(|b| format!("{b:02x}")).collect())
    }
}
fn pack_deltas(
    snapshot_id: &str,
    deltas: BTreeMap<String, ByteDelta>,
    sources: &mut SourceIndex,
    limit: usize,
) -> AppResult<Files> {
    // Serialize each entry once; count the exact JSON bytes without repeatedly
    // serializing a growing pack (large captures must remain linear in size).
    let mut files = Files::new();
    let header = format!(
        "{{\"format\":\"reviewbox\",\"version\":{VERSION},\"snapshotId\":{},\"entries\":{{\n",
        serde_json::to_string(snapshot_id)?
    );
    let footer = "\n}}\n";
    let mut body = header.clone();
    let mut count = 0;
    for (hash, delta) in deltas {
        let entry = format!(
            "{}:{}",
            serde_json::to_string(&hash)?,
            serde_json::to_string(&delta)?
        );
        if header.len() + entry.len() + footer.len() > limit {
            return Err(AppError::new(
                "content_limit",
                "A single delta exceeds the content pack limit.",
            ));
        }
        let separator = if count == 0 { "" } else { ",\n" };
        if body.len() + separator.len() + entry.len() + footer.len() > limit {
            body.push_str(footer);
            files.insert(
                format!("content/{snapshot_id}/{:04}.json", files.len() + 1),
                body.into_bytes(),
            );
            body = header.clone();
            count = 0;
        }
        let path = format!("content/{snapshot_id}/{:04}.json", files.len() + 1);
        sources.insert(
            hash,
            ContentSource::Pack {
                path,
                size: delta.size,
            },
        );
        if count > 0 {
            body.push_str(",\n");
        }
        body.push_str(&entry);
        count += 1;
    }
    if count > 0 {
        body.push_str(footer);
        files.insert(
            format!("content/{snapshot_id}/{:04}.json", files.len() + 1),
            body.into_bytes(),
        );
    }
    Ok(files)
}
pub(super) fn snapshot_sources(data: &serde_json::Value) -> AppResult<(String, SourceIndex)> {
    let stored: StoredSnapshot = serde_json::from_value(data.clone())?;
    identifier(&stored.snapshot.id)?;
    let expected = blobs(&stored.snapshot);
    if expected.len() != stored.source_index.len() {
        return Err(AppError::new(
            "invalid_content",
            "Snapshot source index does not match its contents.",
        ));
    }
    for (hash, source) in &stored.source_index {
        valid_hash(hash)?;
        if source.size() as usize > SOURCE_LIMIT
            || expected
                .get(hash)
                .is_none_or(|(blob, _)| blob.size != source.size())
        {
            return Err(AppError::new(
                "invalid_content",
                "Invalid snapshot source size or hash.",
            ));
        }
        match source {
            ContentSource::Git { oid, .. } => valid_oid(oid)?,
            ContentSource::Pack { path, .. } => {
                let prefix = format!("content/{}/", stored.snapshot.id);
                let part = path
                    .strip_prefix(&prefix)
                    .and_then(|s| s.strip_suffix(".json"));
                if !part.is_some_and(|s| {
                    s.len() >= 4
                        && s.bytes().all(|b| b.is_ascii_digit())
                        && s.parse::<u32>().is_ok_and(|n| n > 0)
                }) {
                    return Err(AppError::new(
                        "invalid_content",
                        "Content pack must belong to its snapshot.",
                    ));
                }
            }
        }
    }
    Ok((stored.snapshot.id, stored.source_index))
}
pub(super) fn index_sources(docs: &Documents) -> AppResult<BTreeMap<String, LocatedSource>> {
    let mut index = BTreeMap::new();
    for ((kind, _), data) in docs {
        if kind != "snapshot" {
            continue;
        }
        let (snapshot_id, sources) = snapshot_sources(data)?;
        for (hash, source) in sources {
            index.entry(hash).or_insert_with(|| LocatedSource {
                root: PathBuf::new(),
                snapshot_id: snapshot_id.clone(),
                source,
            });
        }
    }
    Ok(index)
}
pub fn restore_content(project: &Project, hash: &str) -> AppResult<Option<Vec<u8>>> {
    valid_hash(hash)?;
    let Some(located) = project.sources.lock().unwrap().get(hash).cloned() else {
        return Ok(None);
    };
    let root = project.root.parent().unwrap();
    let size = located.source.size();
    let result = match located.source {
        ContentSource::Git { oid, .. } => git_bytes(root, &oid)?,
        ContentSource::Pack { path, .. } => {
            let path = checked(
                if located.root.as_os_str().is_empty() {
                    &project.root
                } else {
                    &located.root
                },
                &path,
            )?;
            let metadata = path.metadata().map_err(|_| {
                AppError::new(
                    "missing_content",
                    "A snapshot content pack is unavailable. Restore it from the shared project.",
                )
            })?;
            if metadata.len() > PACK_LIMIT as u64 {
                return Err(AppError::new(
                    "content_limit",
                    "Content pack exceeds 140 MiB.",
                ));
            }
            let mut pack: ContentPack = serde_json::from_slice(&fs::read(path)?)?;
            if pack.format != "reviewbox"
                || pack.version != VERSION
                || pack.snapshot_id != located.snapshot_id
            {
                return Err(AppError::new(
                    "invalid_content",
                    "Invalid snapshot content pack.",
                ));
            }
            let delta = pack.entries.remove(hash).ok_or_else(|| {
                AppError::new(
                    "missing_content",
                    "Content is missing from its snapshot pack.",
                )
            })?;
            if delta.size != size {
                return Err(AppError::new(
                    "invalid_content",
                    "Content pack size disagrees with the snapshot.",
                ));
            }
            reconstruct(root, delta)?
        }
    };
    if result.len() != size as usize || fingerprint(&result) != hash {
        return Err(AppError::new(
            "corrupt_content",
            "Reconstructed content failed its integrity check.",
        ));
    }
    Ok(Some(result))
}
fn reconstruct(root: &Path, delta: ByteDelta) -> AppResult<Vec<u8>> {
    let base = delta
        .base_oid
        .as_deref()
        .map(|oid| git_bytes(root, oid))
        .transpose()?
        .unwrap_or_default();
    reconstruct_bytes(&base, delta)
}

fn reconstruct_bytes(base: &[u8], delta: ByteDelta) -> AppResult<Vec<u8>> {
    if delta.prefix > base.len() || delta.suffix > base.len() - delta.prefix {
        return Err(AppError::new("invalid_delta", "Invalid byte delta bounds."));
    }
    let replacement = match delta.replacement {
        Replacement::Text(text) => text.into_bytes(),
        Replacement::Hex(hex) => {
            if hex.len() % 2 != 0 || !hex.bytes().all(|b| b.is_ascii_hexdigit()) {
                return Err(AppError::new(
                    "invalid_delta",
                    "Invalid hexadecimal replacement.",
                ));
            }
            (0..hex.len())
                .step_by(2)
                .map(|i| {
                    u8::from_str_radix(&hex[i..i + 2], 16)
                        .map_err(|_| AppError::new("invalid_delta", "Invalid byte."))
                })
                .collect::<AppResult<Vec<_>>>()?
        }
    };
    if delta.size as usize > SOURCE_LIMIT
        || delta.prefix + delta.suffix + replacement.len() != delta.size as usize
    {
        return Err(AppError::new(
            "corrupt_content",
            "Delta size does not match the snapshot.",
        ));
    }
    Ok([
        base[..delta.prefix].to_vec(),
        replacement,
        base[base.len() - delta.suffix..].to_vec(),
    ]
    .concat())
}

fn reachable_objects(
    project: &Project,
    commit: &str,
) -> AppResult<std::collections::BTreeSet<String>> {
    let root = project.root.parent().unwrap();
    if commit == "HEAD"
        && crate::repositories::git(root, &["rev-parse", "--verify", "HEAD"]).is_err()
    {
        return Ok(Default::default());
    }
    let output = crate::repositories::git(root, &["rev-list", "--objects", commit])?;
    Ok(String::from_utf8_lossy(&output)
        .lines()
        .filter_map(|line| line.split_whitespace().next().map(String::from))
        .collect())
}
/// Remove dependencies on objects not retained by the publication's ancestry.
/// A standalone replacement is used for those entries, preserving exact bytes.
pub(crate) fn portable_snapshot(project: &Project, data: &mut Value) -> AppResult<Files> {
    let reachable = reachable_objects(project, "HEAD").unwrap_or_default();
    let (snapshot_id, mut sources) = snapshot_sources(data)?;
    let mut replacements = BTreeMap::new();
    for (hash, source) in &sources {
        let safe = match source {
            ContentSource::Git { oid, .. } => reachable.contains(oid),
            ContentSource::Pack { path, .. } => {
                let root = project.document_root("snapshot", &snapshot_id);
                let pack: ContentPack = serde_json::from_slice(&fs::read(checked(&root, path)?)?)?;
                let delta = pack
                    .entries
                    .get(hash)
                    .ok_or_else(|| AppError::new("missing_content", "Missing source entry."))?;
                delta
                    .base_oid
                    .as_ref()
                    .is_none_or(|oid| reachable.contains(oid))
            }
        };
        if !safe {
            let content = restore_content(project, hash)?.ok_or_else(|| {
                AppError::new("missing_content", "Cannot publish missing source.")
            })?;
            replacements.insert(
                hash.clone(),
                ByteDelta {
                    size: content.len() as u32,
                    base_oid: None,
                    prefix: 0,
                    suffix: 0,
                    replacement: replacement(&content),
                },
            );
        }
    }
    // Use a separate deterministic namespace to avoid replacing original packs.
    let mut new_sources = SourceIndex::new();
    let packs = pack_deltas(&snapshot_id, replacements, &mut new_sources, PACK_LIMIT)?;
    let mut output = Files::new();
    let portable_path = |path: &str| -> AppResult<String> {
        let (prefix, name) = path
            .rsplit_once('/')
            .ok_or_else(|| AppError::new("invalid_content", "Invalid part path."))?;
        let part: u32 = name
            .trim_end_matches(".json")
            .parse()
            .map_err(|_| AppError::new("invalid_content", "Invalid part number."))?;
        Ok(format!("{prefix}/{:04}.json", part + 1_000_000))
    };
    for (path, bytes) in packs {
        output.insert(portable_path(&path)?, bytes);
    }
    for (hash, mut source) in new_sources {
        if let ContentSource::Pack { path, .. } = &mut source {
            *path = portable_path(path)?;
        }
        sources.insert(hash, source);
    }
    data["sourceIndex"] = serde_json::to_value(sources)?;
    Ok(output)
}
/// Verify every captured byte directly from an immutable Git bundle, never using
/// Storage's reconstructed cache as evidence for deleting a publication.
pub(crate) fn verify_bundle_sources(
    project: &Project,
    files: &Files,
    commit: &str,
) -> AppResult<()> {
    let reachable = reachable_objects(project, commit)?;
    let mut objects = super::publication::GitObjects::new(project.root.parent().unwrap())?;
    // Parse each shared pack once, rather than once per source in the capture.
    let mut packs = BTreeMap::<String, ContentPack>::new();
    for (path, bytes) in files {
        if !path.starts_with("snapshots/") {
            continue;
        }
        let doc: Document = serde_json::from_slice(bytes)?;
        let (snapshot_id, sources) = snapshot_sources(&doc.data)?;
        for (hash, source) in sources {
            let expected = source.size();
            let result = match source {
                ContentSource::Git { oid, .. } => {
                    if !reachable.contains(&oid) {
                        return Err(AppError::new(
                            "missing_git_object",
                            "Source is not retained by archive history.",
                        ));
                    }
                    objects.blob(&oid, SOURCE_LIMIT)?
                }
                ContentSource::Pack { path, .. } => {
                    if !packs.contains_key(&path) {
                        let bytes = files.get(&path).ok_or_else(|| {
                            AppError::new("missing_content", "Archive source pack missing.")
                        })?;
                        packs.insert(path.clone(), serde_json::from_slice(bytes)?);
                    }
                    let pack = packs.get_mut(&path).ok_or_else(|| {
                        AppError::new("missing_content", "Archive source pack missing.")
                    })?;
                    if pack.version != VERSION
                        || pack.snapshot_id != snapshot_id
                        || pack.format != "reviewbox"
                    {
                        return Err(AppError::new(
                            "invalid_content",
                            "Invalid archive source pack.",
                        ));
                    }
                    let delta = pack.entries.remove(&hash).ok_or_else(|| {
                        AppError::new("missing_content", "Archive source entry missing.")
                    })?;
                    if delta
                        .base_oid
                        .as_ref()
                        .is_some_and(|oid| !reachable.contains(oid))
                    {
                        return Err(AppError::new(
                            "missing_git_object",
                            "Delta base is not retained by archive history.",
                        ));
                    }
                    let base = delta
                        .base_oid
                        .as_deref()
                        .map(|oid| objects.blob(oid, SOURCE_LIMIT))
                        .transpose()?
                        .unwrap_or_default();
                    reconstruct_bytes(&base, delta)?
                }
            };
            if result.len() != expected as usize || fingerprint(&result) != hash {
                return Err(AppError::new(
                    "corrupt_content",
                    "Archived source failed exact reconstruction.",
                ));
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn delta(text: &str) -> ByteDelta {
        ByteDelta {
            size: text.len() as u32,
            base_oid: None,
            prefix: 0,
            suffix: 0,
            replacement: Replacement::Text(text.into()),
        }
    }
    /// Opt-in benchmark on a supplied bundle, with all Git/project writes isolated.
    #[test]
    #[ignore = "requires REVIEWBOX_VERIFY_REPOSITORY and REVIEWBOX_VERIFY_BUNDLE"]
    fn verify_supplied_bundle_in_isolated_clone() {
        let repository = std::env::var("REVIEWBOX_VERIFY_REPOSITORY").unwrap();
        let bundle = PathBuf::from(std::env::var("REVIEWBOX_VERIFY_BUNDLE").unwrap());
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("repository");
        assert!(
            std::process::Command::new("git")
                .args(["clone", "--shared", "--no-checkout", "--quiet", "--"])
                .arg(repository)
                .arg(&root)
                .status()
                .unwrap()
                .success()
        );
        let project = Project::open(&root, "verification").unwrap();
        let mut files = Files::new();
        let mut pending = vec![bundle.clone()];
        while let Some(directory) = pending.pop() {
            for entry in fs::read_dir(directory).unwrap() {
                let entry = entry.unwrap();
                if entry.file_type().unwrap().is_dir() {
                    pending.push(entry.path());
                } else if entry.file_type().unwrap().is_file() {
                    files.insert(
                        entry
                            .path()
                            .strip_prefix(&bundle)
                            .unwrap()
                            .to_str()
                            .unwrap()
                            .into(),
                        fs::read(entry.path()).unwrap(),
                    );
                }
            }
        }
        let started = std::time::Instant::now();
        verify_bundle_sources(&project, &files, "HEAD").unwrap();
        eprintln!(
            "Exact bundle verification completed in {:?}",
            started.elapsed()
        );
    }

    #[test]
    fn packs_are_bounded_deterministic_and_restore_every_part() {
        let input = || {
            (0..6)
                .map(|i| {
                    let text = format!("entry {i} {}", "x".repeat(160));
                    (fingerprint(text.as_bytes()), delta(&text))
                })
                .collect()
        };
        let mut sources = SourceIndex::new();
        let packs = pack_deltas("snapshot", input(), &mut sources, 650).unwrap();
        assert!(packs.len() > 1);
        assert!(packs.values().all(|b| b.len() <= 650));
        assert_eq!(
            packs,
            pack_deltas("snapshot", input(), &mut SourceIndex::new(), 650).unwrap()
        );
        let dir = tempfile::tempdir().unwrap();
        let project = Project::open(dir.path(), "repo").unwrap();
        for (path, bytes) in &packs {
            super::super::atomic(&project.root.join(path), bytes).unwrap();
        }
        *project.sources.lock().unwrap() = sources
            .into_iter()
            .map(|(hash, source)| {
                (
                    hash,
                    LocatedSource {
                        root: project.root.clone(),
                        snapshot_id: "snapshot".into(),
                        source,
                    },
                )
            })
            .collect();
        for (hash, expected) in input() {
            assert_eq!(
                restore_content(&project, &hash).unwrap().unwrap(),
                reconstruct(dir.path(), expected).unwrap()
            );
        }
        assert!(pack_deltas("snapshot", input(), &mut SourceIndex::new(), 20).is_err());
    }
    #[test]
    fn control_bytes_use_bounded_hex_and_roundtrip() {
        let bytes = vec![0; 128];
        let replacement = replacement(&bytes);
        assert!(matches!(replacement, Replacement::Hex(_)));
        let d = ByteDelta {
            size: 128,
            base_oid: None,
            prefix: 0,
            suffix: 0,
            replacement,
        };
        let json = serde_json::to_vec(&d).unwrap();
        let restored = reconstruct(Path::new("."), serde_json::from_slice(&json).unwrap()).unwrap();
        assert_eq!(restored, bytes);
        let mut invalid = delta("text");
        invalid.prefix = usize::MAX;
        assert_eq!(
            reconstruct(Path::new("."), invalid).unwrap_err().code,
            "invalid_delta"
        );
        let mut oversized = delta("text");
        oversized.size = SOURCE_LIMIT as u32 + 1;
        assert_eq!(
            reconstruct(Path::new("."), oversized).unwrap_err().code,
            "corrupt_content"
        );
    }
}
