//! Immutable publication inventories and read-only Git archive discovery.
//!
//! This module never stages, checks out, fetches, or writes Git objects. Its
//! caller owns the project lock and publishes the returned reference together
//! with the removal of the working copy through the project journal.
use super::{Files, Project, VERSION, bytes, identifier};
use crate::{
    contracts::{AppError, AppResult, BlobRef, Snapshot, fingerprint},
    repositories::{git, text},
};
use serde::{Deserialize, Serialize};
use std::{
    collections::{BTreeMap, BTreeSet},
    io::{BufRead, BufReader, Read, Write},
    path::Path,
    process::{Child, ChildStdin, ChildStdout, Command, Stdio},
};

pub(super) const BUNDLE_MANIFEST: &str = "bundle.json";
const FILE_LIMIT: usize = 140 * 1024 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct BundleEntry {
    pub hash: String,
    pub size: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct BundleManifest {
    pub format: String,
    pub version: u32,
    pub review_id: String,
    pub files: BTreeMap<String, BundleEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ArchiveLocation {
    pub commit: String,
    pub path: String,
    pub bundle_hash: String,
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum ArchiveDecision {
    Ready(ArchiveLocation),
    Deferred(String),
}

fn archive_error(message: impl Into<String>) -> AppError {
    AppError::new("invalid_publication", message)
}

fn valid_oid(value: &str) -> AppResult<()> {
    if ![40, 64].contains(&value.len()) || !value.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(archive_error("Invalid archive Git object identifier."));
    }
    Ok(())
}

fn valid_hash(value: &str) -> AppResult<()> {
    if value.len() != 64 || !value.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(archive_error("Invalid publication content hash."));
    }
    Ok(())
}

fn bundle_path(path: &str) -> AppResult<()> {
    crate::snapshots::safe_path(path)?;
    // A single spelling is required on every supported platform. Apart from
    // traversal, reject aliases and any path into private runtime data.
    if path.contains('\\')
        || path
            .split('/')
            .any(|part| part.is_empty() || part == ".local")
        || path.contains(['\0', '\n', '\r'])
    {
        return Err(archive_error("Invalid publication-relative path."));
    }
    Ok(())
}

/// Add or replace the deterministic inventory. Files are relative to the
/// publication directory; no inventory entry describes the inventory itself.
pub(crate) fn seal_bundle(review_id: &str, files: &mut Files) -> AppResult<BundleManifest> {
    identifier(review_id)?;
    let mut inventory = BTreeMap::new();
    for (path, content) in files.iter().filter(|(p, _)| p.as_str() != BUNDLE_MANIFEST) {
        bundle_path(path)?;
        if content.len() > FILE_LIMIT {
            return Err(archive_error("Publication file exceeds 140 MiB."));
        }
        inventory.insert(
            path.clone(),
            BundleEntry {
                hash: fingerprint(content),
                size: content.len() as u64,
            },
        );
    }
    if inventory.is_empty() {
        return Err(archive_error("A publication cannot be empty."));
    }
    let manifest = BundleManifest {
        format: "reviewbox-publication".into(),
        version: VERSION,
        review_id: review_id.into(),
        files: inventory,
    };
    files.insert(BUNDLE_MANIFEST.into(), bytes(&manifest)?);
    Ok(manifest)
}

pub(crate) fn verify_bundle(files: &Files) -> AppResult<BundleManifest> {
    let content = files
        .get(BUNDLE_MANIFEST)
        .ok_or_else(|| archive_error("Publication inventory is missing."))?;
    let manifest: BundleManifest = serde_json::from_slice(content)?;
    identifier(&manifest.review_id)?;
    if manifest.format != "reviewbox-publication"
        || manifest.version != VERSION
        || manifest.files.is_empty()
        || files.len() != manifest.files.len() + 1
    {
        return Err(archive_error(
            "Publication inventory is incomplete or unsupported.",
        ));
    }
    for (path, expected) in &manifest.files {
        bundle_path(path)?;
        valid_hash(&expected.hash)?;
        if path == BUNDLE_MANIFEST || expected.size > FILE_LIMIT as u64 {
            return Err(archive_error("Invalid publication inventory entry."));
        }
        let actual = files
            .get(path)
            .ok_or_else(|| archive_error(format!("Publication file {path} is missing.")))?;
        if actual.len() as u64 != expected.size || fingerprint(actual) != expected.hash {
            return Err(archive_error(format!(
                "Publication file {path} failed its integrity check."
            )));
        }
    }
    Ok(manifest)
}

pub(crate) fn bundle_hash(files: &Files) -> AppResult<String> {
    let manifest = verify_bundle(files)?;
    // Hash a canonical serialization, so insignificant JSON whitespace does not
    // affect the reference. Every actual bundle byte is still compared with Git
    // before the working copy can be removed.
    Ok(fingerprint(&serde_json::to_vec(&manifest)?))
}

fn publication_path(review_id: &str) -> AppResult<String> {
    identifier(review_id)?;
    Ok(format!(".reviewbox/published/{review_id}"))
}

/// A source verifier must reconstruct sources directly from these bundle files
/// and Git, and verify that external Git bases are reachable from `commit`.
/// It must never accept the private source cache as archival evidence.
pub(crate) fn archive_candidate(
    project: &Project,
    review_id: &str,
    current_files: &Files,
    verify_sources: impl Fn(&Files, &str) -> AppResult<()>,
) -> AppResult<ArchiveDecision> {
    identifier(review_id)?;
    // A damaged or incomplete historical object database cannot justify
    // removing this publication, but must not block a different new review.
    match archive_candidate_inner(project, review_id, current_files, verify_sources) {
        Ok(decision) => Ok(decision),
        Err(error) => Ok(ArchiveDecision::Deferred(format!(
            "The archive could not be verified; its complete copy is retained. {}",
            error.message
        ))),
    }
}

fn archive_candidate_inner(
    project: &Project,
    review_id: &str,
    current_files: &Files,
    verify_sources: impl Fn(&Files, &str) -> AppResult<()>,
) -> AppResult<ArchiveDecision> {
    let defer = |message: &str| Ok(ArchiveDecision::Deferred(message.into()));
    let manifest = match verify_bundle(current_files) {
        Ok(manifest) if manifest.review_id == review_id => manifest,
        _ => return defer("The publication inventory or its working files have changed."),
    };
    let root = project
        .root
        .parent()
        .ok_or_else(|| archive_error("Missing repository root."))?;
    let path = publication_path(review_id)?;
    if text(root, &["rev-parse", "--is-shallow-repository"])? == "true" {
        return defer(
            "The repository history is shallow; the first complete publication cannot be verified.",
        );
    }
    let Ok(head) = text(root, &["rev-parse", "--verify", "HEAD"]) else {
        return defer("The publication has not been committed yet.");
    };
    valid_oid(&head)?;
    // Respect staged modifications, deletions, and unresolved index entries.
    // The read-only diff does not refresh or rewrite the index.
    if !git(
        root,
        &["diff", "--cached", "--name-only", "-z", &head, "--", &path],
    )?
    .is_empty()
    {
        return defer("The publication has staged changes; its complete copy is retained.");
    }
    if !git(
        root,
        &[
            "diff",
            "--no-ext-diff",
            "--no-textconv",
            "--name-only",
            "-z",
            &head,
            "--",
            &path,
        ],
    )?
    .is_empty()
    {
        return defer("The publication has local changes; its complete copy is retained.");
    }
    let mut objects = GitObjects::new(root)?;
    let Some(head_tree) = objects.object(&format!("{head}:{path}"), "tree", FILE_LIMIT)? else {
        return defer("The publication has not been committed completely.");
    };
    let head_files = match read_tree(root, &mut objects, &head_tree.oid) {
        Ok(files) => files,
        Err(_) => return defer("The committed publication is missing files or Git objects."),
    };
    if &head_files != current_files {
        return defer(
            "The publication differs from its committed copy; its complete copy is retained.",
        );
    }
    let graph = text(
        root,
        &["rev-list", "--topo-order", "--reverse", "--parents", &head],
    )?;
    let mut has_valid_ancestor = BTreeMap::<String, bool>::new();
    let mut candidates = BTreeSet::new();
    let mut checked_trees = BTreeMap::<String, bool>::new();
    let mut reconstruction_error = None;
    for line in graph.lines() {
        let mut fields = line.split_whitespace();
        let Some(commit) = fields.next() else {
            continue;
        };
        valid_oid(commit)?;
        let ancestor =
            fields.any(|parent| has_valid_ancestor.get(parent).copied().unwrap_or(false));
        if ancestor {
            has_valid_ancestor.insert(commit.into(), true);
            continue;
        }
        let tree = objects.object(&format!("{commit}:{path}"), "tree", FILE_LIMIT)?;
        let complete = if let Some(tree) = tree {
            if let Some(complete) = checked_trees.get(&tree.oid) {
                *complete
            } else {
                let complete = read_tree(root, &mut objects, &tree.oid)
                    .is_ok_and(|files| files == *current_files);
                checked_trees.insert(tree.oid, complete);
                complete
            }
        } else {
            false
        };
        let valid = complete
            && match verify_sources(&head_files, commit) {
                Ok(()) => true,
                Err(error) => {
                    reconstruction_error = Some(error.message);
                    false
                }
            };
        if valid {
            candidates.insert(commit.to_owned());
        }
        has_valid_ancestor.insert(commit.into(), valid);
    }
    let Some(commit) = candidates.into_iter().next() else {
        return Ok(ArchiveDecision::Deferred(reconstruction_error.unwrap_or_else(|| {
            "No complete, independently reconstructible publication exists in the accessible history.".into()
        })));
    };
    if text(root, &["rev-parse", "--verify", "HEAD"])? != head {
        return defer(
            "Repository history changed during archive verification; retry after Git finishes.",
        );
    }
    Ok(ArchiveDecision::Ready(ArchiveLocation {
        commit,
        path,
        bundle_hash: fingerprint(&serde_json::to_vec(&manifest)?),
    }))
}

/// Resolve one recorded immutable archive. Available history is sufficient for
/// reading; a shallow clone only prevents *discovering* a first appearance.
pub(crate) fn read_archive(
    project: &Project,
    review_id: &str,
    location: &ArchiveLocation,
    verify_sources: impl Fn(&Files, &str) -> AppResult<()>,
) -> AppResult<Files> {
    valid_oid(&location.commit)?;
    valid_hash(&location.bundle_hash)?;
    if location.path != publication_path(review_id)? {
        return Err(archive_error("Archive path does not belong to its review."));
    }
    let root = project
        .root
        .parent()
        .ok_or_else(|| archive_error("Missing repository root."))?;
    let mut objects = GitObjects::new(root)?;
    if objects
        .object(&location.commit, "commit", FILE_LIMIT)?
        .is_none()
    {
        return Err(AppError::new(
            "missing_archive",
            "The archive commit is unavailable in this clone. No current code was substituted.",
        ));
    }
    let tree = objects
        .object(
            &format!("{}:{}", location.commit, location.path),
            "tree",
            FILE_LIMIT,
        )?
        .ok_or_else(|| {
            AppError::new(
                "missing_archive",
                "The archived publication is unavailable in Git.",
            )
        })?;
    let files = read_tree(root, &mut objects, &tree.oid)?;
    let manifest = verify_bundle(&files)?;
    if manifest.review_id != review_id || bundle_hash(&files)? != location.bundle_hash {
        return Err(archive_error(
            "The Git archive does not match its recorded publication.",
        ));
    }
    verify_sources(&files, &location.commit)?;
    Ok(files)
}

type CodeTree = BTreeMap<String, BlobRef>;

fn captured_trees(snapshot: &Snapshot) -> AppResult<(CodeTree, CodeTree)> {
    let mut after = CodeTree::new();
    for file in &snapshot.files {
        crate::snapshots::safe_path(&file.path)?;
        if crate::snapshots::is_metadata(&file.path) {
            continue;
        }
        if after
            .insert(file.path.clone(), file.content.clone())
            .is_some()
        {
            return Err(archive_error("Duplicate captured source path."));
        }
    }
    let mut before = after.clone();
    // Local captures list staged changes followed by unstaged changes. Reversing
    // that sequence restores the exact reviewed base, including intermediate
    // versions of a file changed in both layers.
    for change in snapshot.changes.iter().rev() {
        crate::snapshots::safe_path(&change.path)?;
        if crate::snapshots::is_metadata(&change.path) {
            continue;
        }
        if !same_blob(before.get(&change.path), change.after.as_ref()) {
            return Err(archive_error(
                "Captured changes do not match their source tree.",
            ));
        }
        if let Some(blob) = &change.before {
            before.insert(change.path.clone(), blob.clone());
        } else {
            before.remove(&change.path);
        }
    }
    Ok((before, after))
}

fn same_blob(left: Option<&BlobRef>, right: Option<&BlobRef>) -> bool {
    match (left, right) {
        (Some(left), Some(right)) => {
            left.hash == right.hash && left.size == right.size && left.mode == right.mode
        }
        (None, None) => true,
        _ => false,
    }
}

/// Content and reviewed scope are stable across machines and capture UUIDs.
/// Intermediate staged/unstaged versions remain part of the proof even when
/// their combined before/after result happens to be identical.
pub(crate) fn scope_fingerprint(snapshot: &Snapshot) -> AppResult<String> {
    let (before, after) = captured_trees(snapshot)?;
    let changes: Vec<_> = snapshot
        .changes
        .iter()
        .filter(|change| !crate::snapshots::is_metadata(&change.path))
        .map(|change| {
            (
                &change.layer,
                &change.path,
                &change.previous_path,
                &change.before,
                &change.after,
            )
        })
        .collect();
    Ok(fingerprint(&serde_json::to_vec(&(
        &snapshot.request.scope,
        before,
        after,
        changes,
    ))?))
}

/// Find commits whose entire own change (against their first parent) matches
/// the reviewed scope. A matching final tree alone is insufficient: in
/// particular it must not validate staged extras or each commit in a range.
pub(crate) fn matching_commits(project: &Project, snapshot: &Snapshot) -> AppResult<Vec<String>> {
    let root = project
        .root
        .parent()
        .ok_or_else(|| archive_error("Missing repository root."))?;
    let (before, after) = captured_trees(snapshot)?;
    if before.len() == after.len()
        && before
            .iter()
            .all(|(path, blob)| same_blob(Some(blob), after.get(path)))
    {
        return Ok(Vec::new());
    }
    if text(root, &["rev-parse", "--verify", "HEAD"]).is_err() {
        return Ok(Vec::new());
    }
    let log = text(root, &["log", "--format=%H %T %P", "HEAD"])?;
    let commits: Vec<Vec<&str>> = log
        .lines()
        .map(|line| line.split_whitespace().collect())
        .collect();
    let tree_by_commit: BTreeMap<_, _> = commits
        .iter()
        .filter(|parts| parts.len() >= 2)
        .map(|parts| (parts[0], parts[1]))
        .collect();
    let mut objects = GitObjects::new(root)?;
    let mut blobs = BTreeMap::<String, (String, usize)>::new();
    let mut after_matches = BTreeMap::new();
    let mut before_matches = BTreeMap::new();
    let mut result = BTreeSet::new();
    for entry in &commits {
        if entry.len() < 2 {
            return Err(archive_error("Malformed Git commit history."));
        }
        let commit = entry[0];
        let tree = entry[1];
        valid_oid(commit)?;
        if !cached_tree_matches(
            root,
            &mut objects,
            tree,
            &after,
            &mut blobs,
            &mut after_matches,
        )? {
            continue;
        }
        // Read the real header instead of treating shallow-boundary commits as
        // roots: log omits unavailable parents at that boundary.
        let Some(header) = objects.object(commit, "commit", FILE_LIMIT)? else {
            continue;
        };
        let header_end = header
            .bytes
            .windows(2)
            .position(|part| part == b"\n\n")
            .unwrap_or(header.bytes.len());
        let header = std::str::from_utf8(&header.bytes[..header_end])
            .map_err(|_| archive_error("Invalid Git commit header."))?;
        let parent = header.lines().find_map(|line| line.strip_prefix("parent "));
        let matches_before = match parent {
            None => before.is_empty(),
            Some(parent) => {
                if let Some(tree) = tree_by_commit.get(parent) {
                    cached_tree_matches(
                        root,
                        &mut objects,
                        tree,
                        &before,
                        &mut blobs,
                        &mut before_matches,
                    )?
                } else {
                    // Missing ancestors never prove correspondence.
                    false
                }
            }
        };
        if matches_before {
            result.insert(commit.to_string());
        }
    }
    Ok(result.into_iter().collect())
}

fn cached_tree_matches(
    root: &Path,
    objects: &mut GitObjects,
    tree: &str,
    expected: &CodeTree,
    blobs: &mut BTreeMap<String, (String, usize)>,
    matches: &mut BTreeMap<String, bool>,
) -> AppResult<bool> {
    if let Some(result) = matches.get(tree) {
        return Ok(*result);
    }
    valid_oid(tree)?;
    let entries = git(root, &["ls-tree", "-rlz", tree])?;
    let mut count = 0;
    let mut result = true;
    for entry in entries.split(|b| *b == 0).filter(|entry| !entry.is_empty()) {
        let separator = entry
            .iter()
            .position(|b| *b == b'\t')
            .ok_or_else(|| archive_error("Malformed source tree."))?;
        let Ok(path) = std::str::from_utf8(&entry[separator + 1..]) else {
            // A historical non-UTF-8 filename cannot match a UTF-8 capture.
            result = false;
            break;
        };
        if crate::snapshots::is_metadata(path) {
            continue;
        }
        count += 1;
        let Some(expected) = expected.get(path) else {
            result = false;
            break;
        };
        let metadata = std::str::from_utf8(&entry[..separator])
            .map_err(|_| archive_error("Malformed source tree metadata."))?;
        let fields: Vec<_> = metadata.split_whitespace().collect();
        if fields.len() != 4 || fields[0] != expected.mode {
            result = false;
            break;
        }
        if fields[0] != "160000" && fields[3].parse::<u32>().ok() != Some(expected.size) {
            result = false;
            break;
        }
        valid_oid(fields[2])?;
        let oid = fields[2];
        if !blobs.contains_key(oid) {
            let bytes = if fields[0] == "160000" {
                oid.as_bytes().to_vec()
            } else if let Some(object) = objects.object(oid, "blob", 64 * 1024 * 1024)? {
                object.bytes
            } else {
                return Err(AppError::new(
                    "missing_git_object",
                    "A source object needed to verify the reviewed commit is unavailable.",
                ));
            };
            blobs.insert(oid.into(), (fingerprint(&bytes), bytes.len()));
        }
        let Some((hash, size)) = blobs.get(oid) else {
            unreachable!()
        };
        if hash != &expected.hash || *size as u64 != expected.size as u64 {
            result = false;
            break;
        }
    }
    let result = result && count == expected.len();
    matches.insert(tree.into(), result);
    Ok(result)
}

struct GitObject {
    oid: String,
    bytes: Vec<u8>,
}

/// One read-only cat-file process per operation; source paths never enter a
/// shell and lazy object fetching/replacement objects are explicitly disabled.
struct GitObjects {
    child: Child,
    input: ChildStdin,
    output: BufReader<ChildStdout>,
}

impl GitObjects {
    fn new(root: &Path) -> AppResult<Self> {
        let mut child = Command::new("git")
            .args([
                "--no-optional-locks",
                "-c",
                "core.hooksPath=/dev/null",
                "cat-file",
                "--batch",
            ])
            .current_dir(root)
            .env("GIT_TERMINAL_PROMPT", "0")
            .env("GIT_NO_LAZY_FETCH", "1")
            .env("GIT_NO_REPLACE_OBJECTS", "1")
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()?;
        let input = child
            .stdin
            .take()
            .ok_or_else(|| archive_error("Missing Git input stream."))?;
        let output = BufReader::new(
            child
                .stdout
                .take()
                .ok_or_else(|| archive_error("Missing Git output stream."))?,
        );
        Ok(Self {
            child,
            input,
            output,
        })
    }

    fn object(
        &mut self,
        expression: &str,
        kind: &str,
        limit: usize,
    ) -> AppResult<Option<GitObject>> {
        if expression.contains(['\n', '\r', '\0']) {
            return Err(archive_error("Invalid Git object expression."));
        }
        writeln!(self.input, "{expression}")?;
        self.input.flush()?;
        let mut header = String::new();
        self.output.read_line(&mut header)?;
        if header.ends_with(" missing\n") {
            return Ok(None);
        }
        let fields: Vec<_> = header.split_whitespace().collect();
        if fields.len() != 3 {
            return Err(AppError::new(
                "missing_archive",
                "A required archive object is unavailable in Git.",
            ));
        }
        valid_oid(fields[0])?;
        let size = fields[2]
            .parse::<usize>()
            .map_err(|_| archive_error("Invalid Git object size."))?;
        if size > limit {
            return Err(archive_error(
                "Git publication object exceeds its storage limit.",
            ));
        }
        let mut content = vec![0; size];
        self.output.read_exact(&mut content)?;
        let mut newline = [0];
        self.output.read_exact(&mut newline)?;
        if newline != [b'\n'] || fields[1] != kind {
            return Err(archive_error("Unexpected Git archive object type."));
        }
        Ok(Some(GitObject {
            oid: fields[0].into(),
            bytes: content,
        }))
    }
}

impl Drop for GitObjects {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

fn read_tree(root: &Path, objects: &mut GitObjects, tree_oid: &str) -> AppResult<Files> {
    valid_oid(tree_oid)?;
    let entries = git(root, &["ls-tree", "-rz", tree_oid])?;
    let mut files = Files::new();
    for entry in entries.split(|b| *b == 0).filter(|entry| !entry.is_empty()) {
        let separator = entry
            .iter()
            .position(|b| *b == b'\t')
            .ok_or_else(|| archive_error("Malformed archive tree."))?;
        let metadata = std::str::from_utf8(&entry[..separator])
            .map_err(|_| archive_error("Invalid archive tree metadata."))?;
        let path = std::str::from_utf8(&entry[separator + 1..])
            .map_err(|_| archive_error("Archive paths must be UTF-8."))?;
        bundle_path(path)?;
        let fields: Vec<_> = metadata.split_whitespace().collect();
        if fields.len() != 3 || !["100644", "100755"].contains(&fields[0]) || fields[1] != "blob" {
            return Err(archive_error(
                "Publication archives must contain regular files only.",
            ));
        }
        let object = objects
            .object(fields[2], "blob", FILE_LIMIT)?
            .ok_or_else(|| {
                AppError::new(
                    "missing_archive",
                    format!("Archived publication file {path} is unavailable."),
                )
            })?;
        if files.insert(path.into(), object.bytes).is_some() {
            return Err(archive_error("Duplicate archive path."));
        }
    }
    Ok(files)
}

#[cfg(test)]
#[path = "publication_tests.rs"]
mod tests;
