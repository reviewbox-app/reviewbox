use crate::{contracts::*, storage::Storage};
use std::{
    collections::BTreeMap,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering},
    },
};
use tokio::sync::{Mutex as AsyncMutex, Notify};

pub(crate) mod catalog;
pub(crate) mod install;
pub(crate) mod live;
pub(crate) mod packs;
pub(crate) mod project;
mod registrations;
pub(crate) mod runtime_builds;
mod session;
pub(crate) mod setup;
#[cfg(test)]
mod tests;
mod workspace;

pub fn settings(storage: &Storage) -> AppResult<LanguageServerSettings> {
    match storage.get("language_servers", "settings") {
        Ok(s) => Ok(s),
        Err(e) if e.code == "not_found" => Ok(LanguageServerSettings {
            revision: 0,
            servers: vec![
                LanguageServerConfig {
                    id: "typescript".into(),
                    name: "TypeScript / JavaScript".into(),
                    extensions: vec!["ts".into(), "tsx".into(), "js".into(), "jsx".into()],
                    executable: "typescript-language-server".into(),
                    arguments: vec!["--stdio".into()],
                },
                LanguageServerConfig {
                    id: "rust".into(),
                    name: "Rust".into(),
                    extensions: vec!["rs".into()],
                    executable: "rust-analyzer".into(),
                    arguments: vec![],
                },
            ],
        }),
        Err(e) => Err(e),
    }
}
pub fn configure(
    storage: &Storage,
    mut settings: LanguageServerSettings,
) -> AppResult<LanguageServerSettings> {
    let mut ids = std::collections::HashSet::new();
    for server in &settings.servers {
        if server.executable.trim().is_empty()
            || server.extensions.is_empty()
            || !ids.insert(&server.id)
        {
            return Err(AppError::new(
                "invalid_server",
                "Each language server needs an executable, file extensions and a unique ID.",
            ));
        }
    }
    let exists = storage
        .get::<LanguageServerSettings>("language_servers", "settings")
        .is_ok();
    let revision = settings.revision;
    settings.revision = if exists { revision + 1 } else { 0 };
    if exists {
        storage.replace("language_servers", "settings", revision, &settings)?;
    } else {
        storage.insert("language_servers", "settings", &settings)?;
    }
    Ok(settings)
}

// A few active languages and both sides of a diff can coexist without keeping
// an unbounded collection of compiler processes or full snapshot copies alive.
const MAX_SESSIONS: usize = 6;
const MAX_REQUESTS: usize = 64;

#[derive(Default)]
struct Entry {
    server_id: String,
    snapshot_id: String,
    initialize: AsyncMutex<()>,
    session: Mutex<Option<Arc<session::Session>>>,
    active: AtomicUsize,
    last_used: AtomicU64,
    stopped: AtomicBool,
}
impl Entry {
    fn stop(&self) {
        self.stopped.store(true, Ordering::Release);
        if let Some(session) = self
            .session
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .take()
        {
            session.stop();
        }
    }
}
impl Drop for Entry {
    fn drop(&mut self) {
        self.stop();
    }
}

#[derive(Default)]
struct Sessions {
    entries: Mutex<BTreeMap<String, Arc<Entry>>>,
    requests: Mutex<BTreeMap<String, Arc<Cancellation>>>,
    clock: AtomicU64,
    stopped: AtomicBool,
    observed_capabilities: Mutex<BTreeMap<String, LanguageCapabilities>>,
    notifier: Mutex<Option<Arc<dyn Fn() + Send + Sync>>>,
}
/// Native owner shared by all editor surfaces. No request points at the live checkout.
#[derive(Clone, Default)]
pub struct LanguageServers(Arc<Sessions>);

#[derive(Default)]
struct Cancellation {
    stopped: AtomicBool,
    notify: Notify,
}
impl Cancellation {
    fn stop(&self) {
        self.stopped.store(true, Ordering::Release);
        self.notify.notify_waiters();
    }
    async fn during<T>(
        &self,
        operation: impl std::future::Future<Output = AppResult<T>>,
    ) -> AppResult<T> {
        use std::{future::Future, pin::pin, task::Poll};
        let mut operation = pin!(operation);
        let mut notification = pin!(self.notify.notified());
        std::future::poll_fn(|context| {
            if self.stopped.load(Ordering::Acquire)
                || notification.as_mut().poll(context).is_ready()
            {
                return Poll::Ready(Err(AppError::new(
                    "cancelled",
                    "The language request was cancelled.",
                )));
            }
            operation.as_mut().poll(context)
        })
        .await
    }
}

struct InitializationLease {
    entry: Arc<Entry>,
    ready: bool,
}
impl Drop for InitializationLease {
    fn drop(&mut self) {
        if !self.ready {
            self.entry.stop();
        }
    }
}

struct RequestLease {
    owner: Arc<Sessions>,
    request_id: String,
}
impl Drop for RequestLease {
    fn drop(&mut self) {
        self.owner
            .requests
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .remove(&self.request_id);
    }
}
struct EntryLease(Arc<Entry>);
impl Drop for EntryLease {
    fn drop(&mut self) {
        self.0.active.fetch_sub(1, Ordering::Release);
    }
}

impl LanguageServers {
    pub fn set_notifier(&self, notify: impl Fn() + Send + Sync + 'static) {
        *self
            .0
            .notifier
            .lock()
            .unwrap_or_else(|error| error.into_inner()) = Some(Arc::new(notify));
    }
    pub fn cancel(&self, request_id: &str) {
        if let Some(request) = self
            .0
            .requests
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .get(request_id)
        {
            request.stop();
        }
        for entry in self
            .0
            .entries
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .values()
        {
            if let Some(session) = entry
                .session
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .as_ref()
            {
                session.cancel(request_id);
            }
        }
    }
    pub fn stop_server(&self, server_id: &str) {
        self.remove_where(|entry| entry.server_id == server_id);
        self.0
            .observed_capabilities
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .remove(server_id);
    }
    pub fn capabilities(&self, server_id: &str) -> Option<LanguageCapabilities> {
        for entry in self
            .0
            .entries
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .values()
            .filter(|entry| entry.server_id == server_id)
        {
            if let Some(session) = entry
                .session
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .as_ref()
                && let Some(value) = session.observed_capabilities()
            {
                return Some(value);
            }
        }
        self.0
            .observed_capabilities
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .get(server_id)
            .cloned()
    }
    pub fn release_snapshot(&self, snapshot_id: &str) {
        self.remove_where(|entry| entry.snapshot_id == snapshot_id);
    }
    fn remove_where(&self, predicate: impl Fn(&Entry) -> bool) {
        let mut entries = self
            .0
            .entries
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        entries.retain(|_, entry| {
            if predicate(entry) {
                entry.stop();
                false
            } else {
                true
            }
        });
    }
    pub fn stop_all(&self) {
        self.0.stopped.store(true, Ordering::Release);
        for request in self
            .0
            .requests
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .values()
        {
            request.stop();
        }
        self.remove_where(|_| true);
    }
    fn entry(&self, key: String, server_id: String, snapshot_id: String) -> AppResult<EntryLease> {
        let mut entries = self
            .0
            .entries
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        if self.0.stopped.load(Ordering::Acquire) {
            return Err(AppError::new(
                "language_session_closed",
                "Language services are shutting down.",
            ));
        }
        entries.retain(|_, entry| !entry.stopped.load(Ordering::Acquire));
        if !entries.contains_key(&key) && entries.len() >= MAX_SESSIONS {
            let oldest = entries
                .iter()
                .filter(|(_, entry)| entry.active.load(Ordering::Acquire) == 0)
                .min_by_key(|(_, entry)| entry.last_used.load(Ordering::Relaxed))
                .map(|(key, _)| key.clone());
            if let Some(oldest) = oldest {
                if let Some(entry) = entries.remove(&oldest) {
                    entry.stop();
                }
            } else {
                return Err(AppError::new(
                    "language_services_busy",
                    "All language sessions are currently in use. Retry when a request finishes.",
                ));
            }
        }
        let entry = entries
            .entry(key)
            .or_insert_with(|| {
                Arc::new(Entry {
                    server_id,
                    snapshot_id,
                    initialize: AsyncMutex::new(()),
                    session: Mutex::new(None),
                    active: AtomicUsize::new(0),
                    last_used: AtomicU64::new(0),
                    stopped: AtomicBool::new(false),
                })
            })
            .clone();
        entry.active.fetch_add(1, Ordering::Acquire);
        entry.last_used.store(
            self.0.clock.fetch_add(1, Ordering::Relaxed),
            Ordering::Relaxed,
        );
        Ok(EntryLease(entry))
    }
    pub async fn request(
        &self,
        storage: Storage,
        request: LanguageRequest,
    ) -> AppResult<LanguageResponse> {
        if request.request_id.is_empty() || request.request_id.len() > 128 {
            return Err(AppError::new(
                "invalid_request",
                "Language requests need a bounded unique ID.",
            ));
        }
        let cancelled = Arc::new(Cancellation::default());
        {
            let mut requests = self
                .0
                .requests
                .lock()
                .unwrap_or_else(|error| error.into_inner());
            if requests.contains_key(&request.request_id) {
                return Err(AppError::new(
                    "duplicate_request",
                    "This language request is already in progress.",
                ));
            }
            if requests.len() >= MAX_REQUESTS {
                return Err(AppError::new(
                    "language_services_busy",
                    "Too many language requests are in progress.",
                ));
            }
            requests.insert(request.request_id.clone(), cancelled.clone());
        }
        let _request_lease = RequestLease {
            owner: self.0.clone(),
            request_id: request.request_id.clone(),
        };
        cancelled
            .during(self.perform(storage, request, &cancelled.stopped))
            .await
    }
    async fn perform(
        &self,
        storage: Storage,
        request: LanguageRequest,
        cancelled: &AtomicBool,
    ) -> AppResult<LanguageResponse> {
        let _snapshot = storage.pin_snapshot(&request.document.snapshot_id);
        let source_storage = storage.clone();
        let document = request.document.clone();
        let (tree, server, environment) = tauri::async_runtime::spawn_blocking(move || {
            let snapshot: Snapshot = source_storage.get("snapshot", &document.snapshot_id)?;
            let tree = workspace::source_tree(&snapshot, &document)?;
            let server = catalog::resolve(&source_storage, &document.path)?;
            let environment = catalog::launch_environment(&source_storage, &server)?;
            Ok::<_, AppError>((tree, server, environment))
        })
        .await
        .map_err(|_| AppError::new("task", "Cannot resolve captured language sources."))??;
        if cancelled.load(Ordering::Acquire) {
            return Err(AppError::new(
                "cancelled",
                "The language request was cancelled.",
            ));
        }
        let key = format!(
            "{}:{}",
            tree.key,
            fingerprint(&serde_json::to_vec(&(&server, &environment))?)
        );
        let lease = self.entry(key, server.id.clone(), tree.snapshot_id.clone())?;
        let entry = &lease.0;
        let session = {
            let _initializing = entry.initialize.lock().await;
            if cancelled.load(Ordering::Acquire) || entry.stopped.load(Ordering::Acquire) {
                return Err(AppError::new(
                    "cancelled",
                    "The language request was cancelled.",
                ));
            }
            let existing = entry
                .session
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .clone();
            if let Some(session) = existing.filter(|session| !session.is_stopped()) {
                session
            } else {
                let workspace = tauri::async_runtime::spawn_blocking(move || {
                    workspace::Workspace::create(&storage, tree)
                })
                .await
                .map_err(|_| {
                    AppError::new("task", "Cannot prepare captured language sources.")
                })??;
                if cancelled.load(Ordering::Acquire) || entry.stopped.load(Ordering::Acquire) {
                    return Err(AppError::new(
                        "cancelled",
                        "The language request was cancelled.",
                    ));
                }
                let session = session::Session::spawn(server, workspace, environment)?;
                let mut initialization = InitializationLease {
                    entry: entry.clone(),
                    ready: false,
                };
                {
                    let mut target = entry
                        .session
                        .lock()
                        .unwrap_or_else(|error| error.into_inner());
                    if entry.stopped.load(Ordering::Acquire) {
                        session.stop();
                        return Err(AppError::new(
                            "cancelled",
                            "The language session was closed.",
                        ));
                    }
                    *target = Some(session.clone());
                }
                if let Err(error) = session.initialize().await {
                    entry.stop();
                    return Err(error);
                }
                initialization.ready = true;
                session.set_notifier(
                    self.0
                        .notifier
                        .lock()
                        .unwrap_or_else(|error| error.into_inner())
                        .clone(),
                );
                session
            }
        };
        if entry.stopped.load(Ordering::Acquire) || cancelled.load(Ordering::Acquire) {
            return Err(AppError::new(
                "cancelled",
                "The language request was cancelled.",
            ));
        }
        if let Some(capabilities) = session.observed_capabilities() {
            self.0
                .observed_capabilities
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .insert(session.server.id.clone(), capabilities);
        }
        session.request(&request, cancelled).await
    }
}

pub fn read_source(storage: &Storage, document: &LanguageDocument) -> AppResult<String> {
    let _snapshot = storage.pin_snapshot(&document.snapshot_id);
    let snapshot: Snapshot = storage.get("snapshot", &document.snapshot_id)?;
    let tree = workspace::source_tree(&snapshot, document)?;
    let blob = &tree.files[&document.path];
    let bytes = storage.read_blob(&blob.hash)?;
    if bytes.len() != blob.size as usize || fingerprint(&bytes) != blob.hash {
        return Err(AppError::new(
            "corrupt_content",
            "Captured source failed its integrity check.",
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
            "This captured file is binary.",
        ));
    }
    Ok(text)
}

pub async fn definition(
    manager: &LanguageServers,
    storage: Storage,
    snapshot_id: String,
    path: String,
    line: u32,
    column: u32,
) -> AppResult<Vec<CodeLocation>> {
    let _snapshot = storage.pin_snapshot(&snapshot_id);
    let snapshot: Snapshot = storage.get("snapshot", &snapshot_id)?;
    let file = snapshot
        .files
        .iter()
        .find(|file| file.path == path)
        .ok_or_else(|| AppError::new("invalid_location", "Choose a captured file."))?;
    let request = LanguageRequest {
        request_id: uuid::Uuid::new_v4().to_string(),
        document: LanguageDocument {
            snapshot_id,
            path,
            change_id: None,
            side: None,
            content_hash: file.content.hash.clone(),
        },
        method: LanguageMethod::Definitions,
        line: Some(line),
        column: Some(column),
    };
    Ok(manager
        .request(storage, request)
        .await?
        .locations
        .into_iter()
        .map(|location| CodeLocation {
            path: location.document.path,
            line: location.range.start_line,
            column: location.range.start_column,
        })
        .collect())
}
