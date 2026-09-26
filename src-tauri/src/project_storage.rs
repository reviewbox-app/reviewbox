//! Portable documents. Only this module writes .reviewbox; SQLite is a disposable index.
use crate::{contracts::*, storage::Storage};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    fs,
    io::Write,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::SystemTime,
};

pub struct FileLock(pub fs::File);
impl Drop for FileLock {
    fn drop(&mut self) {
        let _ = self.0.unlock();
    }
}

pub const KINDS: &[&str] = &[
    "review",
    "review_history",
    "snapshot",
    "knowledge",
    "onboarding",
    "proposal",
    "project_settings",
];
pub type Documents = BTreeMap<(String, String), Value>;
type Files = BTreeMap<String, Vec<u8>>;

#[derive(Clone)]
pub struct Project {
    pub root: PathBuf,
    pub repository_id: String,
    pub project_id: String,
    cache: Arc<Mutex<BTreeMap<String, CachedDocument>>>,
}
struct CachedDocument {
    modified: SystemTime,
    len: u64,
    document: Document,
}
#[derive(Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Manifest {
    format: String,
    version: u32,
    project_id: String,
}
#[derive(Clone, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
struct Document {
    format: String,
    version: u32,
    kind: String,
    id: String,
    data: Value,
}
#[derive(Serialize, Deserialize, schemars::JsonSchema)]
struct Change {
    path: String,
    before: Option<String>,
    after: Option<String>,
}

fn bytes(value: &impl Serialize) -> AppResult<Vec<u8>> {
    let mut b = serde_json::to_vec_pretty(value)?;
    b.push(b'\n');
    Ok(b)
}
fn identifier(id: &str) -> AppResult<()> {
    if id.is_empty()
        || id.len() > 160
        || !id
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || b"-_@".contains(&c))
    {
        return Err(AppError::new(
            "invalid_id",
            "Project identifiers must contain only letters, digits, -, _ or @.",
        ));
    }
    Ok(())
}
pub fn checked(root: &Path, relative: &str) -> AppResult<PathBuf> {
    crate::snapshots::safe_path(relative)?;
    let mut path = root.to_path_buf();
    if fs::symlink_metadata(root).is_ok_and(|m| m.file_type().is_symlink()) {
        return Err(AppError::new(
            "external_path",
            "Project storage cannot be a symbolic link.",
        ));
    }
    for part in Path::new(relative).components() {
        path.push(part);
        if fs::symlink_metadata(&path).is_ok_and(|m| m.file_type().is_symlink()) {
            return Err(AppError::new(
                "external_path",
                "Project storage cannot contain symbolic links.",
            ));
        }
    }
    Ok(path)
}
pub fn atomic(path: &Path, content: &[u8]) -> AppResult<()> {
    let parent = path
        .parent()
        .ok_or_else(|| AppError::new("path", "Missing parent directory."))?;
    fs::create_dir_all(parent)?;
    let mut temp = tempfile::NamedTempFile::new_in(parent)?;
    temp.write_all(content)?;
    temp.as_file().sync_all()?;
    temp.persist(path).map_err(|e| AppError::from(e.error))?;
    #[cfg(unix)]
    fs::File::open(parent)?.sync_all()?;
    Ok(())
}
impl Project {
    pub fn open(root: &Path, repository_id: &str) -> AppResult<Self> {
        let directory = checked(root, ".reviewbox")?;
        fs::create_dir_all(&directory)?;
        let provisional = Self {
            root: directory,
            repository_id: repository_id.into(),
            project_id: String::new(),
            cache: Arc::default(),
        };
        let _lock = provisional.lock()?;
        let path = checked(&provisional.root, "project.json")?;
        let manifest = if path.exists() {
            let m: Manifest = serde_json::from_slice(&fs::read(&path)?)?;
            if m.format != "reviewbox" || m.version != 1 {
                return Err(AppError::new(
                    "project_version",
                    "Unsupported ReviewBox project format. No files were changed.",
                ));
            }
            identifier(&m.project_id)?;
            m
        } else {
            // An existing unknown directory is never treated as an empty project.
            if fs::read_dir(&provisional.root)?
                .filter_map(Result::ok)
                .any(|e| {
                    ![".local", ".gitignore"].contains(&e.file_name().to_string_lossy().as_ref())
                })
            {
                return Err(AppError::new(
                    "project_conflict",
                    "An existing .reviewbox directory has no supported project.json.",
                ));
            }
            let m = Manifest {
                format: "reviewbox".into(),
                version: 1,
                project_id: id(),
            };
            atomic(&path, &bytes(&m)?)?;
            m
        };
        let ignore = checked(&provisional.root, ".gitignore")?;
        if !ignore.exists() {
            atomic(&ignore, b".local/\n")?;
        }
        let project = Self {
            project_id: manifest.project_id,
            ..provisional
        };
        project.recover()?;
        Ok(project)
    }
    pub fn lock(&self) -> AppResult<FileLock> {
        let path = checked(&self.root, ".local/write.lock")?;
        fs::create_dir_all(path.parent().unwrap())?;
        let file = fs::OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .open(path)?;
        let mut locked = false;
        for _ in 0..50 {
            if file.try_lock().is_ok() {
                locked = true;
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        if !locked {
            let mut error = AppError::new(
                "project_busy",
                "Another operation is writing this project. Retry shortly.",
            );
            error.retryable = true;
            return Err(error);
        }
        Ok(FileLock(file))
    }
    fn recover(&self) -> AppResult<()> {
        let journal = checked(&self.root, ".local/transaction.json")?;
        if !journal.exists() {
            return Ok(());
        }
        let changes: Vec<Change> = serde_json::from_slice(&fs::read(&journal)?)?;
        // Validate the entire transaction before touching any file.
        for change in &changes {
            let path = checked(&self.root, &change.path)?;
            if change.path.starts_with(".local/") || change.path == "project.json" {
                return Err(AppError::new(
                    "invalid_journal",
                    "Invalid transaction target.",
                ));
            }
            let current = fs::read(&path).ok().map(|b| fingerprint(&b));
            let after = change.after.as_ref().map(|s| fingerprint(s.as_bytes()));
            if current != change.before && current != after {
                return Err(AppError::new(
                    "project_conflict",
                    format!(
                        "{} changed during recovery. The journal was preserved.",
                        change.path
                    ),
                ));
            }
        }
        for change in changes {
            let path = checked(&self.root, &change.path)?;
            if let Some(text) = change.after {
                atomic(&path, text.as_bytes())?;
            } else if path.exists() {
                fs::remove_file(path)?;
            }
        }
        fs::remove_file(journal)?;
        Ok(())
    }
    pub fn recover_locked(&self) -> AppResult<()> {
        self.recover()
    }
    pub fn commit(&self, old: &Documents, next: &Documents) -> AppResult<()> {
        let before = self.encode(old)?;
        let after = self.encode(next)?;
        let mut changes = Vec::new();
        for path in before
            .keys()
            .chain(after.keys())
            .collect::<std::collections::BTreeSet<_>>()
        {
            if before.get(path) == after.get(path) {
                continue;
            }
            let dest = checked(&self.root, path)?;
            let actual = fs::read(&dest).ok();
            // Never overwrite an external edit that raced this transaction.
            if actual.as_ref().map(|v| fingerprint(v)) != before.get(path).map(|v| fingerprint(v)) {
                // Files authored externally may use different whitespace; compare JSON too.
                if actual
                    .as_ref()
                    .and_then(|v| serde_json::from_slice::<Value>(v).ok())
                    != before
                        .get(path)
                        .and_then(|v| serde_json::from_slice::<Value>(v).ok())
                {
                    return Err(AppError::new(
                        "conflict",
                        format!("{path} changed. Reload before saving."),
                    ));
                }
            }
            changes.push(Change {
                path: path.clone(),
                before: actual.map(|b| fingerprint(&b)),
                after: after
                    .get(path)
                    .map(|v| String::from_utf8(v.clone()))
                    .transpose()
                    .map_err(|_| AppError::new("encoding", "Project document must be UTF-8."))?,
            });
        }
        if changes.is_empty() {
            return Ok(());
        }
        atomic(
            &checked(&self.root, ".local/transaction.json")?,
            &bytes(&changes)?,
        )?;
        self.recover()
    }
    fn remap(&self, value: &mut Value, to_disk: bool) {
        match value {
            Value::Object(map) => {
                for (key, child) in map {
                    if key == "repositoryId" {
                        *child = json!(if to_disk {
                            &self.project_id
                        } else {
                            &self.repository_id
                        });
                    } else {
                        self.remap(child, to_disk);
                    }
                }
            }
            Value::Array(a) => {
                for child in a {
                    self.remap(child, to_disk);
                }
            }
            _ => {}
        }
    }
    pub(crate) fn encode(&self, docs: &Documents) -> AppResult<Files> {
        let mut files = Files::new();
        for ((kind, key), data) in docs {
            validate(kind, data)?;
            let key = if kind == "knowledge" {
                "knowledge"
            } else if kind == "project_settings" {
                "settings"
            } else {
                key
            };
            identifier(key)?;
            let mut data = data.clone();
            self.remap(&mut data, true);
            if kind == "review" || kind == "review_history" {
                data.as_object_mut().unwrap().remove("position");
                data.as_object_mut().unwrap().remove("examined");
            }
            if kind == "onboarding"
                && let Some(steps) = data["steps"].as_array_mut()
            {
                for step in steps {
                    step.as_object_mut().unwrap().remove("visited");
                }
            }
            let path = match kind.as_str() {
                "review" => format!("reviews/{key}/review.json"),
                "review_history" => format!("history/{key}.json"),
                "snapshot" => format!("snapshots/{key}.json"),
                "knowledge" => "knowledge.json".into(),
                "onboarding" => format!("tours/{key}.json"),
                "proposal" => format!("proposals/{key}.json"),
                "project_settings" => "settings.json".into(),
                _ => {
                    return Err(AppError::new(
                        "document_kind",
                        "Unsupported project document.",
                    ));
                }
            };
            if kind == "review" || kind == "knowledge" {
                let fields: &[&str] = if kind == "review" {
                    &["topics", "annotations", "decisions"]
                } else {
                    &["terms", "documents"]
                };
                for field in fields {
                    let entries = data[*field].as_array().cloned().unwrap_or_default();
                    let mut ids = Vec::new();
                    for entry in entries {
                        let id = entry["id"].as_str().ok_or_else(|| {
                            AppError::new("invalid_id", "A project element needs an ID.")
                        })?;
                        identifier(id)?;
                        if ids.contains(&json!(id)) {
                            return Err(AppError::new(
                                "duplicate_id",
                                "Duplicate element identifier.",
                            ));
                        }
                        ids.push(json!(id));
                        let child = if kind == "review" {
                            format!("reviews/{key}/{field}/{id}.json")
                        } else {
                            format!("{field}/{id}.json")
                        };
                        files.insert(
                            child,
                            bytes(&Document {
                                format: "reviewbox".into(),
                                version: 1,
                                kind: field.to_string(),
                                id: id.into(),
                                data: entry,
                            })?,
                        );
                    }
                    data[*field] = json!(ids);
                }
            }
            files.insert(
                path,
                bytes(&Document {
                    format: "reviewbox".into(),
                    version: 1,
                    kind: kind.clone(),
                    id: key.into(),
                    data,
                })?,
            );
        }
        if files.values().any(|bytes| bytes.len() > 16 * 1024 * 1024) {
            return Err(AppError::new(
                "document_limit",
                "A project document exceeds 16 MiB.",
            ));
        }
        Ok(files)
    }
    pub fn read(&self) -> AppResult<Documents> {
        let manifest: Manifest =
            serde_json::from_slice(&fs::read(checked(&self.root, "project.json")?)?)?;
        if manifest.format != "reviewbox"
            || manifest.version != 1
            || manifest.project_id != self.project_id
        {
            return Err(AppError::new(
                "project_changed",
                "Project identity or format changed. Reopen the repository.",
            ));
        }
        fn walk(
            root: &Path,
            prefix: &str,
            found: &mut BTreeMap<String, Document>,
            cache: &mut BTreeMap<String, CachedDocument>,
        ) -> AppResult<()> {
            let directory = if prefix.is_empty() {
                root.to_path_buf()
            } else {
                checked(root, prefix)?
            };
            for entry in fs::read_dir(directory)? {
                let entry = entry?;
                let name = entry.file_name().to_string_lossy().into_owned();
                if name.starts_with('.')
                    || (prefix.is_empty() && ["content", "project.json"].contains(&name.as_str()))
                {
                    continue;
                }
                let rel = if prefix.is_empty() {
                    name
                } else {
                    format!("{prefix}/{name}")
                };
                let path = checked(root, &rel)?;
                if path.is_dir() {
                    walk(root, &rel, found, cache)?;
                } else if path.extension().is_some_and(|s| s == "json") {
                    let metadata = path.metadata()?;
                    if let Some(cached) = cache.get(&rel)
                        && cached.modified == metadata.modified()?
                        && cached.len == metadata.len()
                    {
                        found.insert(rel, cached.document.clone());
                        continue;
                    }
                    if metadata.len() > 16 * 1024 * 1024 {
                        return Err(AppError::new(
                            "document_limit",
                            format!("{rel} exceeds 16 MiB."),
                        ));
                    }
                    let doc: Document = serde_json::from_slice(&fs::read(path)?)
                        .map_err(|e| AppError::new("invalid_project", format!("{rel}: {e}")))?;
                    if doc.format != "reviewbox" || doc.version != 1 {
                        return Err(AppError::new(
                            "project_version",
                            format!("Unsupported document: {rel}"),
                        ));
                    }
                    identifier(&doc.id)?;
                    cache.insert(
                        rel.clone(),
                        CachedDocument {
                            modified: metadata.modified()?,
                            len: metadata.len(),
                            document: doc.clone(),
                        },
                    );
                    found.insert(rel, doc);
                }
            }
            Ok(())
        }
        let mut files = BTreeMap::new();
        {
            let mut cache = self.cache.lock().unwrap();
            walk(&self.root, "", &mut files, &mut cache)?;
            cache.retain(|path, _| files.contains_key(path));
        }
        let mut docs = Documents::new();
        for (path, doc) in &files {
            if !KINDS.contains(&doc.kind.as_str()) {
                continue;
            }
            let mut data = doc.data.clone();
            if ["review", "snapshot", "onboarding", "proposal"].contains(&doc.kind.as_str())
                && data["id"] != doc.id
            {
                return Err(AppError::new(
                    "invalid_project",
                    format!("{path}: mismatched document identifier."),
                ));
            }
            if let Some(repo) = data.get("repositoryId")
                && repo != &json!(self.project_id)
            {
                return Err(AppError::new(
                    "invalid_project",
                    format!("{path}: belongs to a different project."),
                ));
            }
            if doc.kind == "review" || doc.kind == "knowledge" {
                let fields: &[&str] = if doc.kind == "review" {
                    &["topics", "annotations", "decisions"]
                } else {
                    &["terms", "documents"]
                };
                for field in fields {
                    let ids = data[*field].as_array().ok_or_else(|| {
                        AppError::new(
                            "invalid_project",
                            format!("{path}: expected {field} identifiers."),
                        )
                    })?;
                    let entries = ids
                        .iter()
                        .map(|id| {
                            let id = id.as_str().ok_or_else(|| {
                                AppError::new("invalid_id", "Expected element identifier.")
                            })?;
                            identifier(id)?;
                            let child = if doc.kind == "review" {
                                format!("reviews/{}/{field}/{id}.json", doc.id)
                            } else {
                                format!("{field}/{id}.json")
                            };
                            let part = files.get(&child).ok_or_else(|| {
                                AppError::new("invalid_project", format!("Missing {child}"))
                            })?;
                            if part.kind != *field || part.id != id || part.data["id"] != id {
                                return Err(AppError::new(
                                    "invalid_project",
                                    format!("Mismatched element: {child}"),
                                ));
                            }
                            Ok(part.data.clone())
                        })
                        .collect::<AppResult<Vec<_>>>()?;
                    data[*field] = json!(entries);
                }
            }
            self.remap(&mut data, false);
            validate(&doc.kind, &data)?;
            let key = if doc.kind == "knowledge" || doc.kind == "project_settings" {
                self.repository_id.clone()
            } else {
                doc.id.clone()
            };
            if docs.insert((doc.kind.clone(), key), data).is_some() {
                return Err(AppError::new("duplicate_id", "Duplicate project document."));
            }
        }
        // Exact paths prevent a moved file from being silently rewritten under another name.
        let expected = self.encode(&docs)?;
        if files.len() != expected.len() || files.keys().any(|p| !expected.contains_key(p)) {
            return Err(AppError::new(
                "invalid_project",
                "Unexpected or unreferenced project document. Check the documented layout.",
            ));
        }
        Ok(docs)
    }
}
fn validate(kind: &str, data: &Value) -> AppResult<()> {
    macro_rules! check {
        ($t:ty) => {{
            let _: $t = serde_json::from_value(data.clone())?;
        }};
    }
    match kind {
        "review" | "review_history" => check!(Review),
        "snapshot" => check!(Snapshot),
        "knowledge" => check!(ProjectKnowledge),
        "onboarding" => check!(OnboardingTour),
        "proposal" => check!(Proposal),
        "project_settings" => {
            check!(ProjectSettings);
            let s: ProjectSettings = serde_json::from_value(data.clone())?;
            if s.language.trim().is_empty()
                || s.provider
                    .as_ref()
                    .is_some_and(|p| !["codex", "claude"].contains(&p.as_str()))
            {
                return Err(AppError::new(
                    "settings",
                    "Choose a language and a supported provider.",
                ));
            }
        }
        _ => {
            return Err(AppError::new(
                "document_kind",
                "Unsupported project document.",
            ));
        }
    }
    fn paths(value: &Value) -> AppResult<()> {
        match value {
            Value::Object(map) => {
                for (k, v) in map {
                    if ["path", "previousPath"].contains(&k.as_str())
                        && let Some(path) = v.as_str()
                    {
                        crate::snapshots::safe_path(path)?;
                    }
                    paths(v)?;
                }
            }
            Value::Array(a) => {
                for v in a {
                    paths(v)?;
                }
            }
            _ => {}
        }
        Ok(())
    }
    paths(data)
}

// A byte delta keeps binary files, line endings and missing final newlines exact.
#[derive(Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PortableContent {
    version: u32,
    hash: String,
    size: u32,
    git_oid: Option<String>,
    base_oid: Option<String>,
    prefix: usize,
    suffix: usize,
    text: Option<String>,
    hex: Option<String>,
}
fn git_bytes(root: &Path, oid: &str) -> AppResult<Vec<u8>> {
    if ![40, 64].contains(&oid.len()) || !oid.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(AppError::new(
            "invalid_oid",
            "Invalid Git object identifier.",
        ));
    }
    let size = crate::repositories::text(root, &["cat-file", "-s", oid])
        .ok()
        .and_then(|s| s.parse::<u64>().ok());
    if size.is_some_and(|n| n > 64 * 1024 * 1024) {
        return Err(AppError::new(
            "content_limit",
            "Git source exceeds the 64 MiB content limit.",
        ));
    }
    crate::repositories::git(root, &["cat-file", "blob", oid]).map_err(|_| AppError::new("missing_git_object", format!("Git object {oid} is unavailable. Fetch the review's base commit; current code was not substituted.")))
}
pub fn export_content(storage: &Storage, project: &Project, snapshot: &Snapshot) -> AppResult<()> {
    let repository_root = project.root.parent().unwrap();
    let references = if snapshot.git_refs.is_empty() {
        vec![snapshot.head.clone()]
    } else {
        snapshot.git_refs.clone()
    };
    let sources = storage.git_sources(repository_root, &references)?;
    let mut blobs: BTreeMap<String, (BlobRef, Option<String>)> = BTreeMap::new();
    for f in &snapshot.files {
        blobs.insert(f.content.hash.clone(), (f.content.clone(), None));
    }
    for c in &snapshot.changes {
        if let Some(b) = &c.before {
            blobs.insert(b.hash.clone(), (b.clone(), None));
        }
        if let Some(b) = &c.after {
            blobs.insert(
                b.hash.clone(),
                (b.clone(), c.before.as_ref().map(|p| p.hash.clone())),
            );
        }
    }
    for (hash, (blob, base_oid)) in blobs {
        let path = checked(&project.root, &format!("content/{hash}.json"))?;
        if path.exists() {
            continue;
        }
        let content = storage.cached_blob(&hash)?;
        // Only objects read from this snapshot's committed trees are portable Git references.
        let git_oid = sources.get(&hash).cloned();
        let base = base_oid
            .as_ref()
            .filter(|hash| sources.contains_key(*hash))
            .map(|hash| storage.cached_blob(hash))
            .transpose()?;
        let base_oid = base_oid.and_then(|hash| sources.get(&hash).cloned());
        let (mut prefix, mut suffix) = (0, 0);
        if let Some(base) = &base {
            prefix = base
                .iter()
                .zip(&content)
                .take_while(|(a, b)| a == b)
                .count();
            suffix = base[prefix..]
                .iter()
                .rev()
                .zip(content[prefix..].iter().rev())
                .take_while(|(a, b)| a == b)
                .count();
        }
        let replacement = if git_oid.is_some() {
            &[][..]
        } else {
            &content[prefix..content.len() - suffix]
        };
        let (text, hex) = match std::str::from_utf8(replacement) {
            Ok(s) => (Some(s.into()), None),
            Err(_) => (
                None,
                Some(replacement.iter().map(|b| format!("{b:02x}")).collect()),
            ),
        };
        let portable = PortableContent {
            version: 1,
            hash,
            size: blob.size,
            git_oid,
            base_oid,
            prefix,
            suffix,
            text,
            hex,
        };
        atomic(&path, &bytes(&portable)?)?;
    }
    Ok(())
}
pub fn restore_content(project: &Project, hash: &str) -> AppResult<Option<Vec<u8>>> {
    if hash.len() != 64 || !hash.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(AppError::new("invalid_hash", "Invalid content hash."));
    }
    let path = checked(&project.root, &format!("content/{hash}.json"))?;
    if !path.exists() {
        return Ok(None);
    }
    if path.metadata()?.len() > 140 * 1024 * 1024 {
        return Err(AppError::new(
            "content_limit",
            "Portable content is too large.",
        ));
    }
    let p: PortableContent = serde_json::from_slice(&fs::read(path)?)?;
    if p.version != 1 || p.hash != hash || p.size > 64 * 1024 * 1024 {
        return Err(AppError::new(
            "invalid_content",
            "Invalid portable content metadata.",
        ));
    }
    let root = project.root.parent().unwrap();
    let result = if let Some(oid) = p.git_oid {
        git_bytes(root, &oid)?
    } else {
        let base = p
            .base_oid
            .map(|oid| git_bytes(root, &oid))
            .transpose()?
            .unwrap_or_default();
        if p.prefix > base.len() || p.suffix > base.len() - p.prefix {
            return Err(AppError::new("invalid_delta", "Invalid byte delta bounds."));
        }
        let replacement = if let Some(text) = p.text {
            text.into_bytes()
        } else if let Some(hex) = p.hex {
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
        } else {
            return Err(AppError::new("invalid_delta", "Missing replacement."));
        };
        [
            base[..p.prefix].to_vec(),
            replacement,
            base[base.len() - p.suffix..].to_vec(),
        ]
        .concat()
    };
    if result.len() != p.size as usize || fingerprint(&result) != hash {
        return Err(AppError::new(
            "corrupt_content",
            "Reconstructed content failed its integrity check.",
        ));
    }
    Ok(Some(result))
}

pub fn schemas() -> Value {
    let mut definitions = serde_json::Map::new();
    let mut variants = Vec::new();
    let entries = [
        ("review", schemars::schema_for!(Review)),
        ("review_history", schemars::schema_for!(Review)),
        ("snapshot", schemars::schema_for!(Snapshot)),
        ("knowledge", schemars::schema_for!(ProjectKnowledge)),
        ("onboarding", schemars::schema_for!(OnboardingTour)),
        ("proposal", schemars::schema_for!(Proposal)),
        ("project_settings", schemars::schema_for!(ProjectSettings)),
        ("topics", schemars::schema_for!(Topic)),
        ("annotations", schemars::schema_for!(Annotation)),
        ("decisions", schemars::schema_for!(Decision)),
        ("terms", schemars::schema_for!(GlossaryTerm)),
        ("documents", schemars::schema_for!(ExplanationDocument)),
    ];
    for (kind, schema) in entries {
        let mut data = serde_json::to_value(schema).expect("schema serialization");
        if let Some(Value::Object(defs)) = data.as_object_mut().unwrap().remove("$defs") {
            definitions.extend(defs);
        }
        data.as_object_mut().unwrap().remove("$schema");
        if kind == "review" {
            for field in ["topics", "annotations", "decisions"] {
                data["properties"][field] =
                    json!({"type":"array","items":{"type":"string"},"uniqueItems":true});
            }
        }
        if kind == "knowledge" {
            for field in ["terms", "documents"] {
                data["properties"][field] =
                    json!({"type":"array","items":{"type":"string"},"uniqueItems":true});
            }
        }
        variants.push(json!({"type":"object","additionalProperties":false,"required":["format","version","kind","id","data"],"properties":{"format":{"const":"reviewbox"},"version":{"const":1},"kind":{"const":kind},"id":{"type":"string","pattern":"^[a-zA-Z0-9_@-]{1,160}$"},"data":data}}));
    }
    let mut manifest = serde_json::to_value(schemars::schema_for!(Manifest)).unwrap();
    manifest["properties"]["format"] = json!({"const":"reviewbox"});
    manifest["properties"]["version"] = json!({"const":1});
    let mut content = serde_json::to_value(schemars::schema_for!(PortableContent)).unwrap();
    content["properties"]["version"] = json!({"const":1});
    json!({
        "project-document.schema.json":{"$schema":"https://json-schema.org/draft/2020-12/schema","title":"ReviewBox project document v1","oneOf":variants,"$defs":definitions},
        "project-manifest.schema.json":manifest,
        "project-content.schema.json":content
    })
}
