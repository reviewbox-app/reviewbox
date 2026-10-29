//! Session-only read models. Each checkout owns its work lock and watcher;
//! immutable review capture deliberately does not use these shortcuts.
use crate::{contracts::*, repositories, storage::Storage};
use notify::Watcher;
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    path::{Path, PathBuf},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicU64, Ordering},
    },
    time::{Duration, Instant},
};

mod events;

type Notifier = Arc<dyn Fn(RepositoryReadChange) + Send + Sync>;
type NativeNotifier = Arc<dyn Fn(&Path, &RepositoryReadChange) + Send + Sync>;

#[derive(Default)]
pub(crate) struct RepositoryCache {
    notifier: Mutex<Option<Notifier>>,
    native_notifier: Mutex<Option<NativeNotifier>>,
    // Explicit consumers pin their watcher independently of disposable read caches.
    leases: Mutex<BTreeMap<(PathBuf, String), Arc<Entry>>>,
    entries: Mutex<BTreeMap<PathBuf, Arc<Entry>>>,
    requests: Mutex<BTreeMap<String, Arc<AtomicBool>>>,
}
struct Changes {
    paths: BTreeSet<PathBuf>,
    uncertain: bool,
}
pub(crate) struct Entry {
    pub data: Mutex<Data>,
    changes: Arc<Mutex<Changes>>,
    watcher: Mutex<Option<notify::RecommendedWatcher>>,
    publish: Notifier,
    generation: String,
    sequence: Arc<AtomicU64>,
    healthy: Arc<AtomicBool>,
    starting: AtomicBool,
    watch_epoch: Arc<AtomicU64>,
    root: PathBuf,
    saved: Arc<Mutex<BTreeMap<String, String>>>,
}
pub(crate) struct Data {
    pub fingerprint: String,
    pub previews: BTreeMap<String, ReviewPreview>,
    pub statistics: BTreeMap<String, crate::review_creation::Stats>,
    pub context: Option<Snapshot>,
    pub retired_contexts: Vec<Snapshot>,
    pub context_fingerprint: String,
    pub sources: Sources,
    touched: Instant,
}
#[derive(Default)]
pub(crate) struct Sources {
    pub objects: BTreeMap<String, BlobRef>,
    pub working: BTreeMap<PathBuf, (String, BlobRef)>,
    #[cfg(test)]
    pub working_reads: usize,
    #[cfg(test)]
    pub object_reads: usize,
}
impl Default for Data {
    fn default() -> Self {
        Self {
            fingerprint: String::new(),
            previews: BTreeMap::new(),
            statistics: BTreeMap::new(),
            context: None,
            retired_contexts: Vec::new(),
            context_fingerprint: String::new(),
            sources: Sources::default(),
            touched: Instant::now(),
        }
    }
}
pub(crate) struct Request {
    id: String,
    cancelled: Arc<AtomicBool>,
}
impl Request {
    pub fn check(&self) -> AppResult<()> {
        if self.cancelled.load(Ordering::Acquire) {
            Err(AppError::new("cancelled", "This read was superseded."))
        } else {
            Ok(())
        }
    }
}
impl RepositoryCache {
    pub fn set_notifier(&self, notify: impl Fn(RepositoryReadChange) + Send + Sync + 'static) {
        *self.notifier.lock().unwrap_or_else(|e| e.into_inner()) = Some(Arc::new(notify));
    }
    pub fn set_native_notifier(
        &self,
        notify: impl Fn(&Path, &RepositoryReadChange) + Send + Sync + 'static,
    ) {
        *self
            .native_notifier
            .lock()
            .unwrap_or_else(|e| e.into_inner()) = Some(Arc::new(notify));
    }
    pub fn lease(
        &self,
        storage: &Storage,
        root: &Path,
        owner: &str,
    ) -> AppResult<EditorWatchStatus> {
        if owner.is_empty() || owner.len() > 128 {
            return Err(AppError::new("watch_owner", "Invalid watcher owner."));
        }
        let entry = self.entry(storage, root)?;
        let mut leases = self.leases.lock().unwrap_or_else(|e| e.into_inner());
        leases.insert((root.into(), owner.into()), entry.clone());
        ensure_watch(&entry);
        Ok(entry.status())
    }
    pub fn release_lease(&self, root: &Path, owner: &str) -> EditorWatchStatus {
        let mut leases = self.leases.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(entry) = leases.remove(&(root.into(), owner.into())) {
            if !leases.keys().any(|(checkout, _)| checkout == root) {
                entry.stop_watch();
            }
            return entry.status();
        }
        EditorWatchStatus {
            healthy: false,
            generation: String::new(),
            sequence: 0,
        }
    }
    pub fn watch_status(&self, storage: &Storage, root: &Path) -> AppResult<EditorWatchStatus> {
        let entry = self.entry(storage, root)?;
        let leases = self.leases.lock().unwrap_or_else(|e| e.into_inner());
        if leases.keys().any(|(checkout, _)| checkout == root) {
            ensure_watch(&entry);
        }
        Ok(entry.status())
    }
    pub fn begin(&self, id: &str) -> AppResult<Request> {
        if id.is_empty() || id.len() > 128 {
            return Err(AppError::new("request", "Invalid read request."));
        }
        let mut requests = self.requests.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(cancelled) = requests.get(id) {
            if cancelled.load(Ordering::Acquire) {
                return Ok(Request {
                    id: id.into(),
                    cancelled: cancelled.clone(),
                });
            }
            return Err(AppError::new("request", "Read request already exists."));
        }
        let cancelled = Arc::new(AtomicBool::new(false));
        requests.insert(id.into(), cancelled.clone());
        Ok(Request {
            id: id.into(),
            cancelled,
        })
    }
    pub fn finish(&self, request: &Request) {
        self.requests
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(&request.id);
    }
    pub fn cancel(&self, id: &str) {
        if id.is_empty() || id.len() > 128 {
            return;
        }
        let mut requests = self.requests.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(flag) = requests.get(id) {
            flag.store(true, Ordering::Release);
        } else {
            // A close can reach native code before the read has registered.
            if requests.len() >= 256 {
                requests.retain(|_, flag| !flag.load(Ordering::Acquire));
            }
            requests.insert(id.into(), Arc::new(AtomicBool::new(true)));
        }
    }
    pub fn notify_editor_mutation(&self, root: &Path, mutation: &EditorMutation) {
        if let EditorMutation::Save { path, .. } = mutation
            && let Some(entry) = self
                .entries
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .get(root)
        {
            let mut saved = entry.saved.lock().unwrap_or_else(|e| e.into_inner());
            if saved.len() > 4096 {
                saved.clear();
            }
            saved.insert(path.clone(), stamp(&root.join(path)));
        }
        let (paths, kinds, tree) = match mutation {
            EditorMutation::Save { path, .. } => (vec![path.clone()], vec!["changed"], false),
            EditorMutation::Create { path, .. } => (vec![path.clone()], vec!["created"], true),
            EditorMutation::Trash { path, .. } => (vec![path.clone()], vec!["deleted"], true),
            EditorMutation::Rename {
                path, destination, ..
            } => (
                vec![path.clone(), destination.clone()],
                vec!["deleted", "created"],
                true,
            ),
        };
        let changes = paths
            .iter()
            .zip(kinds)
            .map(|(path, kind)| RepositoryPathChange {
                path: path.clone(),
                kind: kind.into(),
            })
            .collect();
        self.invalidate_with(
            root,
            RepositoryReadChange {
                paths,
                changes: Some(changes),
                tree,
                git: false,
                full: false,
                ..events::full(root)
            },
        );
    }
    pub fn invalidate(&self, root: &Path) {
        self.invalidate_with(root, events::full(root));
    }
    fn invalidate_with(&self, root: &Path, change: RepositoryReadChange) {
        if let Some(entry) = self
            .entries
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(root)
        {
            entry
                .changes
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .uncertain |= change.full
                || change.git
                || change
                    .paths
                    .iter()
                    .any(|path| !crate::editor::metadata_path(path));
            (entry.publish)(change);
        }
    }
    pub fn entry(&self, storage: &Storage, root: &Path) -> AppResult<Arc<Entry>> {
        let mut entries = self.entries.lock().unwrap_or_else(|e| e.into_inner());
        // Only idle entries may be evicted. Source readers and agents have their
        // own Storage leases; release_context defers their final collection.
        let mut idle = entries
            .iter()
            .filter(|(_, e)| Arc::strong_count(e) == 1)
            .filter_map(|(p, e)| e.data.try_lock().ok().map(|d| (p.clone(), d.touched)))
            .collect::<Vec<_>>();
        idle.sort_by_key(|(_, time)| *time);
        let excess = idle.len().saturating_sub(3);
        let mut released = Vec::new();
        for (i, (path, time)) in idle.into_iter().enumerate() {
            if (time.elapsed() > Duration::from_secs(900) || (path != root && i < excess))
                && let Some(entry) = entries.remove(&path)
            {
                let mut data = entry.data.lock().unwrap_or_else(|e| e.into_inner());
                released.extend(data.context.take());
                released.append(&mut data.retired_contexts);
            }
        }
        let entry = if let Some(entry) = entries.get(root) {
            entry.clone()
        } else {
            let changes = Arc::new(Mutex::new(Changes {
                paths: BTreeSet::new(),
                uncertain: false,
            }));
            let generation = uuid::Uuid::new_v4().to_string();
            let sequence = Arc::new(AtomicU64::new(0));
            let ui = self
                .notifier
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .clone();
            let native = self
                .native_notifier
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .clone();
            let checkout = root.to_path_buf();
            let event_generation = generation.clone();
            let event_sequence = sequence.clone();
            let watch_epoch = Arc::new(AtomicU64::new(0));
            let event_epoch = watch_epoch.clone();
            let saved = Arc::new(Mutex::new(BTreeMap::<String, String>::new()));
            let saved_for_batch = saved.clone();
            let structural = Arc::new(Mutex::new(BTreeSet::<String>::new()));
            let structural_for_batch = structural.clone();
            let recent = Mutex::new(BTreeMap::<String, (String, Instant)>::new());
            let batched = events::batched(Arc::new(move |mut change| {
                let mut structural = structural_for_batch
                    .lock()
                    .unwrap_or_else(|e| e.into_inner());
                let changed_structure = change.paths.iter().any(|path| structural.contains(path));
                for path in &change.paths {
                    structural.remove(path);
                }
                if change.full {
                    structural.clear();
                }
                drop(structural);
                if change.tree
                    && !change.full
                    && !change.git
                    && !changed_structure
                    && !change.paths.is_empty()
                {
                    let saved = saved_for_batch.lock().unwrap_or_else(|e| e.into_inner());
                    if change.paths.iter().all(|path| {
                        !Path::new(path)
                            .file_name()
                            .is_some_and(|name| name == ".gitignore" || name == ".ignore")
                            && saved
                                .get(path)
                                .is_some_and(|revision| revision == &stamp(&checkout.join(path)))
                    }) {
                        change.tree = false;
                    }
                }
                if !change.full {
                    let mut recent = recent.lock().unwrap_or_else(|e| e.into_inner());
                    recent.retain(|_, (_, seen)| seen.elapsed() < Duration::from_secs(2));
                    if recent.len() > 4096 {
                        recent.clear();
                    }
                    let had_paths = !change.paths.is_empty();
                    change.paths.retain(|path| {
                        let revision = stamp(&checkout.join(path));
                        if recent
                            .get(path)
                            .is_some_and(|(previous, _)| previous == &revision)
                        {
                            return false;
                        }
                        recent.insert(path.clone(), (revision, Instant::now()));
                        true
                    });
                    if let Some(changes) = &mut change.changes {
                        changes.retain(|item| change.paths.contains(&item.path));
                    }
                    if had_paths && change.paths.is_empty() && !change.git {
                        return;
                    }
                }
                change.generation = Some(format!(
                    "{}:{}",
                    event_generation,
                    event_epoch.load(Ordering::Acquire)
                ));
                change.sequence = Some(event_sequence.fetch_add(1, Ordering::AcqRel) + 1);
                if let Some(notify) = &native {
                    let mut source_change = change.clone();
                    source_change
                        .paths
                        .retain(|path| !crate::editor::metadata_path(path));
                    if let Some(changes) = &mut source_change.changes {
                        changes.retain(|item| !crate::editor::metadata_path(&item.path));
                    }
                    if source_change.full || source_change.git || !source_change.paths.is_empty() {
                        notify(&checkout, &source_change);
                    }
                }
                if let Some(notify) = &ui {
                    notify(change);
                }
            }));
            let publish: Notifier = Arc::new(move |change| {
                let mut structural = structural.lock().unwrap_or_else(|e| e.into_inner());
                if structural.len() > 4096 {
                    structural.clear();
                }
                for item in change.changes.iter().flatten() {
                    if item.kind == "created" || item.kind == "deleted" {
                        structural.insert(item.path.clone());
                    }
                }
                drop(structural);
                batched(change);
            });
            let entry = Arc::new(Entry {
                data: Mutex::new(Data::default()),
                changes,
                watcher: Mutex::new(None),
                publish,
                generation,
                sequence,
                healthy: Arc::new(AtomicBool::new(false)),
                starting: AtomicBool::new(false),
                watch_epoch,
                root: root.into(),
                saved,
            });
            entries.insert(root.into(), entry.clone());
            entry
        };
        drop(entries);
        for context in released {
            storage
                .scoped(Some(&context.repository_id))
                .release_context(&context.id)?;
        }
        Ok(entry)
    }
}
fn ensure_watch(entry: &Arc<Entry>) {
    if !entry.healthy.load(Ordering::Acquire) && !entry.starting.swap(true, Ordering::AcqRel) {
        start_watch(entry, &entry.root);
    }
}
fn start_watch(entry: &Arc<Entry>, root: &Path) {
    // Registration must not block readers. A stopped/reacquired lease invalidates
    // any registration still in flight, so it cannot resurrect an abandoned watcher.
    let epoch = entry.watch_epoch.fetch_add(1, Ordering::AcqRel) + 1;
    let target = Arc::downgrade(entry);
    let checkout = root.to_path_buf();
    let flags = entry.changes.clone();
    let publish = entry.publish.clone();
    let healthy = entry.healthy.clone();
    let fallback = Arc::downgrade(entry);
    if std::thread::Builder::new()
        .name("repository-watch".into())
        .spawn(move || {
            let watcher = watch(&checkout, flags, Some(publish), healthy.clone());
            if let Some(entry) = target.upgrade() {
                let mut slot = entry.watcher.lock().unwrap_or_else(|e| e.into_inner());
                if entry.watch_epoch.load(Ordering::Acquire) == epoch {
                    healthy.store(watcher.is_some(), Ordering::Release);
                    *slot = watcher;
                    entry.starting.store(false, Ordering::Release);
                }
            }
        })
        .is_err()
        && let Some(entry) = fallback.upgrade()
        && entry.watch_epoch.load(Ordering::Acquire) == epoch
    {
        entry.starting.store(false, Ordering::Release);
    }
}

fn watch(
    root: &Path,
    changes: Arc<Mutex<Changes>>,
    notify: Option<Notifier>,
    healthy: Arc<AtomicBool>,
) -> Option<notify::RecommendedWatcher> {
    let flags = changes;
    let checkout = root.to_path_buf();
    let mut watcher = notify::recommended_watcher(move |event: notify::Result<notify::Event>| {
        if event.is_err() {
            healthy.store(false, Ordering::Release);
        }
        let Some(change) = events::classify(&checkout, event) else {
            return;
        };
        {
            let mut flags = flags.lock().unwrap_or_else(|e| e.into_inner());
            flags.uncertain |= change.full;
            for path in &change.paths {
                if crate::editor::metadata_path(path) {
                    continue;
                }
                if flags.paths.len() < 10000 {
                    flags.paths.insert(checkout.join(path));
                } else {
                    flags.uncertain = true;
                }
            }
        }
        if let Some(notify) = &notify {
            notify(change);
        }
    })
    .ok();
    let mut watch_failed = false;
    if let Some(watcher) = watcher.as_mut() {
        if watcher
            .watch(root, notify::RecursiveMode::Recursive)
            .is_err()
        {
            watch_failed = true;
        }
        // Linked worktrees keep their index/HEAD outside the checkout.
        for arg in ["--absolute-git-dir", "--git-common-dir"] {
            if let Ok(path) = repositories::text(root, &["rev-parse", arg]) {
                let path = root.join(path.trim());
                if !path.starts_with(root) {
                    watch_failed |= watcher
                        .watch(&path, notify::RecursiveMode::Recursive)
                        .is_err();
                }
            }
        }
    }
    if watch_failed {
        watcher = None;
    }

    watcher
}

impl Entry {
    fn stop_watch(&self) {
        let stopped = {
            let mut watcher = self.watcher.lock().unwrap_or_else(|e| e.into_inner());
            self.watch_epoch.fetch_add(1, Ordering::AcqRel);
            self.healthy.store(false, Ordering::Release);
            self.starting.store(false, Ordering::Release);
            watcher.take()
        };
        self.changes
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .uncertain = true;
        drop(stopped);
    }
    fn status(&self) -> EditorWatchStatus {
        EditorWatchStatus {
            healthy: self.healthy.load(Ordering::Acquire),
            generation: format!(
                "{}:{}",
                self.generation,
                self.watch_epoch.load(Ordering::Acquire)
            ),
            sequence: self.sequence.load(Ordering::Acquire),
        }
    }
    /// Every request does a cheap inventory/stat pass as a fallback for missed
    /// notifications. No file contents or blob objects are read here.
    pub fn refresh(&self, root: &Path, data: &mut Data) -> AppResult<bool> {
        let (paths, uncertain) = {
            let mut changes = self.changes.lock().unwrap_or_else(|e| e.into_inner());
            (
                std::mem::take(&mut changes.paths),
                std::mem::take(&mut changes.uncertain)
                    || self
                        .watcher
                        .lock()
                        .unwrap_or_else(|e| e.into_inner())
                        .is_none(),
            )
        };
        let source_event = paths.iter().any(|changed| {
            data.sources
                .working
                .keys()
                .any(|path| path.starts_with(changed))
        });
        if uncertain {
            data.sources.working.clear();
        } else {
            data.sources
                .working
                .retain(|path, _| !paths.iter().any(|changed| path.starts_with(changed)));
        }
        let fingerprint = inventory_fingerprint(root)?;
        let changed = uncertain || source_event || fingerprint != data.fingerprint;
        if changed {
            data.previews.clear();
            data.statistics.clear();
            data.context_fingerprint.clear();
            data.fingerprint = fingerprint;
        }
        data.touched = Instant::now();
        Ok(changed)
    }
}
pub(crate) fn stamp(path: &Path) -> String {
    match fs::symlink_metadata(path) {
        Ok(m) => {
            #[cfg(unix)]
            {
                use std::os::unix::fs::MetadataExt;
                format!(
                    "{}:{}:{}:{}:{}:{}:{}",
                    m.dev(),
                    m.ino(),
                    m.size(),
                    m.mtime(),
                    m.mtime_nsec(),
                    m.ctime_nsec(),
                    m.ctime()
                )
            }
            #[cfg(not(unix))]
            {
                format!("{}:{:?}:{:?}", m.len(), m.modified(), m.file_type())
            }
        }
        Err(e) => format!("{:?}", e.kind()),
    }
}
pub(crate) fn inventory_fingerprint(root: &Path) -> AppResult<String> {
    let records = repositories::git(
        root,
        &[
            "ls-files",
            "--cached",
            "--others",
            "--exclude-standard",
            "-z",
        ],
    )?;
    let mut bytes = Vec::new();
    for record in records.split(|b| *b == 0).filter(|b| !b.is_empty()) {
        let name = record;
        let name = std::str::from_utf8(name).map_err(|_| {
            AppError::new("unsupported_path", "A repository filename is not UTF-8.")
        })?;
        if crate::snapshots::is_metadata(name) {
            continue;
        }
        bytes.extend_from_slice(record);
        bytes.push(0);
        bytes.extend_from_slice(stamp(&root.join(name)).as_bytes());
    }
    bytes.extend(repositories::git(root, &["ls-files", "--stage", "-z"])?);
    bytes.extend(repositories::git(root, &["rev-parse", "--verify", "HEAD"]).unwrap_or_default());
    bytes.extend(repositories::git(
        root,
        &["for-each-ref", "--format=%(refname) %(objectname)"],
    )?);
    Ok(fingerprint(&bytes))
}

pub(crate) struct Mutation {
    cache: Arc<RepositoryCache>,
    root: PathBuf,
    git_only: bool,
}
impl RepositoryCache {
    pub fn mutation(self: &Arc<Self>, root: &Path) -> Mutation {
        self.invalidate(root);
        Mutation {
            cache: self.clone(),
            root: root.into(),
            git_only: false,
        }
    }
    pub fn git_mutation(self: &Arc<Self>, root: &Path) -> Mutation {
        let change = RepositoryReadChange {
            full: false,
            tree: false,
            ..events::full(root)
        };
        self.invalidate_with(root, change);
        Mutation {
            cache: self.clone(),
            root: root.into(),
            git_only: true,
        }
    }
}
impl Drop for Mutation {
    fn drop(&mut self) {
        if self.git_only {
            self.cache.invalidate_with(
                &self.root,
                RepositoryReadChange {
                    full: false,
                    tree: false,
                    ..events::full(&self.root)
                },
            );
        } else {
            self.cache.invalidate(&self.root);
        }
    }
}

impl RepositoryCache {
    pub fn shutdown(&self, storage: &Storage) {
        self.leases
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clear();
        for flag in self
            .requests
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .values()
        {
            flag.store(true, Ordering::Release);
        }
        let entries = std::mem::take(&mut *self.entries.lock().unwrap_or_else(|e| e.into_inner()));
        for entry in entries.values() {
            entry.stop_watch();
            if let Ok(mut data) = entry.data.try_lock() {
                let mut contexts = std::mem::take(&mut data.retired_contexts);
                contexts.extend(data.context.take());
                for context in contexts {
                    let _ = storage
                        .scoped(Some(&context.repository_id))
                        .release_context(&context.id);
                }
            }
        }
    }
}

#[cfg(test)]
#[path = "repository_cache_tests.rs"]
mod tests;
