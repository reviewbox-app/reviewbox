use super::workspace::{Workspace, parse_range, validate_position, validate_row_position};
use crate::{contracts::*, processes::ProcessGroup};
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, HashSet},
    process::Stdio,
    sync::{
        Arc, Mutex, Weak,
        atomic::{AtomicBool, AtomicU64, Ordering},
    },
    time::Duration,
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt, BufReader},
    sync::{Mutex as AsyncMutex, oneshot},
};

const RESPONSE_LIMIT: usize = 4 * 1024 * 1024;
const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
struct Pending {
    label: String,
    reply: oneshot::Sender<AppResult<Value>>,
}

pub(super) struct Session {
    pub server: LanguageServerConfig,
    pub workspace: Workspace,
    input: AsyncMutex<tokio::process::ChildStdin>,
    child: Mutex<Option<tokio::process::Child>>,
    group: ProcessGroup,
    stopped: AtomicBool,
    next_id: AtomicU64,
    pending: Mutex<BTreeMap<u64, Pending>>,
    capabilities: Mutex<Value>,
    opened: AsyncMutex<HashSet<String>>,
    capability_updates: tokio::sync::Notify,
    notifier: Mutex<Option<Arc<dyn Fn() + Send + Sync>>>,
    rust_source: Option<String>,
}

impl Session {
    pub fn spawn(
        server: LanguageServerConfig,
        workspace: Workspace,
        environment: Vec<(String, String)>,
    ) -> AppResult<Arc<Self>> {
        let rust_source = environment
            .iter()
            .find(|(key, _)| key == "RUST_SRC_PATH")
            .map(|(_, value)| value.clone());
        let mut command = tokio::process::Command::new(&server.executable);
        command
            .args(server.arguments.iter().map(|argument| {
                argument.replace("{workspace}", &workspace.root().to_string_lossy())
            }))
            .envs(environment)
            .current_dir(workspace.root())
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true);
        #[cfg(test)]
        command.stderr(Stdio::inherit());
        #[cfg(unix)]
        command.process_group(0);
        let mut child = command.spawn().map_err(|error| {
            AppError::new(
                "missing_language_server",
                format!("{} could not start: {error}", server.name),
            )
        })?;
        let group =
            ProcessGroup::new(child.id().ok_or_else(|| {
                AppError::new("process", "The language server has no process ID.")
            })?);
        let input = child
            .stdin
            .take()
            .ok_or_else(|| AppError::new("process", "The language server input is unavailable."))?;
        let output = child.stdout.take().ok_or_else(|| {
            AppError::new("process", "The language server output is unavailable.")
        })?;
        let session = Arc::new(Self {
            server,
            workspace,
            input: AsyncMutex::new(input),
            child: Mutex::new(Some(child)),
            group,
            stopped: AtomicBool::new(false),
            next_id: AtomicU64::new(1),
            pending: Mutex::new(BTreeMap::new()),
            capabilities: Mutex::new(Value::Null),
            opened: AsyncMutex::new(HashSet::new()),
            capability_updates: tokio::sync::Notify::new(),
            notifier: Mutex::new(None),
            rust_source,
        });
        let weak = Arc::downgrade(&session);
        tauri::async_runtime::spawn(async move {
            read_messages(weak, output).await;
        });
        Ok(session)
    }
    pub fn is_stopped(&self) -> bool {
        self.stopped.load(Ordering::Acquire)
    }
    pub fn set_notifier(&self, notify: Option<Arc<dyn Fn() + Send + Sync>>) {
        *self
            .notifier
            .lock()
            .unwrap_or_else(|error| error.into_inner()) = notify;
    }
    fn notify_capabilities(&self) {
        self.capability_updates.notify_one();
        let notify = self
            .notifier
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .clone();
        if let Some(notify) = notify {
            notify();
        }
    }
    fn configuration(&self) -> Value {
        let mut configuration = read_only_configuration();
        if let Some(source) = &self.rust_source {
            configuration["cargo"]["sysrootSrc"] = json!(source);
            configuration["rust-analyzer"]["cargo"]["sysrootSrc"] = json!(source);
        }
        configuration
    }
    pub fn stop(&self) {
        if self.stopped.swap(true, Ordering::AcqRel) {
            return;
        }
        self.group.terminate();
        let pending = std::mem::take(
            &mut *self
                .pending
                .lock()
                .unwrap_or_else(|error| error.into_inner()),
        );
        for (_, pending) in pending {
            let _ = pending.reply.send(Err(AppError::new(
                "language_session_closed",
                "The language session was closed.",
            )));
        }
        if let Some(mut child) = self
            .child
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .take()
        {
            let _ = child.start_kill();
            tauri::async_runtime::spawn(async move {
                let _ = child.wait().await;
            });
        }
    }
    async fn send(&self, message: &Value) -> AppResult<()> {
        if self.is_stopped() {
            return Err(AppError::new(
                "language_session_closed",
                "The language session was closed.",
            ));
        }
        let bytes = serde_json::to_vec(message)?;
        if bytes.len() > RESPONSE_LIMIT {
            return Err(AppError::new(
                "language_document_too_large",
                "This document exceeds the language protocol transport limit.",
            ));
        }
        let operation = async {
            let mut input = self.input.lock().await;
            input
                .write_all(format!("Content-Length: {}\r\n\r\n", bytes.len()).as_bytes())
                .await?;
            input.write_all(&bytes).await?;
            input.flush().await?;
            Ok::<_, AppError>(())
        };
        tokio::time::timeout(Duration::from_secs(5), operation)
            .await
            .map_err(|_| {
                AppError::new(
                    "lsp_timeout",
                    "The language server stopped accepting requests.",
                )
            })?
    }
    async fn rpc(
        &self,
        label: &str,
        method: &str,
        params: Value,
        cancelled: Option<&AtomicBool>,
    ) -> AppResult<Value> {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let (reply, receive) = oneshot::channel();
        self.pending
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .insert(
                id,
                Pending {
                    label: label.into(),
                    reply,
                },
            );
        if cancelled.is_some_and(|cancelled| cancelled.load(Ordering::Acquire)) {
            self.pending
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .remove(&id);
            return Err(AppError::new(
                "cancelled",
                "The language request was cancelled.",
            ));
        }
        if let Err(error) = self
            .send(&json!({"jsonrpc":"2.0","id":id,"method":method,"params":params}))
            .await
        {
            self.pending
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .remove(&id);
            self.stop();
            return Err(error);
        }
        match tokio::time::timeout(REQUEST_TIMEOUT, receive).await {
            Ok(Ok(result)) => result,
            Ok(Err(_)) => Err(AppError::new(
                "language_session_closed",
                "The language session was closed.",
            )),
            Err(_) => {
                self.pending
                    .lock()
                    .unwrap_or_else(|error| error.into_inner())
                    .remove(&id);
                let _ = self
                    .send(&json!({"jsonrpc":"2.0","method":"$/cancelRequest","params":{"id":id}}))
                    .await;
                Err(AppError::new(
                    "lsp_timeout",
                    "The language server did not answer within 30 seconds.",
                ))
            }
        }
    }
    pub fn cancel(self: &Arc<Self>, label: &str) {
        let mut pending = self
            .pending
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let ids = pending
            .iter()
            .filter_map(|(id, value)| (value.label == label).then_some(*id))
            .collect::<Vec<_>>();
        for id in &ids {
            if let Some(value) = pending.remove(id) {
                let _ = value.reply.send(Err(AppError::new(
                    "cancelled",
                    "The language request was cancelled.",
                )));
            }
        }
        drop(pending);
        for id in ids {
            let session = self.clone();
            tauri::async_runtime::spawn(async move {
                let _ = session
                    .send(&json!({"jsonrpc":"2.0","method":"$/cancelRequest","params":{"id":id}}))
                    .await;
            });
        }
    }
    pub async fn initialize(&self) -> AppResult<()> {
        let root = url::Url::from_directory_path(self.workspace.root())
            .map_err(|_| AppError::new("invalid_location", "Invalid language workspace."))?;
        let mut options = self.configuration();
        if self.server.id == "java" {
            options["settings"] = self.configuration();
        }
        if self.server.id == "go" {
            options["semanticTokens"] = json!(true);
            options["env"] = json!({"GOPROXY":"off", "GOSUMDB":"off"});
        }
        if self.server.id == "vue" {
            let tsdk = self.server.arguments.iter().find_map(|argument| {
                std::path::Path::new(argument).ancestors().find_map(|parent| {
                    let tsdk = parent.join("typescript/lib");
                    (parent.file_name().is_some_and(|name| name == "node_modules")
                        && tsdk.join("typescript.js").is_file()).then_some(tsdk)
                })
            }).ok_or_else(|| AppError::new("missing_language_prerequisite", "Vue requires its private TypeScript SDK. Reinstall the Vue language server."))?;
            options["typescript"] = json!({"tsdk": tsdk, "disableAutoImportCache": true});
            options["vue"] = json!({"hybridMode": false});
        }
        if self.server.id == "kotlin" {
            // The empty build-tool selector is the upstream "none" mode. In
            // particular, merely opening a capture must never run Gradle/Maven.
            options["buildTools"] = json!({root.as_str(): ""});
        }
        let result = self.rpc("initialize", "initialize", json!({
            "processId":std::process::id(), "rootUri":root, "workspaceFolders":[{"uri":root,"name":"Captured sources"}],
            "capabilities":{
                "general":{"positionEncodings":["utf-16"]},
                "workspace":{"configuration":true,"workspaceFolders":true,"applyEdit":false,"semanticTokens":{"refreshSupport":true}},
                "textDocument":{
                    "hover":{"contentFormat":["markdown","plaintext"]},
                    "definition":{"linkSupport":true}, "references":{},
                    "documentSymbol":{"hierarchicalDocumentSymbolSupport":true},
                    "semanticTokens":{"dynamicRegistration":true,"requests":{"full":true,"range":true},"tokenTypes":["namespace","type","class","enum","interface","struct","typeParameter","parameter","variable","property","enumMember","event","function","method","macro","keyword","modifier","comment","string","number","regexp","operator","decorator"],"tokenModifiers":["declaration","definition","readonly","static","deprecated","abstract","async","modification","documentation","defaultLibrary"],"formats":["relative"],"overlappingTokenSupport":false,"multilineTokenSupport":false}
                }
            },
            "initializationOptions":options
        }),None).await?;
        if result["capabilities"]["positionEncoding"]
            .as_str()
            .is_some_and(|encoding| encoding != "utf-16")
        {
            return Err(AppError::new(
                "lsp_protocol",
                "The language server did not negotiate UTF-16 positions.",
            ));
        }
        *self
            .capabilities
            .lock()
            .unwrap_or_else(|error| error.into_inner()) = result["capabilities"].clone();
        self.send(&json!({"jsonrpc":"2.0","method":"initialized","params":{}}))
            .await?;
        self.send(&json!({"jsonrpc":"2.0","method":"workspace/didChangeConfiguration","params":{"settings":self.configuration()}})).await
    }
    fn capability_data(&self) -> Value {
        self.capabilities
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .clone()
    }
    pub fn capabilities(&self) -> LanguageCapabilities {
        let value = self.capability_data();
        let enabled = |key: &str| !value[key].is_null() && value[key] != false;
        LanguageCapabilities {
            semantic_tokens: enabled("semanticTokensProvider")
                && ["full", "range"].iter().any(|kind| {
                    value["semanticTokensProvider"][kind] != false
                        && !value["semanticTokensProvider"][kind].is_null()
                }),
            hover: enabled("hoverProvider"),
            definitions: enabled("definitionProvider"),
            references: enabled("referencesProvider"),
            symbols: enabled("documentSymbolProvider"),
        }
    }
    pub fn observed_capabilities(&self) -> Option<LanguageCapabilities> {
        (!self.is_stopped() && !self.capability_data().is_null()).then(|| self.capabilities())
    }
    pub async fn request(
        self: &Arc<Self>,
        request: &LanguageRequest,
        cancelled: &AtomicBool,
    ) -> AppResult<LanguageResponse> {
        let current = self.clone();
        let path = request.document.path.clone();
        let text = tauri::async_runtime::spawn_blocking(move || current.workspace.text(&path))
            .await
            .map_err(|error| AppError::new("language_workspace", error.to_string()))??;
        let uri = self.workspace.uri(&request.document.path)?;
        {
            let mut opened = self.opened.lock().await;
            if !opened.contains(&request.document.path) {
                self.send(&json!({"jsonrpc":"2.0","method":"textDocument/didOpen","params":{"textDocument":{"uri":uri,"languageId":language_id(&request.document.path),"version":1,"text":text}}})).await?;
                opened.insert(request.document.path.clone());
            }
        }
        if request.method == LanguageMethod::SemanticTokens && !self.capabilities().semantic_tokens
        {
            // Some servers register semantic tokens only after their first file
            // is opened (SourceKit-LSP). Give that explicit event a bounded wait.
            let notified = self.capability_updates.notified();
            if !self.capabilities().semantic_tokens {
                let _ = tokio::time::timeout(Duration::from_millis(500), notified).await;
            }
        }
        let capabilities = self.capabilities();
        let full_tokens = self.capability_data()["semanticTokensProvider"]["full"].clone();
        let (method, supported) = match request.method {
            LanguageMethod::SemanticTokens => (
                if full_tokens != false && !full_tokens.is_null() {
                    "textDocument/semanticTokens/full"
                } else {
                    "textDocument/semanticTokens/range"
                },
                capabilities.semantic_tokens,
            ),
            LanguageMethod::Hover => ("textDocument/hover", capabilities.hover),
            LanguageMethod::Definitions => ("textDocument/definition", capabilities.definitions),
            LanguageMethod::References => ("textDocument/references", capabilities.references),
            LanguageMethod::Symbols => ("textDocument/documentSymbol", capabilities.symbols),
        };
        if !supported {
            return Err(AppError::new(
                "unsupported_capability",
                "This server does not provide this language feature.",
            ));
        }
        let mut params = json!({"textDocument":{"uri":uri}});
        if method == "textDocument/semanticTokens/range" {
            let mut rows = text.split('\n');
            let last = rows.next_back().unwrap_or_default().trim_end_matches('\r');
            params["range"] = json!({"start":{"line":0,"character":0},"end":{"line":rows.count(),"character":last.encode_utf16().count()}});
        }
        if matches!(
            request.method,
            LanguageMethod::Hover | LanguageMethod::Definitions | LanguageMethod::References
        ) {
            let (line, column) = request.line.zip(request.column).ok_or_else(|| {
                AppError::new(
                    "invalid_location",
                    "This language request needs a source position.",
                )
            })?;
            validate_position(&text, line, column)?;
            params["position"] = json!({"line":line-1,"character":column-1});
        }
        if request.method == LanguageMethod::References {
            params["context"] = json!({"includeDeclaration":true});
        }
        if cancelled.load(Ordering::Acquire) {
            return Err(AppError::new(
                "cancelled",
                "The language request was cancelled.",
            ));
        }
        let result = self
            .rpc(&request.request_id, method, params, Some(cancelled))
            .await?;
        if cancelled.load(Ordering::Acquire) {
            return Err(AppError::new(
                "cancelled",
                "The language request was cancelled.",
            ));
        }
        let current = self.clone();
        let request = request.clone();
        tauri::async_runtime::spawn_blocking(move || {
        let mut response = LanguageResponse {
            request_id: request.request_id.clone(),
            content_hash: request.document.content_hash.clone(),
            server_id: current.server.id.clone(),
            capabilities,
            analysis_note: Some("Analysis uses captured sources. External dependencies are not imported and project builds are disabled; cross-project results may be incomplete.".into()),
            hover: None,
            locations: vec![],
            symbols: vec![],
            tokens: None,
        };
        match request.method {
            LanguageMethod::Hover if !result.is_null() => {
                response.hover = Some(LanguageHover {
                    markdown: hover_markdown(&result["contents"]),
                    range: result
                        .get("range")
                        .map(|value| parse_range(&text, value))
                        .transpose()?,
                });
            }
            LanguageMethod::Definitions | LanguageMethod::References => {
                let items = match result {
                    Value::Array(items) => items,
                    Value::Null => vec![],
                    other => vec![other],
                };
                for item in items {
                    let target = item["uri"]
                        .as_str()
                        .or_else(|| item["targetUri"].as_str())
                        .ok_or_else(|| {
                            AppError::new(
                                "lsp_protocol",
                                "The server returned a location without a URI.",
                            )
                        })?;
                    let range = item
                        .get("targetSelectionRange")
                        .or_else(|| item.get("range"))
                        .ok_or_else(|| {
                            AppError::new(
                                "lsp_protocol",
                                "The server returned a location without a range.",
                            )
                        })?;
                    // External library definitions are not captured and cannot be opened as reviewed code.
                    match current.workspace.location(target, range) {
                        Ok(location) => response.locations.push(location),
                        Err(error) if error.code == "external_definition" => {}
                        Err(error) => return Err(error),
                    }
                }
            }
            LanguageMethod::Symbols if !result.is_null() => {
                for item in result
                    .as_array()
                    .ok_or_else(|| AppError::new("lsp_protocol", "Invalid document symbols."))?
                {
                    if let Some(symbol) = symbol(&current.workspace, uri.as_str(), item, 0)? {
                        response.symbols.push(symbol);
                    }
                }
            }
            LanguageMethod::SemanticTokens if !result.is_null() => {
                response.tokens = Some(tokens(
                    &text,
                    &result,
                    &current.capability_data()["semanticTokensProvider"]["legend"],
                )?);
            }
            _ => {}
        }
        Ok(response)
        }).await.map_err(|error|AppError::new("language_response",error.to_string()))?
    }
}
impl Drop for Session {
    fn drop(&mut self) {
        self.stop();
    }
}

async fn read_frame(output: &mut BufReader<tokio::process::ChildStdout>) -> AppResult<Value> {
    let mut length = None;
    let mut header_bytes = 0;
    loop {
        let mut line = Vec::new();
        loop {
            let byte = output.read_u8().await?;
            header_bytes += 1;
            if header_bytes > 8192 {
                return Err(AppError::new(
                    "lsp_protocol",
                    "The language header is too large.",
                ));
            }
            line.push(byte);
            if byte == b'\n' {
                break;
            }
        }
        let line = std::str::from_utf8(&line)
            .map_err(|_| AppError::new("lsp_protocol", "Invalid language header encoding."))?;
        if line == "\r\n" || line == "\n" {
            break;
        }
        if let Some((key, value)) = line.split_once(':')
            && key.eq_ignore_ascii_case("content-length")
        {
            length = value.trim().parse::<usize>().ok();
        }
    }
    let length = length
        .filter(|length| *length <= RESPONSE_LIMIT)
        .ok_or_else(|| AppError::new("lsp_protocol", "Invalid language response length."))?;
    let mut bytes = vec![0; length];
    output.read_exact(&mut bytes).await?;
    Ok(serde_json::from_slice(&bytes)?)
}
async fn read_messages(weak: Weak<Session>, output: tokio::process::ChildStdout) {
    let mut output = BufReader::new(output);
    loop {
        let message = match read_frame(&mut output).await {
            Ok(message) => message,
            Err(error) => {
                if let Some(session) = weak.upgrade() {
                    let pending = std::mem::take(
                        &mut *session
                            .pending
                            .lock()
                            .unwrap_or_else(|error| error.into_inner()),
                    );
                    for (_, value) in pending {
                        let _ = value.reply.send(Err(error.clone()));
                    }
                    session.stop();
                }
                return;
            }
        };
        let Some(session) = weak.upgrade() else {
            return;
        };
        if session.is_stopped() {
            return;
        }
        if let Some(method) = message["method"].as_str() {
            if message.get("id").is_none() {
                continue;
            }
            let response = match method {
                "workspace/configuration" => {
                    let config = session.configuration();
                    let values = message["params"]["items"]
                        .as_array()
                        .into_iter()
                        .flatten()
                        .map(|item| {
                            item["section"]
                                .as_str()
                                .filter(|section| !section.is_empty())
                                .map_or(config.clone(), |section| {
                                    section
                                        .split('.')
                                        .fold(&config, |value, key| &value[key])
                                        .clone()
                                })
                        })
                        .collect::<Vec<_>>();
                    json!({"result":values})
                }
                "workspace/applyEdit" => {
                    json!({"result":{"applied":false,"failureReason":"ReviewBox reads immutable captured sources."}})
                }
                "workspace/workspaceFolders" => {
                    json!({"result":[{"uri":url::Url::from_directory_path(session.workspace.root()).ok(),"name":"Captured sources"}]})
                }
                "window/workDoneProgress/create" => json!({"result":null}),
                "workspace/semanticTokens/refresh" => {
                    session.notify_capabilities();
                    json!({"result":null})
                }
                "client/registerCapability" => {
                    let mut caps = session
                        .capabilities
                        .lock()
                        .unwrap_or_else(|error| error.into_inner());
                    let previous = caps.clone();
                    for item in message["params"]["registrations"]
                        .as_array()
                        .into_iter()
                        .flatten()
                    {
                        if item["method"] == "textDocument/semanticTokens" {
                            caps["semanticTokensProvider"] = item["registerOptions"].clone();
                        }
                    }
                    let changed = previous != *caps;
                    drop(caps);
                    if changed {
                        session.notify_capabilities();
                    }
                    json!({"result":null})
                }
                _ => json!({"error":{"code":-32601,"message":"Client method is not supported."}}),
            };
            let mut response = response;
            response["jsonrpc"] = json!("2.0");
            response["id"] = message["id"].clone();
            if session.send(&response).await.is_err() {
                session.stop();
                return;
            }
        } else if let Some(id) = message["id"].as_u64() {
            let pending = session
                .pending
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .remove(&id);
            if let Some(pending) = pending {
                let result = if let Some(error) = message.get("error") {
                    let code = if error["code"] == -32800 {
                        "cancelled"
                    } else {
                        "lsp_error"
                    };
                    Err(AppError::new(
                        code,
                        error["message"]
                            .as_str()
                            .unwrap_or("The language server rejected this request."),
                    ))
                } else {
                    Ok(message["result"].clone())
                };
                let _ = pending.reply.send(result);
            }
        }
    }
}

fn read_only_configuration() -> Value {
    json!({"cargo":{"buildScripts":{"enable":false},"extraEnv":{"CARGO_NET_OFFLINE":"true"}},"procMacro":{"enable":false},"checkOnSave":false,"check":{"enable":false},
        "rust-analyzer":{"cargo":{"buildScripts":{"enable":false},"extraEnv":{"CARGO_NET_OFFLINE":"true"}},"procMacro":{"enable":false},"checkOnSave":false,"check":{"enable":false}},
        "java":{"autobuild":{"enabled":false},"import":{"gradle":{"enabled":false},"maven":{"enabled":false}},"configuration":{"updateBuildConfiguration":"disabled"}},
        "rubyLsp":{"formatter":"none","linters":[]},"telemetry":{"enabled":false},
        "backgroundIndexing":false,"defaultWorkspaceType":"compilationDatabase",
        "dotnet":{"fileBasedApps":{"enableAutomaticDiscovery":false}},
        "prisma":{"enableDiagnostics":false},
        "gopls":{"semanticTokens":true,"env":{"GOPROXY":"off","GOSUMDB":"off"}},
        "intellij":{"buildTool":""}})
}
fn hover_markdown(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        Value::Array(items) => items
            .iter()
            .map(hover_markdown)
            .collect::<Vec<_>>()
            .join("\n\n"),
        Value::Object(_) => {
            let text = value["value"].as_str().unwrap_or_default();
            if value["kind"] == "plaintext" {
                text.chars()
                    .flat_map(|character| {
                        if matches!(
                            character,
                            '\\' | '`' | '*' | '_' | '[' | ']' | '<' | '>' | '#' | '!'
                        ) {
                            vec!['\\', character]
                        } else {
                            vec![character]
                        }
                    })
                    .collect()
            } else if let Some(language) = value["language"].as_str() {
                let fence = "`".repeat(
                    text.split(|c| c != '`')
                        .map(str::len)
                        .max()
                        .unwrap_or(0)
                        .max(2)
                        + 1,
                );
                format!(
                    "{fence}{}\n{text}\n{fence}",
                    language.replace(['\r', '\n', '`'], "")
                )
            } else {
                text.into()
            }
        }
        _ => String::new(),
    }
}
fn symbol(
    workspace: &Workspace,
    uri: &str,
    value: &Value,
    depth: usize,
) -> AppResult<Option<LanguageSymbol>> {
    if depth > 64 {
        return Err(AppError::new(
            "lsp_protocol",
            "The server returned excessively nested symbols.",
        ));
    }
    let target = value["location"]["uri"].as_str().unwrap_or(uri);
    let range = value
        .get("selectionRange")
        .or_else(|| value.get("range"))
        .unwrap_or(&value["location"]["range"]);
    let location = match workspace.location(target, range) {
        Ok(value) => value,
        Err(error) if error.code == "external_definition" => return Ok(None),
        Err(error) => return Err(error),
    };
    let name = value["name"]
        .as_str()
        .ok_or_else(|| AppError::new("lsp_protocol", "A symbol has no name."))?
        .to_owned();
    let kind = value["kind"]
        .as_u64()
        .filter(|kind| (1..=26).contains(kind))
        .ok_or_else(|| AppError::new("lsp_protocol", "A symbol has an invalid kind."))?
        as u32;
    let mut children = vec![];
    for child in value["children"].as_array().into_iter().flatten() {
        if let Some(child) = symbol(workspace, uri, child, depth + 1)? {
            children.push(child);
        }
    }
    Ok(Some(LanguageSymbol {
        name,
        detail: value["detail"].as_str().map(str::to_owned),
        kind,
        location,
        children,
    }))
}
pub(super) fn tokens(text: &str, result: &Value, legend: &Value) -> AppResult<LanguageTokens> {
    let strings = |key: &str| -> AppResult<Vec<String>> {
        legend[key]
            .as_array()
            .ok_or_else(|| AppError::new("lsp_protocol", "The semantic token legend is missing."))?
            .iter()
            .map(|value| {
                value.as_str().map(str::to_owned).ok_or_else(|| {
                    AppError::new("lsp_protocol", "The semantic token legend is invalid.")
                })
            })
            .collect()
    };
    let token_types = strings("tokenTypes")?;
    let token_modifiers = strings("tokenModifiers")?;
    let data = result["data"]
        .as_array()
        .ok_or_else(|| AppError::new("lsp_protocol", "Semantic tokens are missing."))?
        .iter()
        .map(|value| {
            value
                .as_u64()
                .and_then(|value| u32::try_from(value).ok())
                .ok_or_else(|| AppError::new("lsp_protocol", "Invalid semantic token value."))
        })
        .collect::<AppResult<Vec<_>>>()?;
    if data.len() % 5 != 0 {
        return Err(AppError::new(
            "lsp_protocol",
            "Semantic tokens must contain groups of five integers.",
        ));
    }
    let mut line = 0u32;
    let mut column = 0u32;
    let mut previous_end = 0u32;
    let rows = text
        .split('\n')
        .map(|row| row.trim_end_matches('\r'))
        .collect::<Vec<_>>();
    for token in data.chunks_exact(5) {
        line = line
            .checked_add(token[0])
            .ok_or_else(|| AppError::new("lsp_protocol", "Semantic token overflow."))?;
        column = if token[0] == 0 {
            column.checked_add(token[1])
        } else {
            Some(token[1])
        }
        .ok_or_else(|| AppError::new("lsp_protocol", "Semantic token overflow."))?;
        let end = column
            .checked_add(token[2])
            .ok_or_else(|| AppError::new("lsp_protocol", "Semantic token overflow."))?;
        if token[2] == 0
            || token[3] as usize >= token_types.len()
            || (token[0] == 0 && column < previous_end)
            || (token_modifiers.len() < 32 && token[4] >> token_modifiers.len() != 0)
        {
            return Err(AppError::new(
                "lsp_protocol",
                "Invalid semantic token range or legend index.",
            ));
        }
        let row = rows.get(line as usize).ok_or_else(|| {
            AppError::new("lsp_protocol", "Semantic token line is outside the source.")
        })?;
        validate_row_position(
            row,
            column
                .checked_add(1)
                .ok_or_else(|| AppError::new("lsp_protocol", "Semantic column overflow."))?,
        )?;
        validate_row_position(
            row,
            end.checked_add(1)
                .ok_or_else(|| AppError::new("lsp_protocol", "Semantic column overflow."))?,
        )?;
        previous_end = end;
    }
    Ok(LanguageTokens {
        data,
        token_types,
        token_modifiers,
    })
}
fn language_id(path: &str) -> &str {
    let name = path.rsplit('/').next().unwrap_or(path);
    if name.eq_ignore_ascii_case("dockerfile")
        || name.to_ascii_lowercase().starts_with("dockerfile.")
    {
        return "dockerfile";
    }
    if matches!(name, "Gemfile" | "Rakefile") {
        return "ruby";
    }
    match path.rsplit('.').next().unwrap_or("") {
        "ts" | "mts" | "cts" => "typescript",
        "tsx" => "typescriptreact",
        "js" | "mjs" | "cjs" => "javascript",
        "jsx" => "javascriptreact",
        "rs" => "rust",
        "py" | "pyi" => "python",
        "cs" => "csharp",
        "kt" | "kts" => "kotlin",
        "rb" => "ruby",
        "sh" | "bash" => "shellscript",
        "yml" => "yaml",
        "h" | "cc" | "cxx" | "hpp" => "cpp",
        "jsonc" => "jsonc",
        other => other,
    }
}
