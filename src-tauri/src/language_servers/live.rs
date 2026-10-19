//! Live documents use the existing transport but never enter captured-source APIs.
use super::{catalog, session::Session, workspace::Workspace};
use crate::{contracts::*, storage::Storage};
use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    sync::{Arc, Mutex},
};
use tauri::{Emitter, Manager, State};
use tokio::sync::Mutex as AsyncMutex;

struct Entry {
    inspection: bool,
    id: String,
    root: std::path::PathBuf,
    session: Arc<Session>,
    documents: AsyncMutex<BTreeMap<String, LiveLanguageDocument>>,
    storage: Option<Storage>,
    source_path: String,
    context: LiveLanguageProjectContext,
    configuration_paths: Vec<String>,
    scope: std::path::PathBuf,
}
impl Drop for Entry {
    fn drop(&mut self) {
        self.session.stop();
        if let Some(storage) = &self.storage {
            storage.repository_cache.release_lease(&self.root, &self.id);
        }
    }
}
#[derive(Default, Clone)]
pub struct LiveLanguages(
    Arc<Mutex<BTreeMap<String, Arc<Entry>>>>,
    Arc<AsyncMutex<()>>,
);
impl LiveLanguages {
    fn peers(&self, root: &std::path::Path, except: &str) -> Vec<Arc<Entry>> {
        self.0
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .values()
            .filter(|e| {
                !e.inspection
                    && e.root == root
                    && e.id != except
                    && !e.session.is_stopped()
                    && matches!(e.session.server.id.as_str(), "typescript" | "vue")
            })
            .cloned()
            .collect()
    }
    async fn mirror(&self, entry: &Entry, document: &LiveLanguageDocument) {
        if entry.inspection || !matches!(entry.session.server.id.as_str(), "typescript" | "vue") {
            return;
        }
        let Ok(uri) = uri(entry, &document.path) else {
            return;
        };
        for peer in self.peers(&entry.root, &entry.id) {
            if !peer.documents.lock().await.contains_key(&document.path) {
                let _ = peer.session.mirror_document(&uri, document).await;
            }
        }
    }
    async fn hydrate(&self, session: &Arc<Session>, root: &std::path::Path, id: &str) {
        if !session.accepts_vue_mirrors() {
            return;
        }
        for peer in self.peers(root, id) {
            let documents = peer
                .documents
                .lock()
                .await
                .values()
                .cloned()
                .collect::<Vec<_>>();
            for document in documents {
                if let Ok(uri) = uri(&peer, &document.path) {
                    let _ = session.mirror_document(&uri, &document).await;
                }
            }
        }
    }
    pub fn invalidate_project(
        &self,
        root: &std::path::Path,
        server_id: &str,
        scope: Option<&std::path::Path>,
    ) {
        let entries = self
            .0
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .values()
            .filter(|e| {
                e.root == root
                    && e.session.server.id == server_id
                    && scope.is_none_or(|scope| e.scope == scope)
            })
            .cloned()
            .collect::<Vec<_>>();
        for entry in entries {
            entry.session.stop();
            entry.session.notify("reviewbox/reconfigure", json!({}));
        }
    }
    pub fn invalidate_server(&self, server_id: &str) {
        let entries = self
            .0
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .values()
            .filter(|e| e.session.server.id == server_id)
            .cloned()
            .collect::<Vec<_>>();
        for entry in entries {
            entry.session.stop();
            entry.session.notify("reviewbox/reconfigure", json!({}));
        }
    }
    pub fn capabilities(&self, server_id: &str) -> Option<Value> {
        self.0
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .values()
            .find(|e| e.session.server.id == server_id && !e.session.is_stopped())
            .map(|e| e.session.capability_data())
    }
    pub fn stop_server(&self, server_id: &str) {
        let mut entries = self.0.lock().unwrap_or_else(|e| e.into_inner());
        entries.retain(|_, entry| {
            if entry.session.server.id == server_id {
                entry.session.stop();
                false
            } else {
                true
            }
        });
    }
    pub fn stop_all(&self) {
        for entry in
            std::mem::take(&mut *self.0.lock().unwrap_or_else(|e| e.into_inner())).into_values()
        {
            entry.session.stop();
        }
    }
    fn entry(&self, id: &str) -> AppResult<Arc<Entry>> {
        self.0
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .values()
            .find(|entry| entry.id == id)
            .cloned()
            .filter(|e| !e.session.is_stopped())
            .ok_or_else(|| {
                AppError::new(
                    "language_session_closed",
                    "Restart language support to reconnect.",
                )
            })
    }
}
impl Session {
    pub(super) async fn initialize_live(&self) -> AppResult<()> {
        let root = url::Url::from_directory_path(self.workspace.root())
            .map_err(|_| AppError::new("invalid_path", "Invalid project root."))?;
        let options = self
            .live_initialization_options
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone();
        let result = self.rpc("initialize", "initialize", json!({
            "processId":std::process::id(), "rootUri":root, "workspaceFolders":[{"uri":root,"name":"Code Editor"}],
            "initializationOptions": options,
            "capabilities": {
                "general":{"positionEncodings":["utf-16"]}, "window":{"workDoneProgress":true},
                "workspace":{"configuration":true,"workspaceFolders":true,"applyEdit":false,"workspaceEdit":{"documentChanges":true},"fileOperations":{"dynamicRegistration":true,"didCreate":true,"didRename":true,"didDelete":true},"didChangeWatchedFiles":{"dynamicRegistration":true,"relativePatternSupport":true},"didChangeConfiguration":{"dynamicRegistration":true},"symbol":{"dynamicRegistration":true},"diagnostics":{"refreshSupport":true},"semanticTokens":{"refreshSupport":true}},
                "textDocument":{
                    "synchronization":{"didSave":true},"completion":{"dynamicRegistration":true,"completionItem":{"snippetSupport":true,"labelDetailsSupport":true,"insertReplaceSupport":true,"documentationFormat":["markdown","plaintext"],"resolveSupport":{"properties":["documentation","detail","additionalTextEdits"]}}},
                    "hover":{"dynamicRegistration":true,"contentFormat":["markdown","plaintext"]},"signatureHelp":{"dynamicRegistration":true,"signatureInformation":{"documentationFormat":["markdown","plaintext"],"parameterInformation":{"labelOffsetSupport":true}}},
                    "definition":{"dynamicRegistration":true,"linkSupport":true},"references":{"dynamicRegistration":true},"documentSymbol":{"dynamicRegistration":true,"hierarchicalDocumentSymbolSupport":true},"rename":{"dynamicRegistration":true,"prepareSupport":true},
                    "formatting":{"dynamicRegistration":true},"rangeFormatting":{"dynamicRegistration":true},"linkedEditingRange":{"dynamicRegistration":true},"colorProvider":{"dynamicRegistration":true},"codeAction":{"dynamicRegistration":true,"codeActionLiteralSupport":{"codeActionKind":{"valueSet":["quickfix","refactor","source.organizeImports"]}},"resolveSupport":{"properties":["edit"]}},
                    "publishDiagnostics":{"versionSupport":true,"relatedInformation":true},"diagnostic":{"dynamicRegistration":true},
                    "semanticTokens":{"dynamicRegistration":true,"requests":{"full":true},"tokenTypes":["namespace","type","class","enum","interface","struct","typeParameter","parameter","variable","property","enumMember","event","function","method","macro","keyword","modifier","comment","string","number","regexp","operator","decorator"],"tokenModifiers":["declaration","definition","readonly","static","deprecated","abstract","async","modification","documentation","defaultLibrary"],"formats":["relative"]}
                }
            }
        }), None).await?;
        if result["capabilities"]["positionEncoding"]
            .as_str()
            .is_some_and(|s| s != "utf-16")
        {
            return Err(AppError::new(
                "lsp_protocol",
                "The server must support UTF-16 positions.",
            ));
        }
        self.set_capabilities(result["capabilities"].clone());
        self.send(&json!({"jsonrpc":"2.0","method":"initialized","params":{}}))
            .await?;
        let settings = self
            .live_settings
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone();
        self.send(&json!({"jsonrpc":"2.0","method":"workspace/didChangeConfiguration","params":{"settings":settings}})).await
    }
}

#[tauri::command]
// Tauri injects three runtime handles; keep the existing named IPC arguments stable.
#[allow(clippy::too_many_arguments)]
pub async fn live_language_open(
    app: tauri::AppHandle,
    storage: State<'_, Storage>,
    manager: State<'_, LiveLanguages>,
    repository_id: String,
    path: String,
    language_id: Option<String>,
    server_id: Option<String>,
    inspection_id: Option<String>,
) -> AppResult<LiveLanguageSession> {
    if inspection_id
        .as_ref()
        .is_some_and(|id| uuid::Uuid::parse_str(id).is_err())
    {
        return Err(AppError::new(
            "invalid_request",
            "Invalid inspection identity.",
        ));
    }
    let installer = app
        .state::<super::install::LanguageServerInstaller>()
        .inner()
        .clone();
    let root = crate::repositories::root(&storage, &repository_id)?;
    crate::editor::path(&root, &path)?;
    let mut server = catalog::resolve_language(
        &storage,
        &path,
        language_id.as_deref(),
        server_id.as_deref(),
    )?;
    // A TypeScript entry point can import SFCs before the first Vue tab is opened.
    if server.id == "typescript"
        && super::project::uses_vue(&root, &path)
        && crate::editor_extensions::enabled(&storage, EditorExtensionId::Vue)?
        && let Ok(Some(operation)) =
            crate::editor_extensions::ensure_engine(&storage, &installer, "vue")
    {
        loop {
            if !crate::editor_extensions::enabled(&storage, EditorExtensionId::Vue)? {
                break;
            }
            let current = installer
                .operations()
                .into_iter()
                .find(|o| o.id == operation.id);
            if current.is_none_or(|o| !matches!(o.status.as_str(), "queued" | "installing")) {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(200)).await;
        }
    }
    let _gate = manager.1.lock().await;
    let project = super::project::resolve(&storage, &root, &path, &server.id)?;
    if server.id == "vue"
        && let Some(sdk) = project.initialization_options["typescript"]["tsdk"].as_str()
    {
        server.arguments.push(format!("--tsdk={sdk}"));
    }
    let key = fingerprint(
        format!(
            "{repository_id}/{}/{}/{}/{}",
            server.id,
            project.root.display(),
            project.context.signature,
            inspection_id.as_deref().unwrap_or("editor")
        )
        .as_bytes(),
    );
    let old = manager
        .0
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get(&key)
        .cloned();
    let (session, session_id) = if let Some(old) = old.filter(|entry| !entry.session.is_stopped()) {
        (old.session.clone(), old.id.clone())
    } else {
        let id = uuid::Uuid::new_v4().to_string();
        let mut environment = catalog::launch_environment(&storage, &server)?;
        environment.extend(project.context.environment.clone());
        let session = Session::spawn(
            server.clone(),
            Workspace::live(project.root.clone()),
            environment,
        )?;
        *session
            .live_settings
            .lock()
            .unwrap_or_else(|e| e.into_inner()) = project.settings.clone();
        *session
            .live_initialization_options
            .lock()
            .unwrap_or_else(|e| e.into_inner()) = project.initialization_options.clone();
        *session
            .live_watch_patterns
            .lock()
            .unwrap_or_else(|e| e.into_inner()) = project.watched_files.clone();
        let event_key = id.clone();
        let event_storage = storage.inner().clone();
        let event_root = root.clone();
        let capability_app = app.clone();
        let capability_key = id.clone();
        let weak = Arc::downgrade(&session);
        session.set_notifier(Some(Arc::new(move || {
            if let Some(session) = weak.upgrade() {
                let _ = capability_app.emit(
                    "reviewbox:live-language",
                    LiveLanguageEvent {
                        session_id: capability_key.clone(),
                        method: "reviewbox/capabilities".into(),
                        params: session.capability_data(),
                    },
                );
            }
        })));
        *session
            .notifications
            .lock()
            .unwrap_or_else(|e| e.into_inner()) = Some(Arc::new(move |value| {
            if let Some(method) = value["method"].as_str().filter(|m| {
                matches!(
                    *m,
                    "textDocument/publishDiagnostics"
                        | "$/progress"
                        | "window/logMessage"
                        | "reviewbox/stopped"
                        | "reviewbox/reconfigure"
                        | "workspace/diagnostic/refresh"
                        | "workspace/semanticTokens/refresh"
                )
            }) {
                if method == "reviewbox/stopped" {
                    event_storage
                        .repository_cache
                        .release_lease(&event_root, &event_key);
                }
                let _ = app.emit(
                    "reviewbox:live-language",
                    LiveLanguageEvent {
                        session_id: event_key.clone(),
                        method: method.into(),
                        params: value["params"].clone(),
                    },
                );
            }
        }));
        if let Err(error) = session.initialize().await {
            session.stop();
            return Err(error);
        }
        if let Err(error) = crate::editor_extensions::require_engine(&storage, &server.id) {
            session.stop();
            return Err(error);
        }
        if let Err(error) = storage.repository_cache.lease(&storage, &root, &id) {
            session.stop();
            return Err(error);
        }
        if inspection_id.is_none() {
            manager.hydrate(&session, &root, &id).await;
        }
        manager
            .0
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .retain(|_, e| !e.session.is_stopped());
        manager.0.lock().unwrap_or_else(|e| e.into_inner()).insert(
            key.clone(),
            Arc::new(Entry {
                inspection: inspection_id.is_some(),
                id: id.clone(),
                root: root.clone(),
                session: session.clone(),
                documents: AsyncMutex::new(BTreeMap::new()),
                storage: Some(storage.inner().clone()),
                source_path: path.clone(),
                context: project.context.clone(),
                configuration_paths: project.configuration_paths.clone(),
                scope: project.scope.clone(),
            }),
        );
        (session, id)
    };
    Ok(LiveLanguageSession {
        id: session_id,
        server_id: server.id,
        root_uri: url::Url::from_directory_path(&project.root)
            .map_err(|_| AppError::new("invalid_path", "Invalid root."))?
            .to_string(),
        capabilities: session.capability_data(),
        context: project.context,
    })
}

fn uri(entry: &Entry, path: &str) -> AppResult<String> {
    url::Url::from_file_path(crate::editor::path(&entry.root, path)?)
        .map(|u| u.to_string())
        .map_err(|_| AppError::new("invalid_path", "Invalid document URI."))
}
#[tauri::command]
pub async fn live_language_sync(
    manager: State<'_, LiveLanguages>,
    session_id: String,
    document: LiveLanguageDocument,
    saved: bool,
) -> AppResult<()> {
    let entry = manager.entry(&session_id)?;
    synchronize(&entry, document.clone(), saved).await?;
    manager.mirror(&entry, &document).await;
    Ok(())
}
async fn synchronize(entry: &Entry, document: LiveLanguageDocument, saved: bool) -> AppResult<()> {
    if document.text.len() as u64 > crate::editor::MAX_TEXT || document.version < 1 {
        return Err(AppError::new(
            "invalid_document",
            "Invalid editor document.",
        ));
    }
    let uri = uri(entry, &document.path)?;
    let mut documents = entry.documents.lock().await;
    let method;
    let params;
    if let Some(old) = documents.get(&document.path) {
        if document.version < old.version {
            return Ok(());
        }
        if document.version == old.version && document.text != old.text {
            return Err(AppError::new(
                "stale_document",
                "Document version already exists.",
            ));
        }
        method = "textDocument/didChange";
        let caps = entry.session.capability_data();
        let sync = if caps["textDocumentSync"].is_number() {
            &caps["textDocumentSync"]
        } else {
            &caps["textDocumentSync"]["change"]
        };
        let changes = if sync == 2 {
            incremental_changes(old,&document).unwrap_or_else(|| {
                let (line,last)=old.text.split('\n').enumerate().last().unwrap_or((0,""));
                vec![json!({"range":{"start":{"line":0,"character":0},"end":{"line":line,"character":last.encode_utf16().count()}},"text":document.text})]
            })
        } else {
            vec![json!({"text":document.text})]
        };
        params =
            json!({"textDocument":{"uri":uri,"version":document.version},"contentChanges":changes});
        if document.version != old.version && sync != 0 {
            entry
                .session
                .send(&json!({"jsonrpc":"2.0","method":method,"params":params}))
                .await?;
        }
    } else {
        entry.session.close_mirrored_document(&uri).await?;
        method = "textDocument/didOpen";
        params = json!({"textDocument":{"uri":uri,"languageId":document.language_id,"version":document.version,"text":document.text}});
        if open_close(&entry.session.capability_data()) {
            entry
                .session
                .send(&json!({"jsonrpc":"2.0","method":method,"params":params}))
                .await?;
        }
    }
    let save = entry.session.capability_data()["textDocumentSync"]["save"].clone();
    if saved && (save == true || save.is_object()) {
        let mut params = json!({"textDocument":{"uri":uri}});
        if save["includeText"] == true {
            params["text"] = json!(document.text);
        }
        entry
            .session
            .send(&json!({"jsonrpc":"2.0","method":"textDocument/didSave","params":params}))
            .await?;
    }
    let mut document = document;
    document.changes.clear();
    document.base_version = None;
    documents.insert(document.path.clone(), document);
    Ok(())
}
fn open_close(capabilities: &Value) -> bool {
    let sync = &capabilities["textDocumentSync"];
    sync["openClose"] == true || sync.as_u64().is_some_and(|kind| kind != 0)
}
fn byte_position(text: &str, line: u32, character: u32) -> Option<usize> {
    let mut start = 0;
    for _ in 0..line {
        start += text.get(start..)?.find('\n')? + 1;
    }
    let remaining = text.get(start..)?;
    let mut utf16 = 0;
    for (offset, ch) in remaining.char_indices() {
        if utf16 == character {
            return Some(start + offset);
        }
        if ch == '\n' {
            return None;
        }
        utf16 += ch.len_utf16() as u32;
        if utf16 > character {
            return None;
        }
    }
    (utf16 == character).then_some(text.len())
}
fn incremental_changes(
    old: &LiveLanguageDocument,
    document: &LiveLanguageDocument,
) -> Option<Vec<Value>> {
    if document.base_version != Some(old.version)
        || document.changes.is_empty()
        || document.changes.len() > 1024
    {
        return None;
    }
    let mut text = old.text.clone();
    let mut changes = Vec::new();
    for change in &document.changes {
        let start = byte_position(&text, change.start_line, change.start_character)?;
        let end = byte_position(&text, change.end_line, change.end_character)?;
        if start > end {
            return None;
        }
        text.replace_range(start..end, &change.text);
        if text.len() as u64 > crate::editor::MAX_TEXT {
            return None;
        }
        changes.push(json!({"range":{"start":{"line":change.start_line,"character":change.start_character},"end":{"line":change.end_line,"character":change.end_character}},"text":change.text}));
    }
    (text == document.text).then_some(changes)
}

#[tauri::command]
pub async fn live_language_request(
    manager: State<'_, LiveLanguages>,
    session_id: String,
    request_id: String,
    path: String,
    version: i32,
    method: String,
    params: Value,
) -> AppResult<Value> {
    let entry = manager.entry(&session_id)?;
    query(&entry, &request_id, &path, version, &method, params).await
}
async fn query(
    entry: &Entry,
    request_id: &str,
    path: &str,
    version: i32,
    method: &str,
    mut params: Value,
) -> AppResult<Value> {
    if !matches!(
        method,
        "textDocument/completion"
            | "completionItem/resolve"
            | "textDocument/hover"
            | "textDocument/signatureHelp"
            | "textDocument/definition"
            | "textDocument/references"
            | "textDocument/documentSymbol"
            | "workspace/symbol"
            | "textDocument/semanticTokens/full"
            | "textDocument/diagnostic"
            | "textDocument/formatting"
            | "textDocument/rangeFormatting"
            | "textDocument/linkedEditingRange"
            | "textDocument/documentColor"
            | "textDocument/colorPresentation"
            | "textDocument/prepareRename"
            | "textDocument/rename"
            | "textDocument/codeAction"
            | "codeAction/resolve"
    ) {
        return Err(AppError::new(
            "unsupported_method",
            "This language operation is not supported.",
        ));
    }
    if !params.is_object() || serde_json::to_vec(&params)?.len() > 1024 * 1024 {
        return Err(AppError::new(
            "invalid_request",
            "Invalid language request.",
        ));
    }
    let language = entry
        .documents
        .lock()
        .await
        .get(path)
        .filter(|d| d.version == version)
        .map(|d| d.language_id.clone());
    let Some(language) = language else {
        return Err(AppError::new("stale_document", "The buffer changed."));
    };
    if !entry
        .session
        .supports_document(method, &entry.root.join(path), &language)
    {
        return Err(AppError::new(
            "unsupported_capability",
            "This server does not provide that operation for this document.",
        ));
    }
    if method.starts_with("textDocument/") {
        params["textDocument"] = json!({"uri":uri(entry, path)?});
    }
    let result = entry.session.rpc(request_id, method, params, None).await?;
    if entry
        .documents
        .lock()
        .await
        .get(path)
        .is_none_or(|d| d.version != version)
    {
        return Err(AppError::new("stale_document", "The buffer changed."));
    }
    Ok(result)
}
#[tauri::command]
pub async fn live_language_close(
    manager: State<'_, LiveLanguages>,
    session_id: String,
    path: String,
) -> AppResult<()> {
    let _gate = manager.1.lock().await;
    let entry = manager.entry(&session_id)?;
    let mut documents = entry.documents.lock().await;
    if documents.remove(&path).is_some() && open_close(&entry.session.capability_data()) {
        entry.session.send(&json!({"jsonrpc":"2.0","method":"textDocument/didClose","params":{"textDocument":{"uri":uri(&entry,&path)?}}})).await?;
    }
    let unused = documents.is_empty();
    drop(documents);
    let uri = uri(&entry, &path)?;
    for peer in if entry.inspection {
        Vec::new()
    } else {
        manager.peers(&entry.root, &entry.id)
    } {
        let _ = peer.session.close_mirrored_document(&uri).await;
    }
    if unused {
        let mut entries = manager.0.lock().unwrap_or_else(|e| e.into_inner());
        entries.retain(|_, e| e.id != session_id);
        entry.session.stop();
    }
    Ok(())
}
#[tauri::command]
pub fn live_language_cancel(
    manager: State<'_, LiveLanguages>,
    session_id: String,
    request_id: String,
) -> AppResult<()> {
    manager.entry(&session_id)?.session.cancel(&request_id);
    Ok(())
}
#[tauri::command]
pub fn live_language_restart(manager: State<'_, LiveLanguages>, session_id: String) {
    let mut entries = manager.0.lock().unwrap_or_else(|e| e.into_inner());
    let key = entries
        .iter()
        .find(|(_, entry)| entry.id == session_id)
        .map(|(key, _)| key.clone());
    if let Some(key) = key
        && let Some(entry) = entries.remove(&key)
    {
        entry.session.stop();
    }
}
#[tauri::command]
pub async fn live_language_source(
    manager: State<'_, LiveLanguages>,
    session_id: String,
    uri: String,
) -> AppResult<EditorFile> {
    let entry = manager.entry(&session_id)?;
    inspection_source(&entry, uri).await
}

async fn inspection_source(entry: &Entry, uri: String) -> AppResult<EditorFile> {
    let path = url::Url::parse(&uri)
        .map_err(|e| AppError::new("invalid_uri", e.to_string()))?
        .to_file_path()
        .map_err(|_| AppError::new("invalid_uri", "Only file definitions can be opened."))?;
    // A definition in the inspected side must retain its exact text, including deleted files.
    if entry.inspection {
        for document in entry.documents.lock().await.values() {
            if crate::editor::path(&entry.root, &document.path)? == path {
                return Ok(EditorFile {
                    path: document.path.clone(),
                    uri,
                    text: document.text.clone(),
                    revision: fingerprint(document.text.as_bytes()),
                    read_only: true,
                    reason: Some("Review source inspection.".into()),
                });
            }
        }
    }
    let path = path.canonicalize()?;
    if let Ok(relative) = path.strip_prefix(&entry.root) {
        crate::editor::read(&entry.root, &relative.to_string_lossy().replace('\\', "/"))
    } else {
        crate::editor::read_file(&path, uri, true)
    }
}

/// Root discovery is data driven and bounded by the checkout, including nested projects.
#[cfg(test)]
pub(super) fn project_configuration(
    storage: &Storage,
    root: &std::path::Path,
    path: &str,
    server: &str,
) -> AppResult<(std::path::PathBuf, Value)> {
    let project = super::project::resolve(storage, root, path, server)?;
    Ok((project.root, project.settings))
}

impl LiveLanguages {
    pub async fn repository_changed(&self, root: &std::path::Path, change: &RepositoryReadChange) {
        let entries = self
            .0
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .values()
            .filter(|e| e.root == root && !e.session.is_stopped())
            .cloned()
            .collect::<Vec<_>>();
        for entry in entries {
            // A watcher overflow or checkout replacement cannot enumerate the
            // lost source changes. Re-open the affected project to rebuild its
            // server state; ordinary Git/index events never use this path.
            if change.full && change.paths.is_empty() {
                entry.session.stop();
                entry.session.notify("reviewbox/reconfigure", json!({}));
                continue;
            }
            if let Some(storage) = &entry.storage {
                let relevant = change.full
                    || change.paths.iter().any(|path| {
                        entry.configuration_paths.contains(path)
                            || entry.configuration_paths.iter().any(|candidate| {
                                std::path::Path::new(candidate).file_name()
                                    == std::path::Path::new(path).file_name()
                            })
                    });
                if relevant {
                    let storage = storage.clone();
                    let root = root.to_path_buf();
                    // A session may have been opened by a file in another
                    // directory before this new nested root marker existed.
                    // Re-evaluate all live documents, not just its first file.
                    let mut paths = entry
                        .documents
                        .lock()
                        .await
                        .keys()
                        .cloned()
                        .collect::<Vec<_>>();
                    if paths.is_empty() {
                        paths.push(entry.source_path.clone());
                    }
                    let server = entry.session.server.id.clone();
                    let signature = entry.context.signature.clone();
                    let result = tauri::async_runtime::spawn_blocking(move || {
                        for path in paths {
                            if super::project::resolve(&storage, &root, &path, &server)?
                                .context
                                .signature
                                != signature
                            {
                                return Ok(true);
                            }
                        }
                        Ok::<_, AppError>(false)
                    })
                    .await;
                    match result
                        .unwrap_or_else(|error| Err(AppError::new("task", error.to_string())))
                    {
                        Ok(true) => {
                            entry.session.stop();
                            entry.session.notify("reviewbox/reconfigure", json!({}));
                            continue;
                        }
                        Err(error) => {
                            entry.session.notify(
                                "window/logMessage",
                                json!({"type":1,"message":error.message}),
                            );
                        }
                        _ => {}
                    }
                }
            }
            let changes = change
                .changes
                .as_deref()
                .unwrap_or_default()
                .iter()
                .filter_map(|change| {
                    let path = root.join(&change.path);
                    let kind = match change.kind.as_str() {
                        "created" => 1,
                        "changed" => 2,
                        "deleted" => 3,
                        _ => return None,
                    };
                    if !entry.session.watches(&path, kind) {
                        return None;
                    }
                    url::Url::from_file_path(path)
                        .ok()
                        .map(|uri| json!({"uri":uri,"type":kind}))
                })
                .collect::<Vec<_>>();
            if !changes.is_empty() {
                let _=entry.session.send(&json!({"jsonrpc":"2.0","method":"workspace/didChangeWatchedFiles","params":{"changes":changes}})).await;
            }
        }
    }
    pub async fn changed(&self, root: &std::path::Path, mutation: &EditorMutation) {
        let entries = self
            .0
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .values()
            .filter(|e| e.root == root)
            .cloned()
            .collect::<Vec<_>>();
        let (path, directory) = match mutation {
            EditorMutation::Save { .. } => return,
            EditorMutation::Create { path, directory } => (path, Some(*directory)),
            EditorMutation::Rename {
                path, destination, ..
            } => (path, Some(root.join(destination).is_dir())),
            EditorMutation::Trash { path, .. } => (path, None),
        };
        let make_uri = |p: &str| {
            url::Url::from_file_path(root.join(p))
                .ok()
                .map(|u| u.to_string())
        };
        let destination = match mutation {
            EditorMutation::Rename { destination, .. } => Some(root.join(destination)),
            _ => None,
        };
        for entry in entries {
            if !root.join(path).starts_with(entry.session.workspace.root())
                && !destination
                    .as_ref()
                    .is_some_and(|p| p.starts_with(entry.session.workspace.root()))
            {
                continue;
            }
            let operation = match mutation {
                EditorMutation::Rename { destination, .. } => Some((
                    "didRename",
                    json!({"files":[{"oldUri":make_uri(path),"newUri":make_uri(destination)}]}),
                )),
                EditorMutation::Create { .. } => {
                    Some(("didCreate", json!({"files":[{"uri":make_uri(path)}]})))
                }
                EditorMutation::Trash { .. } => {
                    Some(("didDelete", json!({"files":[{"uri":make_uri(path)}]})))
                }
                _ => None,
            };
            if let Some((name, params)) = operation
                && (entry
                    .session
                    .file_operation(name, &root.join(path), directory)
                    || destination
                        .as_ref()
                        .is_some_and(|p| entry.session.file_operation(name, p, directory)))
            {
                let _ = entry.session.send(&json!({"jsonrpc":"2.0","method":format!("workspace/{name}Files"),"params":params})).await;
            }
        }
    }
}

#[cfg(test)]
mod tests;

#[cfg(test)]
mod extension_tests;
