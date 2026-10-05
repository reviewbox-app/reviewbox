//! Portable documents. Only this module writes .reviewbox; SQLite is a disposable index.
use crate::contracts::*;
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

mod archive_cache;
pub(crate) mod content;
mod layout;
pub(crate) mod publication;
pub(crate) mod reader_assets;
pub(crate) mod step_documents;
pub use content::{prepare_content, restore_content};
const VERSION: u32 = 4;

pub struct FileLock(pub fs::File);
impl Drop for FileLock {
    fn drop(&mut self) {
        let _ = self.0.unlock();
    }
}

pub const KINDS: &[&str] = &[
    "review",
    "review_reference",
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
    origins: Arc<Mutex<BTreeMap<(String, String), PathBuf>>>,
    sources: Arc<Mutex<BTreeMap<String, content::LocatedSource>>>,
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
pub(crate) fn lock_directory(root: &Path) -> AppResult<FileLock> {
    let path = checked(root, ".local/write.lock")?;
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

/// Explicit human edits of free-form collaboration documents share the project writer lock.
pub(crate) fn mutate_editor_document(root: &Path, mutation: EditorMutation) -> AppResult<()> {
    let directory = checked(root, ".reviewbox")?;
    let _lock = lock_directory(&directory)?;
    crate::editor::mutate_unlocked(root, mutation)
}

impl Project {
    pub fn open(root: &Path, repository_id: &str) -> AppResult<Self> {
        let directory = checked(root, ".reviewbox")?;
        let existing_manifest = checked(&directory, "project.json")?;
        if existing_manifest.exists() {
            let manifest: Manifest = serde_json::from_slice(&fs::read(existing_manifest)?)?;
            if manifest.format != "reviewbox" || manifest.version != VERSION {
                return Err(AppError::new(
                    "project_version",
                    "This project uses an unsupported ReviewBox format. Version 4 is required; no files were changed.",
                ));
            }
        }
        fs::create_dir_all(&directory)?;
        let provisional = Self {
            root: directory,
            repository_id: repository_id.into(),
            project_id: String::new(),
            cache: Arc::default(),
            origins: Arc::default(),
            sources: Arc::default(),
        };
        let _lock = provisional.lock()?;
        let path = checked(&provisional.root, "project.json")?;
        let manifest = if path.exists() {
            let m: Manifest = serde_json::from_slice(&fs::read(&path)?)?;
            if m.format != "reviewbox" || m.version != VERSION {
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
                    ![
                        ".local",
                        ".gitignore",
                        "CURRENT_CHANGES.md",
                        "REVIEW_COMMENTS.md",
                    ]
                    .contains(&e.file_name().to_string_lossy().as_ref())
                })
            {
                return Err(AppError::new(
                    "project_conflict",
                    "An existing .reviewbox directory has no supported project.json.",
                ));
            }
            let m = Manifest {
                format: "reviewbox".into(),
                version: VERSION,
                project_id: id(),
            };
            atomic(&path, &bytes(&m)?)?;
            m
        };
        let ignore = checked(&provisional.root, ".gitignore")?;
        let mut ignored = if ignore.exists() {
            fs::read_to_string(&ignore)?
        } else {
            String::new()
        };
        if !ignored
            .lines()
            .any(|line| [".local/", "/.local/"].contains(&line.trim()))
        {
            if !ignored.is_empty() && !ignored.ends_with('\n') {
                ignored.push('\n');
            }
            ignored.push_str(".local/\n");
            atomic(&ignore, ignored.as_bytes())?;
        }
        let project = Self {
            project_id: manifest.project_id,
            ..provisional
        };
        project.recover()?;
        Ok(project)
    }
    pub fn lock(&self) -> AppResult<FileLock> {
        lock_directory(&self.root)
    }
    fn recover(&self) -> AppResult<()> {
        let manifest: Manifest =
            serde_json::from_slice(&fs::read(checked(&self.root, "project.json")?)?)?;
        if manifest.format != "reviewbox" || manifest.version != VERSION {
            return Err(AppError::new(
                "project_version",
                "Version 4 is required; no files were changed.",
            ));
        }
        let journal = checked(&self.root, ".local/transaction.json")?;
        if !journal.exists() {
            return Ok(());
        }
        let changes: Vec<Change> = serde_json::from_slice(&fs::read(&journal)?)?;
        // Validate the entire transaction before touching any file.
        for change in &changes {
            let path = checked(&self.root, &change.path)?;
            if (change.path.starts_with(".local/")
                && !change.path.starts_with(".local/reviews/")
                && !change.path.starts_with(".local/captures/"))
                || change.path == "project.json"
            {
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
        fn empty_directories(root: &Path) -> AppResult<()> {
            if !root.exists() {
                return Ok(());
            }
            for entry in fs::read_dir(root)? {
                let entry = entry?;
                if entry.file_type()?.is_dir() {
                    empty_directories(&entry.path())?;
                }
            }
            if fs::read_dir(root)?.next().is_none() {
                fs::remove_dir(root)?;
            }
            Ok(())
        }
        for relative in [
            ".local/reviews",
            ".local/captures",
            "published",
            "content",
            "generated",
            "snapshots",
        ] {
            empty_directories(&checked(&self.root, relative)?)?;
        }
        Ok(())
    }
    pub fn recover_locked(&self) -> AppResult<()> {
        self.recover()
    }
    pub fn commit(&self, old: &Documents, next: &Documents) -> AppResult<()> {
        self.commit_with_content(old, next, Files::new())
    }
    pub(crate) fn commit_with_content(
        &self,
        old: &Documents,
        next: &Documents,
        packs: Files,
    ) -> AppResult<()> {
        let before = self.files(old, &Files::new(), old)?;
        let after = self.files(next, &packs, old)?;
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
        // Publish immutable source packs before documents that reference them.
        changes.sort_by_key(|change| {
            (
                change.after.is_none(),
                !(change.path.contains("content/") || change.path.contains("generated/")),
                change.path.clone(),
            )
        });
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
    pub(crate) fn encode_logical(&self, docs: &Documents) -> AppResult<Files> {
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
            if kind == "review" {
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
                    &["topics", "decisions"]
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
                                version: VERSION,
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
                    version: VERSION,
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
    fn read_logical(&self) -> AppResult<Documents> {
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
                    || (prefix.is_empty()
                        && [
                            "content",
                            "generated",
                            "project.json",
                            "bundle.json",
                            "published",
                            "references",
                        ]
                        .contains(&name.as_str()))
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
                    if doc.format != "reviewbox" || doc.version != VERSION {
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
                    &["topics", "decisions"]
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
        let expected = self.encode_logical(&docs)?;
        if files.len() != expected.len() || files.keys().any(|p| !expected.contains_key(p)) {
            return Err(AppError::new(
                "invalid_project",
                "Unexpected or unreferenced project document. Check the documented layout.",
            ));
        }
        Ok(docs)
    }
    pub(crate) fn index_sources(&self, docs: &Documents) -> AppResult<()> {
        let mut sources = content::index_sources(docs)?;
        let origins = self.origins.lock().unwrap();
        for located in sources.values_mut() {
            located.root = origins
                .get(&("snapshot".into(), located.snapshot_id.clone()))
                .cloned()
                .unwrap_or_else(|| self.root.clone());
        }
        for (hash, source) in self
            .sources
            .lock()
            .unwrap()
            .iter()
            .filter(|(_, located)| located.root.to_string_lossy().contains("/.local/archives/"))
        {
            sources
                .entry(hash.clone())
                .or_insert_with(|| source.clone());
        }
        *self.sources.lock().unwrap() = sources;
        Ok(())
    }
}
fn validate(kind: &str, data: &Value) -> AppResult<()> {
    macro_rules! check {
        ($t:ty) => {{
            let _: $t = serde_json::from_value(data.clone())?;
        }};
    }
    match kind {
        "review" => {
            let _: Review = serde_json::from_value(step_documents::validation_value(data)?)?;
        }
        "snapshot" => {
            content::snapshot_sources(data)?;
        }
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

pub fn schemas() -> Value {
    let mut definitions = serde_json::Map::new();
    let mut variants = Vec::new();
    let entries = [
        ("review", schemars::schema_for!(Review)),
        (
            "review_reference",
            schemars::schema_for!(layout::ArchiveReference),
        ),
        ("snapshot", schemars::schema_for!(content::StoredSnapshot)),
        ("knowledge", schemars::schema_for!(ProjectKnowledge)),
        ("onboarding", schemars::schema_for!(OnboardingTour)),
        ("proposal", schemars::schema_for!(Proposal)),
        ("project_settings", schemars::schema_for!(ProjectSettings)),
        ("topics", schemars::schema_for!(Topic)),
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
            data["properties"]["assetIndex"] = json!({"type":"object","additionalProperties":{"type":"array","items":{"type":"object","additionalProperties":false,"required":["path","hash"],"properties":{"path":{"type":"string"},"hash":{"type":"string","pattern":"^[a-f0-9]{64}$"}}}}});
            if let Some(required) = data["required"].as_array_mut() {
                required.push(json!("assetIndex"));
            }
            for field in ["topics", "decisions"] {
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
        if kind == "topics" {
            data["properties"]["steps"]["items"] = json!({"$ref":"#/$defs/StoredStep"});
        }
        variants.push(json!({"type":"object","additionalProperties":false,"required":["format","version","kind","id","data"],"properties":{"format":{"const":"reviewbox"},"version":{"const":4},"kind":{"const":kind},"id":{"type":"string","pattern":"^[a-zA-Z0-9_@-]{1,160}$"},"data":data}}));
    }
    if let Some(mut step) = definitions.get("Step").cloned() {
        step["properties"]
            .as_object_mut()
            .unwrap()
            .remove("documents");
        step["properties"]["documentAsset"] = step_documents::reference_schema();
        if let Some(required) = step["required"].as_array_mut() {
            required.retain(|key| key != "documents");
            required.push(json!("documentAsset"));
        }
        definitions.insert("StoredStep".into(), step);
    }
    if let Some(mut topic) = definitions.get("Topic").cloned() {
        topic["properties"]["steps"]["items"] = json!({"$ref":"#/$defs/StoredStep"});
        definitions.insert("StoredTopic".into(), topic);
    }
    let mut manifest = serde_json::to_value(schemars::schema_for!(Manifest)).unwrap();
    manifest["properties"]["format"] = json!({"const":"reviewbox"});
    manifest["properties"]["version"] = json!({"const":4});
    let mut content = serde_json::to_value(schemars::schema_for!(content::ContentPack)).unwrap();
    content["properties"]["format"] = json!({"const":"reviewbox"});
    content["properties"]["version"] = json!({"const":4});
    let mut publication =
        serde_json::to_value(schemars::schema_for!(publication::BundleManifest)).unwrap();
    publication["properties"]["format"] = json!({"const":"reviewbox-publication"});
    publication["properties"]["version"] = json!({"const":VERSION});
    json!({
        "project-document.schema.json":{"$schema":"https://json-schema.org/draft/2020-12/schema","title":"ReviewBox project document v4","oneOf":variants,"$defs":definitions},
        "project-manifest.schema.json":manifest,
        "project-content.schema.json":content,
        "project-reading-assets.schema.json":reader_assets::schema(),
        "project-step-documents.schema.json":step_documents::schema(),
        "project-publication.schema.json":publication
    })
}
