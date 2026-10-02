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
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration, Instant},
};

type Notifier = Arc<dyn Fn(String) + Send + Sync>;

#[derive(Default)]
pub(crate) struct RepositoryCache {
    notifier: Mutex<Option<Notifier>>,
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
    pub fn set_notifier(&self, notify: impl Fn(String) + Send + Sync + 'static) {
        *self.notifier.lock().unwrap_or_else(|e| e.into_inner()) = Some(Arc::new(notify));
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
    pub fn invalidate(&self, root: &Path) {
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
                .uncertain = true;
            if let Some(notify) = self
                .notifier
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .as_ref()
            {
                notify(fingerprint(root.to_string_lossy().as_bytes()));
            }
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
            let entry = Arc::new(Entry {
                data: Mutex::new(Data::default()),
                changes: changes.clone(),
                watcher: Mutex::new(None),
            });
            // FSEvents registration can take hundreds of milliseconds. It must
            // not hold up the first inventory. The metadata fallback remains
            // conservative until the watcher is ready; a dropped entry cancels
            // publication and the initializer then drops its local watcher.
            let target = Arc::downgrade(&entry);
            let checkout = root.to_path_buf();
            let notify = self
                .notifier
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .clone();
            let _ = std::thread::Builder::new()
                .name("repository-watch".into())
                .spawn(move || {
                    let watcher = watch(&checkout, changes, notify);
                    if let Some(entry) = target.upgrade() {
                        *entry.watcher.lock().unwrap_or_else(|e| e.into_inner()) = watcher;
                    }
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
fn watch(
    root: &Path,
    changes: Arc<Mutex<Changes>>,
    notify: Option<Notifier>,
) -> Option<notify::RecommendedWatcher> {
    let flags = changes;
    let checkout = root.to_path_buf();
    let repository_id = fingerprint(root.to_string_lossy().as_bytes());
    let mut watcher = notify::recommended_watcher(move |event: notify::Result<notify::Event>| {
        let mut flags = flags.lock().unwrap_or_else(|e| e.into_inner());
        let mut changed = false;
        match event {
            Ok(event) if !event.kind.is_access() => {
                if event.need_rescan() {
                    flags.uncertain = true;
                }
                for path in event.paths {
                    if path
                        .strip_prefix(&checkout)
                        .is_ok_and(|p| p.starts_with(".reviewbox"))
                    {
                        continue;
                    }
                    // Lock files are transient, and are not source revisions.
                    if path.extension().is_some_and(|e| e == "lock")
                        && path.components().any(|c| c.as_os_str() == ".git")
                    {
                        continue;
                    }
                    changed = true;
                    if flags.paths.len() < 10000 {
                        flags.paths.insert(path);
                    } else {
                        flags.uncertain = true;
                    }
                }
            }
            Err(_) => {
                flags.uncertain = true;
                changed = true;
            }
            _ => {}
        }
        if changed && let Some(notify) = &notify {
            notify(repository_id.clone());
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
}
impl RepositoryCache {
    pub fn mutation(self: &Arc<Self>, root: &Path) -> Mutation {
        self.invalidate(root);
        Mutation {
            cache: self.clone(),
            root: root.into(),
        }
    }
}
impl Drop for Mutation {
    fn drop(&mut self) {
        self.cache.invalidate(&self.root);
    }
}

impl RepositoryCache {
    pub fn shutdown(&self, storage: &Storage) {
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
