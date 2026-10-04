//! Live documents use the existing transport but never enter captured-source APIs.
use super::{catalog, session::Session, workspace::Workspace};
use crate::{contracts::*, storage::Storage};
use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    sync::{Arc, Mutex},
};
use tauri::{Emitter, State};
use tokio::sync::Mutex as AsyncMutex;

struct Entry {
    id: String,
    root: std::path::PathBuf,
    session: Arc<Session>,
    documents: AsyncMutex<BTreeMap<String, LiveLanguageDocument>>,
}
#[derive(Default, Clone)]
pub struct LiveLanguages(
    Arc<Mutex<BTreeMap<String, Arc<Entry>>>>,
    Arc<AsyncMutex<()>>,
);
impl LiveLanguages {
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
            .live_settings
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone();
        let result = self.rpc("initialize", "initialize", json!({
            "processId":std::process::id(), "rootUri":root, "workspaceFolders":[{"uri":root,"name":"Code Editor"}],
            "initializationOptions": options,
            "capabilities": {
                "general":{"positionEncodings":["utf-16"]}, "window":{"workDoneProgress":true},
                "workspace":{"configuration":true,"workspaceFolders":true,"applyEdit":false,"workspaceEdit":{"documentChanges":true},"fileOperations":{"didCreate":true,"didRename":true,"didDelete":true},"symbol":{}},
                "textDocument":{
                    "synchronization":{"didSave":true},"completion":{"completionItem":{"snippetSupport":true,"documentationFormat":["markdown","plaintext"],"resolveSupport":{"properties":["documentation","detail","additionalTextEdits"]}}},
                    "hover":{"contentFormat":["markdown","plaintext"]},"signatureHelp":{"signatureInformation":{"documentationFormat":["markdown","plaintext"],"parameterInformation":{"labelOffsetSupport":true}}},
                    "definition":{"linkSupport":true},"references":{},"documentSymbol":{"hierarchicalDocumentSymbolSupport":true},"rename":{"prepareSupport":true},
                    "formatting":{},"codeAction":{"codeActionLiteralSupport":{"codeActionKind":{"valueSet":["quickfix","refactor","source.organizeImports"]}},"resolveSupport":{"properties":["edit"]}},
                    "publishDiagnostics":{"versionSupport":true,"relatedInformation":true},"diagnostic":{},
                    "semanticTokens":{"requests":{"full":true},"tokenTypes":["namespace","type","class","enum","interface","struct","typeParameter","parameter","variable","property","enumMember","event","function","method","macro","keyword","modifier","comment","string","number","regexp","operator","decorator"],"tokenModifiers":["declaration","definition","readonly","static","deprecated","abstract","async","modification","documentation","defaultLibrary"],"formats":["relative"]}
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
        *self.capabilities.lock().unwrap_or_else(|e| e.into_inner()) =
            result["capabilities"].clone();
        self.send(&json!({"jsonrpc":"2.0","method":"initialized","params":{}}))
            .await
    }
}

#[tauri::command]
pub async fn live_language_open(
    app: tauri::AppHandle,
    storage: State<'_, Storage>,
    manager: State<'_, LiveLanguages>,
    repository_id: String,
    path: String,
    language_id: Option<String>,
    server_id: Option<String>,
) -> AppResult<LiveLanguageSession> {
    let _gate = manager.1.lock().await;
    let root = crate::repositories::root(&storage, &repository_id)?;
    crate::editor::path(&root, &path)?;
    let server = catalog::resolve_language(
        &storage,
        &path,
        language_id.as_deref(),
        server_id.as_deref(),
    )?;
    let (project, settings) = project_configuration(&storage, &root, &path, &server.id)?;
    let key =
        fingerprint(format!("{repository_id}/{}/{}", server.id, project.display()).as_bytes());
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
        let environment = catalog::launch_environment(&storage, &server)?;
        let session = Session::spawn(
            server.clone(),
            Workspace::live(project.clone()),
            environment,
        )?;
        *session
            .live_settings
            .lock()
            .unwrap_or_else(|e| e.into_inner()) = settings;
        let event_key = id.clone();
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
                )
            }) {
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
        manager.0.lock().unwrap_or_else(|e| e.into_inner()).insert(
            key.clone(),
            Arc::new(Entry {
                id: id.clone(),
                root: root.clone(),
                session: session.clone(),
                documents: AsyncMutex::new(BTreeMap::new()),
            }),
        );
        (session, id)
    };
    Ok(LiveLanguageSession {
        id: session_id,
        server_id: server.id,
        root_uri: url::Url::from_directory_path(project)
            .map_err(|_| AppError::new("invalid_path", "Invalid root."))?
            .to_string(),
        capabilities: session.capability_data(),
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
    synchronize(&entry, document, saved).await
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
        let change = if sync == 2 {
            let mut lines = old.text.split('\n');
            let mut last = lines.next().unwrap_or_default();
            let mut line = 0;
            for next in lines {
                last = next;
                line += 1;
            }
            json!({"range":{"start":{"line":0,"character":0},"end":{"line":line,"character":last.encode_utf16().count()}},"text":document.text})
        } else {
            json!({"text":document.text})
        };
        params = json!({"textDocument":{"uri":uri,"version":document.version},"contentChanges":[change]});
        if document.version != old.version && sync != 0 {
            entry
                .session
                .send(&json!({"jsonrpc":"2.0","method":method,"params":params}))
                .await?;
        }
    } else {
        method = "textDocument/didOpen";
        params = json!({"textDocument":{"uri":uri,"languageId":document.language_id,"version":document.version,"text":document.text}});
        entry
            .session
            .send(&json!({"jsonrpc":"2.0","method":method,"params":params}))
            .await?;
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
    documents.insert(document.path.clone(), document);
    Ok(())
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
    if entry
        .documents
        .lock()
        .await
        .get(path)
        .is_none_or(|d| d.version != version)
    {
        return Err(AppError::new("stale_document", "The buffer changed."));
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
    let entry = manager.entry(&session_id)?;
    let mut documents = entry.documents.lock().await;
    if documents.remove(&path).is_some() {
        entry.session.send(&json!({"jsonrpc":"2.0","method":"textDocument/didClose","params":{"textDocument":{"uri":uri(&entry,&path)?}}})).await?;
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
    let path = url::Url::parse(&uri)
        .map_err(|e| AppError::new("invalid_uri", e.to_string()))?
        .to_file_path()
        .map_err(|_| AppError::new("invalid_uri", "Only file definitions can be opened."))?
        .canonicalize()?;
    if let Ok(relative) = path.strip_prefix(&entry.root) {
        crate::editor::read(&entry.root, &relative.to_string_lossy().replace('\\', "/"))
    } else {
        crate::editor::read_file(&path, uri, true)
    }
}

/// Root discovery is data driven and bounded by the checkout, including nested projects.
pub(super) fn project_configuration(
    storage: &Storage,
    root: &std::path::Path,
    path: &str,
    server: &str,
) -> AppResult<(std::path::PathBuf, Value)> {
    let pack = super::packs::all(storage)?
        .into_iter()
        .find(|p| p.id == server);
    let bundled: BTreeMap<String, Vec<String>> = serde_json::from_str(include_str!(
        "../../../resources/languages/project-roots.json"
    ))?;
    let markers = pack
        .as_ref()
        .map(|p| &p.root_markers)
        .or_else(|| bundled.get(server));
    let file = crate::editor::path(root, path)?;
    let project = file
        .ancestors()
        .skip(1)
        .take_while(|p| p.starts_with(root))
        .find(|p| markers.is_some_and(|m| m.iter().any(|name| p.join(name).is_file())))
        .unwrap_or(root)
        .to_path_buf();
    let settings = pack
        .and_then(|p| p.server)
        .map(|s| s.settings)
        .filter(Value::is_object)
        .unwrap_or_else(|| json!({}));
    Ok((project, settings))
}

impl LiveLanguages {
    pub async fn changed(&self, root: &std::path::Path, mutation: &EditorMutation) {
        let entries = self
            .0
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .values()
            .filter(|e| e.root == root)
            .cloned()
            .collect::<Vec<_>>();
        let (path, kind) = match mutation {
            EditorMutation::Save { path, .. } => (path, 2),
            EditorMutation::Create { path, .. } => (path, 1),
            EditorMutation::Rename { path, .. } | EditorMutation::Trash { path, .. } => (path, 3),
        };
        let make_uri = |p: &str| {
            url::Url::from_file_path(root.join(p))
                .ok()
                .map(|u| u.to_string())
        };
        for entry in entries {
            let mut changes = vec![json!({"uri":make_uri(path),"type":kind})];
            let operation = match mutation {
                EditorMutation::Rename { destination, .. } => {
                    changes.push(json!({"uri":make_uri(destination),"type":1}));
                    Some((
                        "didRename",
                        json!({"files":[{"oldUri":make_uri(path),"newUri":make_uri(destination)}]}),
                    ))
                }
                EditorMutation::Create { .. } => {
                    Some(("didCreate", json!({"files":[{"uri":make_uri(path)}]})))
                }
                EditorMutation::Trash { .. } => {
                    Some(("didDelete", json!({"files":[{"uri":make_uri(path)}]})))
                }
                _ => None,
            };
            let _ = entry.session.send(&json!({"jsonrpc":"2.0","method":"workspace/didChangeWatchedFiles","params":{"changes":changes}})).await;
            if let Some((name, params)) = operation
                && entry.session.capability_data()["workspace"]["fileOperations"][name].is_object()
            {
                let _ = entry.session.send(&json!({"jsonrpc":"2.0","method":format!("workspace/{name}Files"),"params":params})).await;
            }
        }
    }
}

#[cfg(test)]
mod tests;
