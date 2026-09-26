use crate::{
    contracts::*,
    project_storage::{self, Documents, Project},
};
use notify::Watcher;
use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
};

struct Mounted {
    project: Project,
    documents: Documents,
    dirty: Arc<AtomicBool>,
    _watcher: notify::RecommendedWatcher,
}
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Serialize, de::DeserializeOwned};
use std::{fs, path::PathBuf, time::Duration};

#[derive(Clone)]
pub struct Storage {
    root: PathBuf,
    scope: Option<String>,
    projects: Arc<Mutex<BTreeMap<String, Mounted>>>,
    writes: Arc<Mutex<()>>,
    _owner: std::sync::Arc<project_storage::FileLock>,
}
impl Storage {
    pub fn scoped(&self, repository_id: Option<&str>) -> Self {
        let mut scoped = self.clone();
        scoped.scope = repository_id
            .map(String::from)
            .or_else(|| self.scope.clone());
        scoped
    }
    pub fn open(root: PathBuf) -> AppResult<Self> {
        fs::create_dir_all(root.join("blobs"))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&root, fs::Permissions::from_mode(0o700))?;
        }
        let owner = fs::OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(root.join("owner.lock"))?;
        owner.try_lock().map_err(|_| {
            AppError::new(
                "already_open",
                "Another ReviewBox process already owns this local database.",
            )
        })?;
        let storage = Self {
            root,
            scope: None,
            projects: Arc::default(),
            writes: Arc::default(),
            _owner: std::sync::Arc::new(project_storage::FileLock(owner)),
        };
        let mut db = storage.connection()?;
        let version: u32 = db.pragma_query_value(None, "user_version", |r| r.get(0))?;
        if version > 2 {
            return Err(AppError::new(
                "newer_database",
                "This database needs a newer ReviewBox version.",
            ));
        }
        let tx = db.transaction()?;
        tx.execute_batch("CREATE TABLE IF NOT EXISTS documents (kind TEXT NOT NULL, id TEXT NOT NULL, revision INTEGER NOT NULL, body TEXT NOT NULL, PRIMARY KEY(kind,id)); PRAGMA user_version=2;")?;
        // A new owner cannot inherit live permissions or unfinished executions.
        tx.execute("UPDATE documents SET body=json_set(body,'$.status','interrupted','$.snapshotMatches',json('false'),'$.finishedAt',?1), revision=revision+1 WHERE kind='test_run' AND json_extract(body,'$.status') IN ('running','awaiting_permission')", [now()])?;
        tx.execute("UPDATE documents SET body=json_set(body,'$.status','interrupted'), revision=revision+1 WHERE kind='agent_run' AND json_extract(body,'$.status')='running'", [])?;
        tx.execute_batch("CREATE TABLE IF NOT EXISTS project_index (repository_id TEXT NOT NULL, kind TEXT NOT NULL, id TEXT NOT NULL, revision INTEGER NOT NULL, body TEXT NOT NULL, PRIMARY KEY(repository_id,kind,id)); CREATE TABLE IF NOT EXISTS git_sources (root TEXT NOT NULL, commit_oid TEXT NOT NULL, hash TEXT NOT NULL, oid TEXT NOT NULL, PRIMARY KEY(root,commit_oid,hash));")?;
        tx.commit()?;
        Ok(storage)
    }
    fn connection(&self) -> AppResult<Connection> {
        let db = Connection::open(self.root.join("reviewbox.sqlite3"))?;
        db.busy_timeout(Duration::from_secs(5))?;
        db.pragma_update(None, "journal_mode", "WAL")?;
        db.pragma_update(None, "synchronous", "FULL")?;
        Ok(db)
    }
    pub fn get<T: DeserializeOwned>(&self, kind: &str, id: &str) -> AppResult<T> {
        if project_storage::KINDS.contains(&kind) && !self.projects.lock().unwrap().is_empty() {
            self.sync_projects(false)?;
            let mut values = self
                .project_values(kind)?
                .into_iter()
                .filter(|(key, _)| key == id)
                .map(|(_, v)| v);
            let mut value = values
                .next()
                .ok_or_else(|| AppError::new("not_found", format!("{kind} was not found.")))?;
            if values.next().is_some() {
                return Err(AppError::new(
                    "ambiguous_checkout",
                    "This document exists in multiple open checkouts. Close and reopen the desired checkout.",
                ));
            }
            if kind == "review" {
                self.fill_reading(&mut value)?;
            }
            if kind == "onboarding" {
                self.fill_visits(&mut value);
            }
            return Ok(serde_json::from_value(value)?);
        }
        self.local_get(kind, id)
    }
    pub(crate) fn local_get<T: DeserializeOwned>(&self, kind: &str, id: &str) -> AppResult<T> {
        let body: Option<String> = self
            .connection()?
            .query_row(
                "SELECT body FROM documents WHERE kind=?1 AND id=?2",
                params![kind, id],
                |r| r.get(0),
            )
            .optional()?;
        serde_json::from_str(
            &body.ok_or_else(|| AppError::new("not_found", format!("{kind} was not found.")))?,
        )
        .map_err(Into::into)
    }
    pub fn list<T: DeserializeOwned>(&self, kind: &str) -> AppResult<Vec<T>> {
        if project_storage::KINDS.contains(&kind) && !self.projects.lock().unwrap().is_empty() {
            self.sync_projects(false)?;
            return self
                .project_values(kind)?
                .into_iter()
                .map(|(_, mut value)| {
                    if kind == "review" {
                        self.fill_reading(&mut value)?;
                    }
                    if kind == "onboarding" {
                        self.fill_visits(&mut value);
                    }
                    Ok(serde_json::from_value(value)?)
                })
                .collect();
        }
        self.local_list(kind)
    }
    pub(crate) fn local_list<T: DeserializeOwned>(&self, kind: &str) -> AppResult<Vec<T>> {
        let db = self.connection()?;
        let mut stmt =
            db.prepare("SELECT body FROM documents WHERE kind=?1 ORDER BY rowid DESC")?;
        stmt.query_map([kind], |r| r.get::<_, String>(0))?
            .map(|r| Ok(serde_json::from_str(&r?)?))
            .collect()
    }
    pub fn insert<T: Serialize>(&self, kind: &str, id: &str, value: &T) -> AppResult<()> {
        if project_storage::KINDS.contains(&kind) && !self.projects.lock().unwrap().is_empty() {
            return self.write_batch(vec![(kind, id, None, serde_json::to_value(value)?)]);
        }
        self.connection()?.execute(
            "INSERT INTO documents(kind,id,revision,body) VALUES(?1,?2,0,?3)",
            params![kind, id, serde_json::to_string(value)?],
        )?;
        Ok(())
    }
    pub fn replace<T: Serialize>(
        &self,
        kind: &str,
        id: &str,
        revision: u32,
        value: &T,
    ) -> AppResult<()> {
        if project_storage::KINDS.contains(&kind) && !self.projects.lock().unwrap().is_empty() {
            return self.write_batch(vec![(
                kind,
                id,
                Some(revision),
                serde_json::to_value(value)?,
            )]);
        }
        let count=self.connection()?.execute("UPDATE documents SET body=?1, revision=revision+1 WHERE kind=?2 AND id=?3 AND revision=?4", params![serde_json::to_string(value)?,kind,id,revision])?;
        if count != 1 {
            return Err(AppError::new(
                "conflict",
                "This item changed in another operation. Reload and try again.",
            ));
        }
        Ok(())
    }
    /// Commit related aggregate changes together; None requires an absent document.
    pub fn write_batch(
        &self,
        writes: Vec<(&str, &str, Option<u32>, serde_json::Value)>,
    ) -> AppResult<()> {
        if writes
            .iter()
            .any(|(kind, _, _, _)| project_storage::KINDS.contains(kind))
            && !self.projects.lock().unwrap().is_empty()
        {
            return self.project_write(writes);
        }
        let mut db = self.connection()?;
        let tx = db.transaction()?;
        for (kind, id, revision, value) in writes {
            let body = serde_json::to_string(&value)?;
            let count = match revision {
                Some(revision) => tx.execute("UPDATE documents SET body=?1, revision=revision+1 WHERE kind=?2 AND id=?3 AND revision=?4", params![body,kind,id,revision])?,
                None => tx.execute("INSERT OR IGNORE INTO documents(kind,id,revision,body) VALUES(?1,?2,0,?3)", params![kind,id,body])?,
            };
            if count != 1 {
                return Err(AppError::new(
                    "conflict",
                    "An item changed. Reload before accepting this proposal.",
                ));
            }
        }
        tx.commit()?;
        Ok(())
    }
    pub fn remove(&self, kind: &str, id: &str) -> AppResult<()> {
        if project_storage::KINDS.contains(&kind) && !self.projects.lock().unwrap().is_empty() {
            self.sync_projects(true)?;
            let _write = self.writes.lock().unwrap();
            let mut mounted = self.projects.lock().unwrap();
            let matches: Vec<_> = mounted
                .iter()
                .filter(|(repo, m)| {
                    self.scope.as_ref().is_none_or(|scope| scope == *repo)
                        && m.documents.contains_key(&(kind.into(), id.into()))
                })
                .map(|(key, _)| key.clone())
                .collect();
            if matches.len() != 1 {
                return Err(AppError::new(
                    "not_found",
                    "Document is missing or ambiguous.",
                ));
            }
            let m = mounted.get_mut(&matches[0]).unwrap();
            let _lock = m.project.lock()?;
            m.project.recover_locked()?;
            let old = m.project.read()?;
            let mut next = old.clone();
            next.remove(&(kind.into(), id.into()));
            m.project.commit(&old, &next)?;
            m.documents = next;
            self.index(&m.project, &m.documents)?;
            return Ok(());
        }
        if kind == "repository" {
            self.projects.lock().unwrap().remove(id);
        }
        self.connection()?.execute(
            "DELETE FROM documents WHERE kind=?1 AND id=?2",
            params![kind, id],
        )?;
        Ok(())
    }
    pub fn blob(&self, bytes: &[u8], mode: String) -> AppResult<BlobRef> {
        let hash = fingerprint(bytes);
        let dest = self.root.join("blobs").join(&hash);
        if !dest.exists() {
            let tmp = self.root.join("blobs").join(format!(".{}", id()));
            let result = (|| {
                use std::io::Write;
                let mut file = fs::OpenOptions::new()
                    .write(true)
                    .create_new(true)
                    .open(&tmp)?;
                file.write_all(bytes)?;
                file.sync_all()?;
                fs::rename(&tmp, &dest)?;
                fs::File::open(self.root.join("blobs"))?.sync_all()?;
                Ok::<_, std::io::Error>(())
            })();
            if result.is_err() {
                let _ = fs::remove_file(&tmp);
            }
            result?;
        }
        Ok(BlobRef {
            hash,
            mode,
            size: bytes
                .len()
                .try_into()
                .map_err(|_| AppError::new("too_large", "File exceeds 4 GiB."))?,
        })
    }
    pub fn read_blob(&self, hash: &str) -> AppResult<Vec<u8>> {
        match self.cached_blob(hash) {
            Ok(bytes) => return Ok(bytes),
            Err(e) if e.code == "io" => {}
            Err(e) => return Err(e),
        }
        let projects: Vec<_> = self
            .projects
            .lock()
            .unwrap()
            .values()
            .filter(|m| {
                self.scope
                    .as_ref()
                    .is_none_or(|scope| scope == &m.project.repository_id)
            })
            .map(|m| m.project.clone())
            .collect();
        for project in projects {
            if let Some(bytes) = project_storage::restore_content(&project, hash)? {
                self.blob(&bytes, "100644".into())?;
                return Ok(bytes);
            }
        }
        Err(AppError::new(
            "missing_content",
            "Snapshot content is unavailable. Restore the project's .reviewbox/content files.",
        ))
    }
    pub(crate) fn cached_blob(&self, hash: &str) -> AppResult<Vec<u8>> {
        if hash.len() != 64 || !hash.bytes().all(|b| b.is_ascii_hexdigit()) {
            return Err(AppError::new("invalid_hash", "Invalid content identifier."));
        }
        let bytes = fs::read(self.root.join("blobs").join(hash))?;
        if fingerprint(&bytes) != hash {
            return Err(AppError::new(
                "corrupt_blob",
                "Stored content failed its integrity check.",
            ));
        }
        Ok(bytes)
    }
    pub fn author(&self) -> AppResult<String> {
        if let Ok(value) = self.local_get::<String>("identity", "author") {
            return Ok(value);
        }
        let author = format!("human:{}", id());
        self.connection()?.execute("INSERT OR IGNORE INTO documents(kind,id,revision,body) VALUES('identity','author',0,?1)", [serde_json::to_string(&author)?])?;
        self.local_get("identity", "author")
    }
    pub fn save_reading(&self, review: &Review) -> AppResult<()> {
        let key = format!("{}:{}", review.repository_id, review.id);
        self.connection()?.execute("INSERT INTO documents(kind,id,revision,body) VALUES('reading',?1,0,?2) ON CONFLICT(kind,id) DO UPDATE SET body=excluded.body", params![key,serde_json::to_string(&json!({"position":review.position,"examined":review.examined}))?])?;
        Ok(())
    }
    pub fn save_visits(&self, tour: &OnboardingTour) -> AppResult<()> {
        let key = format!("{}:{}", tour.repository_id, tour.id);
        let visits: Vec<_> = tour
            .steps
            .iter()
            .filter(|s| s.visited)
            .map(|s| &s.id)
            .collect();
        self.connection()?.execute("INSERT INTO documents(kind,id,revision,body) VALUES('tour_visits',?1,0,?2) ON CONFLICT(kind,id) DO UPDATE SET body=excluded.body",params![key,serde_json::to_string(&visits)?])?;
        Ok(())
    }
    fn fill_visits(&self, tour: &mut Value) {
        let key = format!(
            "{}:{}",
            tour["repositoryId"].as_str().unwrap_or_default(),
            tour["id"].as_str().unwrap_or_default()
        );
        let visits = self
            .local_get::<Vec<String>>("tour_visits", &key)
            .unwrap_or_default();
        if let Some(steps) = tour["steps"].as_array_mut() {
            for step in steps {
                step["visited"] = json!(
                    step["id"]
                        .as_str()
                        .is_some_and(|s| visits.iter().any(|id| id == s))
                );
            }
        }
    }
    fn fill_reading(&self, review: &mut Value) -> AppResult<()> {
        let key = format!(
            "{}:{}",
            review["repositoryId"].as_str().unwrap_or_default(),
            review["id"].as_str().unwrap_or_default()
        );
        let state = self
            .local_get::<Value>("reading", &key)
            .unwrap_or_else(|_| json!({"position":ReadingPosition::default(),"examined":[]}));
        review["position"] = state["position"].clone();
        review["examined"] = state["examined"].clone();
        Ok(())
    }
    pub fn record_git_blobs(
        &self,
        root: &std::path::Path,
        reference: &str,
        sources: &[(String, String)],
    ) -> AppResult<()> {
        if sources.is_empty() {
            return Ok(());
        }
        let mut db = self.connection()?;
        let tx = db.transaction()?;
        {
            let mut statement = tx.prepare(
                "INSERT OR IGNORE INTO git_sources(root,commit_oid,hash,oid) VALUES(?1,?2,?3,?4)",
            )?;
            for (hash, oid) in sources {
                statement.execute(params![root.to_string_lossy(), reference, hash, oid])?;
            }
        }
        tx.commit()?;
        Ok(())
    }
    pub fn git_sources(
        &self,
        root: &std::path::Path,
        references: &[String],
    ) -> AppResult<BTreeMap<String, String>> {
        let db = self.connection()?;
        let mut result = BTreeMap::new();
        let mut statement =
            db.prepare("SELECT hash,oid FROM git_sources WHERE root=?1 AND commit_oid=?2")?;
        for reference in references {
            for row in statement.query_map(params![root.to_string_lossy(), reference], |r| {
                Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
            })? {
                let (hash, oid) = row?;
                result.insert(hash, oid);
            }
        }
        Ok(result)
    }
    pub fn mount(&self, repo: &Repository) -> AppResult<()> {
        if self.projects.lock().unwrap().contains_key(&repo.id) {
            return self.sync_projects(true);
        }
        let project = Project::open(std::path::Path::new(&repo.path), &repo.id)?;
        let _lock = project.lock()?;
        let mut documents = project.read()?;
        let mut migration = Documents::new();
        for kind in project_storage::KINDS {
            if *kind == "project_settings" {
                continue;
            }
            for value in self.local_list::<Value>(kind)? {
                let belongs = value["repositoryId"] == repo.id
                    || (*kind == "proposal"
                        && self
                            .local_get::<Review>(
                                "review",
                                value["reviewId"].as_str().unwrap_or_default(),
                            )
                            .is_ok_and(|r| r.repository_id == repo.id));
                if !belongs {
                    continue;
                }
                let key = if *kind == "knowledge" {
                    repo.id.clone()
                } else if *kind == "review_history" {
                    format!(
                        "{}@{}",
                        value["id"].as_str().unwrap_or_default(),
                        value["revision"].as_u64().unwrap_or_default()
                    )
                } else {
                    value["id"].as_str().unwrap_or_default().to_string()
                };
                migration.insert((kind.to_string(), key), value);
            }
        }
        let marker = format!("{}:{}", repo.id, project.project_id);
        let migrated = self
            .local_get::<String>("migrated_repository", &repo.id)
            .is_ok()
            || self
                .local_get::<bool>("project_migration", &marker)
                .unwrap_or(false);
        if !migrated && !migration.is_empty() {
            let receipt = project_storage::checked(&project.root, ".local/migration.json")?;
            let source_hash = fingerprint(&serde_json::to_vec(&project.encode(&migration)?)?);
            let resume = fs::read(&receipt)
                .ok()
                .and_then(|b| serde_json::from_slice::<Value>(&b).ok())
                .is_some_and(|v| v["sourceHash"] == source_hash);
            let mut migrated_docs = documents.clone();
            migrated_docs.remove(&("project_settings".into(), repo.id.clone()));
            let already_written =
                resume && project.encode(&migrated_docs)? == project.encode(&migration)?;
            if !documents.is_empty() && !already_written {
                return Err(AppError::new(
                    "migration_conflict",
                    "This .reviewbox already contains data. The legacy database is preserved; no files were overwritten.",
                ));
            }
            if !resume {
                let backup = self.root.join("backups");
                fs::create_dir_all(&backup)?;
                let dest = backup.join(format!("legacy-{}.sqlite3", id()));
                self.connection()?
                    .execute("VACUUM INTO ?1", [dest.to_string_lossy().as_ref()])?;
                project_storage::atomic(
                    &receipt,
                    &serde_json::to_vec(&json!({"sourceHash":source_hash}))?,
                )?;
            }
            for ((kind, _), value) in &migration {
                if kind == "review" {
                    self.save_reading(&serde_json::from_value(value.clone())?)?;
                }
                if kind == "snapshot" {
                    let snapshot: Snapshot = serde_json::from_value(value.clone())?;
                    let _ = crate::snapshots::git_tree(
                        self,
                        std::path::Path::new(&repo.path),
                        &snapshot.head,
                    );
                    project_storage::export_content(self, &project, &snapshot)?;
                }
                if kind == "onboarding" {
                    self.save_visits(&serde_json::from_value(value.clone())?)?;
                }
            }
            if !already_written {
                project.commit(&documents, &migration)?;
                documents = migration;
            }
        }
        if !documents.contains_key(&("project_settings".into(), repo.id.clone())) {
            let mut next = documents.clone();
            let mut settings = ProjectSettings::default();
            if let Some(k) = documents.get(&("knowledge".into(), repo.id.clone())) {
                settings.language = k["language"].as_str().unwrap_or("French").into();
            }
            next.insert(
                ("project_settings".into(), repo.id.clone()),
                serde_json::to_value(settings)?,
            );
            project.commit(&documents, &next)?;
            documents = next;
        }
        self.connection()?.execute("INSERT OR REPLACE INTO documents(kind,id,revision,body) VALUES('project_migration',?1,0,'true')",[marker])?;
        self.connection()?.execute("INSERT OR REPLACE INTO documents(kind,id,revision,body) VALUES('migrated_repository',?1,0,?2)",params![repo.id,serde_json::to_string(&project.project_id)?])?;
        self.index(&project, &documents)?;
        let dirty = Arc::new(AtomicBool::new(false));
        let flag = dirty.clone();
        let mut watcher =
            notify::recommended_watcher(move |event: notify::Result<notify::Event>| {
                if event.as_ref().map_or(true, |e| {
                    !e.kind.is_access()
                        && e.paths
                            .iter()
                            .any(|p| !p.components().any(|c| c.as_os_str() == ".local"))
                }) {
                    flag.store(true, Ordering::Release);
                }
            })
            .map_err(|e| AppError::new("watcher", e.to_string()))?;
        watcher
            .watch(&project.root, notify::RecursiveMode::Recursive)
            .map_err(|e| AppError::new("watcher", e.to_string()))?;
        self.projects.lock().unwrap().insert(
            repo.id.clone(),
            Mounted {
                project,
                documents,
                dirty,
                _watcher: watcher,
            },
        );
        Ok(())
    }
    fn index(&self, project: &Project, docs: &Documents) -> AppResult<()> {
        let mut db = self.connection()?;
        let tx = db.transaction()?;
        let mut existing = BTreeMap::new();
        {
            let mut stmt = tx.prepare(
                "SELECT kind,id,revision,body FROM project_index WHERE repository_id=?1",
            )?;
            for row in stmt.query_map([&project.repository_id], |r| {
                Ok((
                    (r.get::<_, String>(0)?, r.get::<_, String>(1)?),
                    (r.get::<_, u32>(2)?, r.get::<_, String>(3)?),
                ))
            })? {
                let (k, v) = row?;
                existing.insert(k, v);
            }
        }
        for (key, value) in docs {
            let mut value = value.clone();
            if key.0 == "review" || key.0 == "review_history" {
                value.as_object_mut().unwrap().remove("position");
                value.as_object_mut().unwrap().remove("examined");
            }
            if key.0 == "onboarding"
                && let Some(steps) = value["steps"].as_array_mut()
            {
                for step in steps {
                    step.as_object_mut().unwrap().remove("visited");
                }
            }
            let revision = value["revision"].as_u64().unwrap_or_default() as u32;
            let mut indexed = value.clone();
            if let Some((previous, body)) = existing.remove(key) {
                let mut old: Value = serde_json::from_str(&body)?;
                if value.get("revision").is_some() {
                    old["revision"] = json!(revision);
                }
                if old == value && revision <= previous {
                    continue;
                }
                if value.get("revision").is_some() {
                    indexed["revision"] = json!(revision.max(previous.saturating_add(1)));
                }
            }
            tx.execute("INSERT INTO project_index(repository_id,kind,id,revision,body) VALUES(?1,?2,?3,?4,?5) ON CONFLICT(repository_id,kind,id) DO UPDATE SET revision=excluded.revision,body=excluded.body", params![project.repository_id,key.0,key.1,indexed["revision"].as_u64().unwrap_or_default() as u32,serde_json::to_string(&indexed)?])?;
        }
        for (key, _) in existing {
            tx.execute(
                "DELETE FROM project_index WHERE repository_id=?1 AND kind=?2 AND id=?3",
                params![project.repository_id, key.0, key.1],
            )?;
        }
        tx.commit()?;
        Ok(())
    }
    fn sync_projects(&self, force: bool) -> AppResult<()> {
        let mut projects = self.projects.lock().unwrap();
        for (repository_id, mounted) in projects.iter_mut() {
            if self
                .scope
                .as_ref()
                .is_some_and(|scope| scope != repository_id)
            {
                continue;
            }
            if force || mounted.dirty.swap(false, Ordering::AcqRel) {
                let result: AppResult<()> = (|| {
                    let _lock = mounted.project.lock()?;
                    mounted.project.recover_locked()?;
                    let docs = mounted.project.read()?;
                    self.index(&mounted.project, &docs)?;
                    mounted.documents = docs;
                    Ok(())
                })();
                if result.is_err() {
                    mounted.dirty.store(true, Ordering::Release);
                }
                result?;
            }
        }
        Ok(())
    }
    fn project_values(&self, kind: &str) -> AppResult<Vec<(String, Value)>> {
        let projects = self.projects.lock().unwrap();
        let db = self.connection()?;
        let mut result = Vec::new();
        for repository_id in projects.keys() {
            if self
                .scope
                .as_ref()
                .is_some_and(|scope| scope != repository_id)
            {
                continue;
            }
            let mut stmt =
                db.prepare("SELECT id,body FROM project_index WHERE repository_id=?1 AND kind=?2")?;
            for row in stmt.query_map(params![repository_id, kind], |r| {
                Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
            })? {
                let (id, body) = row?;
                result.push((id, serde_json::from_str(&body)?));
            }
        }
        Ok(result)
    }
    fn project_write(&self, writes: Vec<(&str, &str, Option<u32>, Value)>) -> AppResult<()> {
        let _write = self.writes.lock().unwrap();
        self.sync_projects(true)?;
        let repository_id = writes
            .iter()
            .find_map(|(_, _, _, v)| v["repositoryId"].as_str().map(String::from))
            .or_else(|| {
                writes.iter().find_map(|(kind, key, _, v)| {
                    if *kind == "project_settings" {
                        return Some(key.to_string());
                    }
                    self.project_values("review")
                        .ok()?
                        .into_iter()
                        .find(|(id, _)| Some(id.as_str()) == v["reviewId"].as_str())
                        .and_then(|(_, r)| r["repositoryId"].as_str().map(String::from))
                })
            })
            .ok_or_else(|| AppError::new("project", "Cannot determine the owning project."))?;
        if self
            .scope
            .as_ref()
            .is_some_and(|scope| scope != &repository_id)
        {
            return Err(AppError::new(
                "project_mismatch",
                "This operation belongs to a different checkout.",
            ));
        }
        let project = self
            .projects
            .lock()
            .unwrap()
            .get(&repository_id)
            .map(|m| m.project.clone())
            .ok_or_else(|| AppError::new("project", "Open this project first."))?;
        let _lock = project.lock()?;
        project.recover_locked()?;
        let old = project.read()?;
        self.index(&project, &old)?;
        let mut next = old.clone();
        for (kind, key, expected, value) in &writes {
            if !project_storage::KINDS.contains(kind) {
                return Err(AppError::new(
                    "storage_boundary",
                    "Local and project writes must be separate.",
                ));
            }
            let current: Option<u32>=self.connection()?.query_row("SELECT revision FROM project_index WHERE repository_id=?1 AND kind=?2 AND id=?3",params![repository_id,kind,key],|r|r.get(0)).optional()?;
            if current != *expected {
                return Err(AppError::new(
                    "conflict",
                    "This item changed. Reload before saving.",
                ));
            }
            if *kind == "snapshot" {
                project_storage::export_content(
                    self,
                    &project,
                    &serde_json::from_value(value.clone())?,
                )?;
            }
            if *kind == "review" {
                self.save_reading(&serde_json::from_value(value.clone())?)?;
            }
            if *kind == "onboarding" {
                let local_key = format!("{repository_id}:{key}");
                let visits: Vec<_> = value["steps"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter(|s| s["visited"] == true)
                    .map(|s| s["id"].clone())
                    .collect();
                self.connection()?.execute("INSERT INTO documents(kind,id,revision,body) VALUES('tour_visits',?1,0,?2) ON CONFLICT(kind,id) DO UPDATE SET body=excluded.body",params![local_key,serde_json::to_string(&visits)?])?;
            }
            next.insert((kind.to_string(), key.to_string()), value.clone());
        }
        project.commit(&old, &next)?;
        self.index(&project, &next)?;
        if let Some(m) = self.projects.lock().unwrap().get_mut(&repository_id) {
            m.documents = next;
            m.dirty.store(true, Ordering::Release);
        }
        Ok(())
    }
    pub fn project_settings(&self, repository_id: &str) -> AppResult<ProjectSettings> {
        self.get("project_settings", repository_id)
    }
    pub fn save_project_settings(
        &self,
        repository_id: &str,
        mut settings: ProjectSettings,
    ) -> AppResult<ProjectSettings> {
        if settings.language.trim().is_empty()
            || settings
                .provider
                .as_ref()
                .is_some_and(|p| !["codex", "claude"].contains(&p.as_str()))
        {
            return Err(AppError::new(
                "settings",
                "Choose a language and supported provider.",
            ));
        }
        let revision = settings.revision;
        settings.revision += 1;
        let mut writes = vec![(
            "project_settings",
            repository_id,
            Some(revision),
            serde_json::to_value(&settings)?,
        )];
        if let Ok(mut knowledge) = self.get::<ProjectKnowledge>("knowledge", repository_id) {
            let previous = knowledge.revision;
            knowledge.language = settings.language.clone();
            knowledge.revision += 1;
            writes.push((
                "knowledge",
                repository_id,
                Some(previous),
                serde_json::to_value(knowledge)?,
            ));
        }
        self.write_batch(writes)?;
        Ok(settings)
    }
    #[cfg(test)]
    pub fn root(&self) -> &std::path::Path {
        &self.root
    }
}
