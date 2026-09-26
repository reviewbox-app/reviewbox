use crate::{contracts::*, storage::Storage};
use serde_json::{Value, json};
use std::{
    path::{Path, PathBuf},
    process::Stdio,
    time::Duration,
};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};

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
async fn send(input: &mut tokio::process::ChildStdin, message: &Value) -> AppResult<()> {
    let body = serde_json::to_vec(message)?;
    input
        .write_all(format!("Content-Length: {}\r\n\r\n", body.len()).as_bytes())
        .await?;
    input.write_all(&body).await?;
    input.flush().await?;
    Ok(())
}
async fn response(
    output: &mut BufReader<tokio::process::ChildStdout>,
    input: &mut tokio::process::ChildStdin,
    id: u32,
) -> AppResult<Value> {
    loop {
        let mut length = None;
        loop {
            let mut line = String::new();
            if output.read_line(&mut line).await? == 0 {
                return Err(AppError::new("lsp_exited", "Language server exited."));
            }
            if line == "\r\n" || line == "\n" {
                break;
            }
            if line.len() > 8192 {
                return Err(AppError::new("lsp_protocol", "Header too large."));
            }
            if let Some(value) = line.to_ascii_lowercase().strip_prefix("content-length:") {
                length = value.trim().parse::<usize>().ok();
            }
        }
        let length = length.filter(|n| *n <= 4 * 1024 * 1024).ok_or_else(|| {
            AppError::new("lsp_protocol", "Invalid language server response length.")
        })?;
        let mut bytes = vec![0; length];
        output.read_exact(&mut bytes).await?;
        let message: Value = serde_json::from_slice(&bytes)?;
        if message["id"] == id && message.get("method").is_none() {
            if message.get("error").is_some() {
                return Err(AppError::new(
                    "lsp_error",
                    "The language server rejected this request.",
                ));
            }
            return Ok(message["result"].clone());
        }
        if message.get("method").is_some() && message.get("id").is_some() {
            let result = match message["method"].as_str() {
                Some("workspace/configuration") => {
                    let count = message["params"]["items"].as_array().map_or(0, Vec::len);
                    json!(vec![
                        json!({"cargo":{"buildScripts":{"enable":false}},"procMacro":{"enable":false},"checkOnSave":false});
                        count
                    ])
                }
                Some("workspace/applyEdit") => json!({"applied":false}),
                _ => Value::Null,
            };
            send(
                input,
                &json!({"jsonrpc":"2.0","id":message["id"],"result":result}),
            )
            .await?;
        }
    }
}
fn materialize(storage: &Storage, snapshot: &Snapshot, directory: &Path) -> AppResult<()> {
    for file in &snapshot.files {
        if !matches!(file.content.mode.as_str(), "100644" | "100755") {
            continue;
        }
        crate::snapshots::safe_path(&file.path)?;
        let path = directory.join(&file.path);
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        std::fs::write(path, storage.read_blob(&file.content.hash)?)?;
    }
    Ok(())
}
pub async fn definition(
    storage: Storage,
    snapshot_id: String,
    path: String,
    line: u32,
    column: u32,
) -> AppResult<Vec<CodeLocation>> {
    let snapshot: Snapshot = storage.get("snapshot", &snapshot_id)?;
    if !snapshot.files.iter().any(|f| f.path == path) || line == 0 || column == 0 {
        return Err(AppError::new(
            "invalid_location",
            "Choose a location in a captured file.",
        ));
    }
    let extension = Path::new(&path)
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("");
    let server = settings(&storage)?
        .servers
        .into_iter()
        .find(|s| s.extensions.iter().any(|e| e == extension))
        .ok_or_else(|| {
            AppError::new(
                "missing_language_server",
                "Configure a language server for this file type in Settings.",
            )
        })?;
    let directory = tempfile::tempdir()?;
    let root = directory.path().to_path_buf();
    let copy_root = root.clone();
    let copy_storage = storage.clone();
    tauri::async_runtime::spawn_blocking(move || materialize(&copy_storage, &snapshot, &copy_root))
        .await
        .map_err(|_| AppError::new("task", "Cannot prepare the language server workspace."))??;
    let mut command = tokio::process::Command::new(&server.executable);
    command
        .args(&server.arguments)
        .current_dir(&root)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    #[cfg(unix)]
    command.process_group(0);
    let mut child = command.spawn().map_err(|_| {
        AppError::new(
            "missing_language_server",
            format!(
                "{} could not start. Install it separately or configure its executable path.",
                server.name
            ),
        )
    })?;
    let group = crate::processes::ProcessGroup::new(
        child
            .id()
            .ok_or_else(|| AppError::new("process", "Missing language server process."))?,
    );
    let mut input = child
        .stdin
        .take()
        .ok_or_else(|| AppError::new("process", "Missing server input."))?;
    let mut output = BufReader::new(
        child
            .stdout
            .take()
            .ok_or_else(|| AppError::new("process", "Missing server output."))?,
    );
    let operation = async {
        let root_uri = url::Url::from_directory_path(&root)
            .map_err(|_| AppError::new("uri", "Invalid workspace path."))?;
        let file_uri = url::Url::from_file_path(root.join(&path))
            .map_err(|_| AppError::new("uri", "Invalid file path."))?;
        send(&mut input,&json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{"processId":std::process::id(),"rootUri":root_uri,"capabilities":{"general":{"positionEncodings":["utf-16"]},"textDocument":{"definition":{"linkSupport":true}}},"initializationOptions":{"cargo":{"buildScripts":{"enable":false}},"procMacro":{"enable":false},"checkOnSave":false}}})).await?;
        let initialized = response(&mut output, &mut input, 1).await?;
        if initialized["capabilities"]["definitionProvider"] == false
            || initialized["capabilities"]["definitionProvider"].is_null()
        {
            return Err(AppError::new(
                "unsupported_capability",
                "This server does not support go to definition.",
            ));
        }
        send(
            &mut input,
            &json!({"jsonrpc":"2.0","method":"initialized","params":{}}),
        )
        .await?;
        let text = std::fs::read_to_string(root.join(&path))?;
        send(&mut input,&json!({"jsonrpc":"2.0","method":"textDocument/didOpen","params":{"textDocument":{"uri":file_uri,"languageId":match extension { "rs" => "rust", "ts" => "typescript", "tsx" => "typescriptreact", "js" => "javascript", "jsx" => "javascriptreact", other => other },"version":1,"text":text}}})).await?;
        send(&mut input,&json!({"jsonrpc":"2.0","id":2,"method":"textDocument/definition","params":{"textDocument":{"uri":file_uri},"position":{"line":line-1,"character":column-1}}})).await?;
        let value = response(&mut output, &mut input, 2).await?;
        let locations = if value.is_null() {
            vec![]
        } else if let Some(items) = value.as_array() {
            items.clone()
        } else {
            vec![value]
        };
        let mut result = vec![];
        for location in locations {
            let uri = location["uri"]
                .as_str()
                .or_else(|| location["targetUri"].as_str())
                .ok_or_else(|| AppError::new("lsp_protocol", "Missing target URI."))?;
            let file = url::Url::parse(uri)
                .map_err(|_| AppError::new("lsp_protocol", "Invalid target URI."))?
                .to_file_path()
                .map_err(|_| {
                    AppError::new("external_definition", "Definition is not in a local file.")
                })?;
            let relative: PathBuf = file
                .strip_prefix(&root)
                .map_err(|_| {
                    AppError::new(
                        "external_definition",
                        "Definition is outside this frozen snapshot.",
                    )
                })?
                .into();
            let range = location
                .get("targetSelectionRange")
                .or_else(|| location.get("range"))
                .ok_or_else(|| AppError::new("lsp_protocol", "Missing target range."))?;
            result.push(CodeLocation {
                path: relative.to_string_lossy().into(),
                line: range["start"]["line"].as_u64().unwrap_or(0) as u32 + 1,
                column: range["start"]["character"].as_u64().unwrap_or(0) as u32 + 1,
            });
        }
        Ok(result)
    };
    let result = tokio::time::timeout(Duration::from_secs(30), operation)
        .await
        .map_err(|_| {
            AppError::new(
                "lsp_timeout",
                "Language server did not answer within 30 seconds.",
            )
        });
    group.terminate();
    let _ = child.kill().await;
    let _ = child.wait().await;
    result?
}
