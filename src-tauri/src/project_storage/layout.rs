//! Storage origins: local drafts, standalone immutable publications and shared Code Explain data.
use super::*;
use std::collections::BTreeSet;
#[derive(Clone, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct ArchiveReference {
    id: String,
    title: String,
    repository_id: String,
    snapshot_id: String,
    mode: ReviewMode,
    created_at: String,
    updated_at: String,
    publication: ReviewPublication,
    scope: CaptureRequest,
}

pub(crate) fn review_prefix(review: &Value) -> AppResult<String> {
    let id = review["id"]
        .as_str()
        .ok_or_else(|| AppError::new("invalid_id", "Missing review ID."))?;
    identifier(id)?;
    Ok(if review["publication"]["status"] == "published" {
        format!("published/{id}")
    } else {
        format!(".local/reviews/{id}")
    })
}
fn referenced_paths(value: &Value, paths: &mut BTreeSet<String>) {
    match value {
        Value::Object(map) => {
            for (key, value) in map {
                if key == "path"
                    && let Some(path) = value.as_str()
                    && (path.starts_with("content/") || path.starts_with("generated/"))
                {
                    paths.insert(path.into());
                }
                referenced_paths(value, paths);
            }
        }
        Value::Array(values) => {
            for value in values {
                referenced_paths(value, paths);
            }
        }
        _ => {}
    }
}
fn snapshot_ids(value: &Value, ids: &mut BTreeSet<String>) {
    match value {
        Value::Object(map) => {
            for (key, value) in map {
                if key == "snapshotId"
                    && let Some(id) = value.as_str()
                {
                    ids.insert(id.into());
                }
                snapshot_ids(value, ids);
            }
        }
        Value::Array(values) => {
            for value in values {
                snapshot_ids(value, ids);
            }
        }
        _ => {}
    }
}
impl Project {
    fn at(&self, root: PathBuf) -> Self {
        Self {
            root,
            cache: Arc::default(),
            ..self.clone()
        }
    }
    pub(crate) fn referenced_packs(&self, kind: &str, id: &str, value: &Value) -> AppResult<Files> {
        let mut paths = BTreeSet::new();
        referenced_paths(value, &mut paths);
        let root = self.document_root(kind, id);
        paths
            .into_iter()
            .map(|p| Ok((p.clone(), fs::read(checked(&root, &p)?)?)))
            .collect()
    }
    pub(crate) fn document_root(&self, kind: &str, id: &str) -> PathBuf {
        self.origins
            .lock()
            .unwrap()
            .get(&(kind.into(), id.into()))
            .cloned()
            .unwrap_or_else(|| self.root.clone())
    }
    fn groups(&self, docs: &Documents) -> AppResult<BTreeMap<String, Documents>> {
        let mut groups = BTreeMap::<String, Documents>::new();
        let mut owned = BTreeSet::new();
        let mut shared = BTreeSet::new();
        for ((kind, _), value) in docs {
            if ["knowledge", "onboarding"].contains(&kind.as_str()) {
                snapshot_ids(value, &mut shared);
            }
        }
        for ((kind, id), value) in docs {
            if kind != "review" {
                continue;
            }
            let prefix = review_prefix(value)?;
            let group = groups.entry(prefix).or_default();
            group.insert((kind.clone(), id.clone()), value.clone());
            let snapshot = value["snapshotId"]
                .as_str()
                .ok_or_else(|| AppError::new("missing_snapshot", "Review has no capture."))?;
            let key = ("snapshot".into(), snapshot.to_string());
            let data = docs
                .get(&key)
                .ok_or_else(|| AppError::new("missing_snapshot", "Review capture is missing."))?;
            group.insert(key, data.clone());
            owned.insert(snapshot.to_string());
        }
        for ((kind, _), value) in docs {
            if kind != "proposal" {
                continue;
            }
            let review_id = value["reviewId"].as_str().unwrap_or_default();
            let review = docs
                .get(&("review".into(), review_id.into()))
                .ok_or_else(|| AppError::new("invalid_project", "Proposal review is missing."))?;
            let mut referenced = BTreeSet::new();
            snapshot_ids(value, &mut referenced);
            for snapshot_id in referenced {
                let key = ("snapshot".into(), snapshot_id.clone());
                let snapshot = docs.get(&key).ok_or_else(|| {
                    AppError::new("missing_snapshot", "Proposal capture is missing.")
                })?;
                groups
                    .entry(review_prefix(review)?)
                    .or_default()
                    .insert(key, snapshot.clone());
                owned.insert(snapshot_id);
            }
        }
        for ((kind, id), value) in docs {
            if kind == "review" || kind == "review_reference" || kind == "opaque_publication" {
                continue;
            }
            let prefix = if kind == "proposal" {
                let review_id = value["reviewId"]
                    .as_str()
                    .ok_or_else(|| AppError::new("invalid_project", "Proposal review missing."))?;
                let review = docs
                    .get(&("review".into(), review_id.into()))
                    .ok_or_else(|| {
                        AppError::new(
                            "invalid_project",
                            "Proposal refers to a missing or archived review.",
                        )
                    })?;
                review_prefix(review)?
            } else if kind == "snapshot" && !shared.contains(id) {
                if owned.contains(id) {
                    continue;
                }
                format!(".local/captures/{id}")
            } else {
                String::new()
            };
            groups
                .entry(prefix)
                .or_default()
                .insert((kind.clone(), id.clone()), value.clone());
        }
        Ok(groups)
    }
    /// Assemble every referenced pack alongside its owner. This also computes the
    /// exact set of obsolete files to remove in the same recovery transaction.
    pub(crate) fn files(
        &self,
        docs: &Documents,
        added: &Files,
        old: &Documents,
    ) -> AppResult<Files> {
        let mut files = Files::new();
        for (prefix, group) in self.groups(docs)? {
            if prefix.starts_with("published/")
                && group
                    .iter()
                    .filter(|((kind, _), _)| kind == "review")
                    .all(|(k, v)| old.get(k) == Some(v))
                && self.root.join(&prefix).join("bundle.json").exists()
            {
                let original = read_bundle(&checked(&self.root, &prefix)?)?;
                files.extend(
                    original
                        .into_iter()
                        .map(|(p, b)| (format!("{prefix}/{p}"), b)),
                );
                continue;
            }
            let mut bundle = self.encode_logical(&group)?;
            let mut paths = BTreeSet::new();
            for value in group.values() {
                referenced_paths(value, &mut paths);
            }
            for path in paths {
                let content = if let Some(content) = added.get(&path) {
                    content.clone()
                } else {
                    let mut candidate = None;
                    for (key, value) in old {
                        let mut previous = BTreeSet::new();
                        referenced_paths(value, &mut previous);
                        if previous.contains(&path) {
                            let origin = self.document_root(&key.0, &key.1);
                            let location = checked(&origin, &path)?;
                            if location.exists() {
                                candidate = Some(fs::read(location)?);
                                break;
                            }
                        }
                    }
                    candidate.ok_or_else(|| {
                        AppError::new(
                            "missing_content",
                            format!("Referenced pack is missing: {path}"),
                        )
                    })?
                };
                bundle.insert(path, content);
            }
            if prefix.starts_with("published/") {
                publication::seal_bundle(prefix.strip_prefix("published/").unwrap(), &mut bundle)?;
            }
            files.extend(bundle.into_iter().map(|(path, data)| {
                (
                    if prefix.is_empty() {
                        path
                    } else {
                        format!("{prefix}/{path}")
                    },
                    data,
                )
            }));
        }
        for (kind, id) in docs.keys() {
            if kind == "opaque_publication" {
                let prefix = format!("published/{id}");
                files.extend(
                    read_bundle(&checked(&self.root, &prefix)?)?
                        .into_iter()
                        .map(|(p, b)| (format!("{prefix}/{p}"), b)),
                );
            }
        }
        for ((kind, id), value) in docs {
            if kind != "review_reference" {
                continue;
            }
            identifier(id)?;
            let mut data = value.clone();
            self.remap(&mut data, true);
            files.insert(
                format!("references/{id}.json"),
                bytes(&Document {
                    format: "reviewbox".into(),
                    version: VERSION,
                    kind: kind.clone(),
                    id: id.clone(),
                    data,
                })?,
            );
        }
        Ok(files)
    }
    pub(crate) fn bundle_files(&self, review: &Value, docs: &Documents) -> AppResult<Files> {
        let prefix = format!("{}/", review_prefix(review)?);
        Ok(self
            .files(docs, &Files::new(), docs)?
            .into_iter()
            .filter_map(|(p, b)| p.strip_prefix(&prefix).map(|p| (p.to_string(), b)))
            .collect())
    }
    pub fn read(&self) -> AppResult<Documents> {
        let manifest: Manifest =
            serde_json::from_slice(&fs::read(checked(&self.root, "project.json")?)?)?;
        if manifest.format != "reviewbox"
            || manifest.version != VERSION
            || manifest.project_id != self.project_id
        {
            return Err(AppError::new(
                "project_version",
                "Storage v4 is required; no files were changed.",
            ));
        }
        let mut all = self.read_logical()?;
        let mut origins: BTreeMap<_, _> = all
            .keys()
            .cloned()
            .map(|k| (k, self.root.clone()))
            .collect();
        for prefix in [".local/reviews", ".local/captures", "published"] {
            let directory = checked(&self.root, prefix)?;
            if !directory.exists() {
                continue;
            }
            for entry in fs::read_dir(directory)? {
                let entry = entry?;
                let name = entry.file_name().to_string_lossy().into_owned();
                identifier(&name)?;
                let root = checked(&self.root, &format!("{prefix}/{name}"))?;
                if !root.is_dir() {
                    return Err(AppError::new("invalid_project", "Unexpected bundle file."));
                }
                let docs = match self.at(root.clone()).read_logical() {
                    Ok(docs) => docs,
                    Err(error) if prefix == "published" => {
                        all.insert(
                            ("opaque_publication".into(), name.clone()),
                            json!({"reason":error.message}),
                        );
                        continue;
                    }
                    Err(error) => return Err(error),
                };
                // Empty directories left by an interrupted cleanup are harmless.
                if docs.is_empty() {
                    continue;
                }
                if prefix != ".local/captures" {
                    let review = docs.get(&("review".into(), name.clone())).ok_or_else(|| {
                        AppError::new("invalid_project", "Bundle review is missing.")
                    })?;
                    if review_prefix(review)? != format!("{prefix}/{name}") {
                        return Err(AppError::new(
                            "invalid_project",
                            "Review state and storage origin disagree.",
                        ));
                    }
                }
                for (key, value) in docs {
                    if let Some(existing) = all.get(&key) {
                        if existing != &value {
                            let mut a = existing.clone();
                            let mut b = value.clone();
                            if key.0 == "snapshot" {
                                a.as_object_mut().unwrap().remove("sourceIndex");
                                b.as_object_mut().unwrap().remove("sourceIndex");
                            }
                            if a != b {
                                return Err(AppError::new(
                                    "duplicate_id",
                                    "Conflicting documents share an identifier.",
                                ));
                            }
                            let packed = |v: &Value| {
                                v["sourceIndex"]
                                    .as_object()
                                    .into_iter()
                                    .flat_map(|m| m.values())
                                    .filter(|v| v["kind"] == "pack")
                                    .count()
                            };
                            if packed(&value) > packed(existing) {
                                origins.insert(key.clone(), root.clone());
                                all.insert(key, value);
                            }
                        }
                    } else {
                        origins.insert(key.clone(), root.clone());
                        all.insert(key, value);
                    }
                }
            }
        }
        let references = checked(&self.root, "references")?;
        if references.exists() {
            for entry in fs::read_dir(references)? {
                let entry = entry?;
                let name = entry.file_name().to_string_lossy().into_owned();
                let path = checked(&self.root, &format!("references/{name}"))?;
                let mut doc: Document = serde_json::from_slice(&fs::read(path)?)?;
                identifier(&doc.id)?;
                if doc.version != VERSION
                    || doc.format != "reviewbox"
                    || doc.kind != "review_reference"
                    || name != format!("{}.json", doc.id)
                    || all.contains_key(&("review".into(), doc.id.clone()))
                {
                    return Err(AppError::new(
                        "invalid_project",
                        "Invalid or duplicated archive reference.",
                    ));
                }
                let reference: ArchiveReference = serde_json::from_value(doc.data.clone())?;
                if reference.id != doc.id
                    || reference.publication.status != PublicationStatus::Archived
                    || reference.publication.archive.is_none()
                    || reference.publication.completion.is_none()
                    || reference.repository_id != self.project_id
                {
                    return Err(AppError::new(
                        "invalid_project",
                        "Invalid archive attestation.",
                    ));
                }
                self.remap(&mut doc.data, false);
                all.insert((doc.kind, doc.id), doc.data);
            }
        }
        origins.extend(
            self.origins
                .lock()
                .unwrap()
                .iter()
                .filter(|(_, path)| path.to_string_lossy().contains("/.local/archives/"))
                .map(|(k, v)| (k.clone(), v.clone())),
        );
        *self.origins.lock().unwrap() = origins;
        self.index_sources(&all)?;
        Ok(all)
    }
    pub(crate) fn archived_content_owner(&self, hash: &str) -> Option<String> {
        let sources = self.sources.lock().ok()?;
        let source = sources.get(hash)?;
        let relative = source
            .root
            .strip_prefix(self.root.join(".local/archives"))
            .ok()?;
        relative
            .components()
            .next()?
            .as_os_str()
            .to_str()
            .map(String::from)
    }
    pub(crate) fn load_archive(
        &self,
        reference: &Value,
        protected: &BTreeSet<String>,
    ) -> AppResult<Documents> {
        self.load_archive_with_limit(reference, protected, super::archive_cache::LIMIT)
    }
    pub(crate) fn load_archive_with_limit(
        &self,
        reference: &Value,
        protected: &BTreeSet<String>,
        limit: u64,
    ) -> AppResult<Documents> {
        let archive: ReviewArchive =
            serde_json::from_value(reference["publication"]["archive"].clone())?;
        let location = publication::ArchiveLocation {
            commit: archive.commit_id,
            path: archive.bundle_path,
            bundle_hash: archive.bundle_hash,
        };
        let files = publication::read_archive(
            self,
            reference["id"].as_str().unwrap_or_default(),
            &location,
            |files, commit| content::verify_bundle_sources(self, files, commit),
        )?;
        let review_id = reference["id"]
            .as_str()
            .ok_or_else(|| AppError::new("invalid_id", "Archive ID missing."))?;
        identifier(review_id)?;
        let cache = checked(
            &self.root,
            &format!(".local/archives/{review_id}/{}", location.bundle_hash),
        )?;
        for (path, data) in &files {
            let path = checked(&cache, path)?;
            if fs::read(&path).as_ref().ok() != Some(data) {
                atomic(&path, data)?;
            }
        }
        let mut docs = self.at(cache.clone()).read_logical()?;
        let review = docs
            .get(&("review".into(), review_id.into()))
            .ok_or_else(|| AppError::new("invalid_publication", "Archive has no review."))?;
        for field in [
            "id",
            "repositoryId",
            "snapshotId",
            "title",
            "mode",
            "createdAt",
            "updatedAt",
        ] {
            if review[field] != reference[field] {
                return Err(AppError::new(
                    "invalid_publication",
                    format!("Archive reference {field} does not match its original review."),
                ));
            }
        }
        for field in ["completion", "originReviewId", "keepLocal"] {
            if review["publication"][field] != reference["publication"][field] {
                return Err(AppError::new(
                    "invalid_publication",
                    "Archive reference attestation does not match its original review.",
                ));
            }
        }
        let snapshot = docs
            .get(&(
                "snapshot".into(),
                review["snapshotId"].as_str().unwrap_or_default().into(),
            ))
            .ok_or_else(|| AppError::new("invalid_publication", "Archive capture is missing."))?;
        let snapshot: Snapshot = serde_json::from_value(snapshot.clone())?;
        let actual_scope = publication::scope_fingerprint(&snapshot)?;
        if reference["scope"] != serde_json::to_value(&snapshot.request)?
            || reference["publication"]["completion"]["scopeFingerprint"].as_str()
                != Some(&actual_scope)
            || reference["publication"]["fileCount"].as_u64()
                != Some(review["files"].as_array().map_or(0, Vec::len) as u64)
            || reference["publication"]["stepCount"].as_u64()
                != Some(
                    review["topics"]
                        .as_array()
                        .into_iter()
                        .flatten()
                        .map(|topic| topic["steps"].as_array().map_or(0, Vec::len) as u64)
                        .sum(),
                )
        {
            return Err(AppError::new(
                "invalid_publication",
                "Archive reference scope or counters do not match the captured review.",
            ));
        }
        let review = docs
            .get_mut(&("review".into(), review_id.into()))
            .expect("verified review");
        review["publication"] = reference["publication"].clone();
        review["revision"] = json!(0);
        for key in docs.keys() {
            self.origins
                .lock()
                .unwrap()
                .insert(key.clone(), cache.clone());
        }
        let mut sources = content::index_sources(&docs)?;
        for located in sources.values_mut() {
            located.root = cache.clone();
        }
        let mut existing = self.sources.lock().unwrap();
        for (hash, source) in sources {
            if let Some(previous) = existing.get_mut(&hash) {
                if previous.root.starts_with(self.root.join(".local/archives"))
                    && !previous.root.exists()
                {
                    *previous = source;
                }
            } else {
                existing.insert(hash, source);
            }
        }
        drop(existing);
        super::archive_cache::collect(self, &cache, protected, limit)?;
        Ok(docs)
    }
}

fn read_bundle(root: &Path) -> AppResult<Files> {
    fn walk(root: &Path, prefix: &str, files: &mut Files) -> AppResult<()> {
        for entry in fs::read_dir(if prefix.is_empty() {
            root.to_path_buf()
        } else {
            checked(root, prefix)?
        })? {
            let entry = entry?;
            let name = entry.file_name().to_string_lossy().into_owned();
            let path = if prefix.is_empty() {
                name
            } else {
                format!("{prefix}/{name}")
            };
            let actual = checked(root, &path)?;
            if actual.is_dir() {
                walk(root, &path, files)?;
            } else {
                files.insert(path, fs::read(actual)?);
            }
        }
        Ok(())
    }
    let mut files = Files::new();
    walk(root, "", &mut files)?;
    Ok(files)
}
