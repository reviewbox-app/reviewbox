//! Vue's protocol bridge is private to a session; no arbitrary server commands reach IPC.
use super::{session::Session, workspace::Workspace};
use crate::contracts::*;
use serde_json::{Value, json};
use std::{
    path::{Path, PathBuf},
    sync::Arc,
};

pub(super) fn private_modules(server: &LanguageServerConfig) -> Option<PathBuf> {
    server.arguments.iter().find_map(|argument| {
        Path::new(argument)
            .ancestors()
            .find(|p| p.file_name().is_some_and(|n| n == "node_modules"))
            .map(Path::to_path_buf)
    })
}
impl Session {
    pub(super) fn accepts_vue_mirrors(&self) -> bool {
        self.server.id == "vue"
            || (self.server.id == "typescript"
                && self
                    .live_initialization_options
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())["plugins"]
                    .as_array()
                    .is_some_and(|plugins| {
                        plugins
                            .iter()
                            .any(|p| p["name"] == "@vue/typescript-plugin")
                    }))
    }
    /// Foreign buffers stay separate from session-owned documents, so closing the last
    /// editor still stops both processes. Never materialize unsaved text on disk.
    pub(super) async fn mirror_document(
        self: &Arc<Self>,
        uri: &str,
        document: &LiveLanguageDocument,
    ) -> AppResult<()> {
        if !self.accepts_vue_mirrors()
            || !matches!(
                document.language_id.as_str(),
                "vue" | "typescript" | "typescriptreact" | "javascript" | "javascriptreact"
            )
        {
            return Ok(());
        }
        let target = if self.server.id == "vue" {
            self.vue_typescript
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .clone()
        } else {
            Some(self.clone())
        };
        let Some(target) = target else {
            return Ok(());
        };
        let mut versions = self.mirrored_documents.lock().await;
        let message = match versions.get(uri) {
            Some(version) if *version >= document.version => return Ok(()),
            Some(_) => {
                json!({"jsonrpc":"2.0","method":"textDocument/didChange","params":{"textDocument":{"uri":uri,"version":document.version},"contentChanges":[{"text":document.text}]}})
            }
            None => {
                json!({"jsonrpc":"2.0","method":"textDocument/didOpen","params":{"textDocument":{"uri":uri,"languageId":document.language_id,"version":document.version,"text":document.text}}})
            }
        };
        target.send_raw(&message).await?;
        versions.insert(uri.into(), document.version);
        Ok(())
    }
    pub(super) async fn close_mirrored_document(self: &Arc<Self>, uri: &str) -> AppResult<()> {
        if self.mirrored_documents.lock().await.remove(uri).is_none() {
            return Ok(());
        }
        let target = if self.server.id == "vue" {
            self.vue_typescript
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .clone()
        } else {
            Some(self.clone())
        };
        if let Some(target) = target {
            target.send_raw(&json!({"jsonrpc":"2.0","method":"textDocument/didClose","params":{"textDocument":{"uri":uri}}})).await?;
        }
        Ok(())
    }
    pub(super) async fn initialize_vue(self: &Arc<Self>) -> AppResult<()> {
        let modules = private_modules(&self.server).ok_or_else(|| {
            AppError::new("vue_sdk", "Reinstall Vue to restore its TypeScript plugin.")
        })?;
        let mut options = self
            .live_initialization_options
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone();
        if !options.is_object() {
            options = json!({});
        }
        let tsdk = options["typescript"]["tsdk"]
            .as_str()
            .map(PathBuf::from)
            .unwrap_or_else(|| modules.join("typescript/lib"));
        let ts = Session::spawn(
            LanguageServerConfig {
                id: "vue-typescript".into(),
                name: "Vue TypeScript adapter".into(),
                extensions: vec!["vue".into()],
                executable: self.server.executable.clone(),
                arguments: vec![
                    modules
                        .join("typescript-language-server/lib/cli.mjs")
                        .to_string_lossy()
                        .into(),
                    "--stdio".into(),
                ],
            },
            Workspace::live(self.workspace.root().to_path_buf()),
            vec![],
        )?;
        *ts.live_initialization_options
            .lock()
            .unwrap_or_else(|e| e.into_inner()) = json!({
            "tsserver":{"path":tsdk.join("tsserver.js")},
            "plugins":[{"name":"@vue/typescript-plugin","location":modules.join("@vue/typescript-plugin"),"languages":["vue"],"configNamespace":"typescript"}],
            "preferences":{"includeCompletionsForModuleExports":true,"includeCompletionsForImportStatements":true,"allowIncompleteCompletions":true},
            "hostInfo":"ReviewBox", "disableAutomaticTypingAcquisition":true
        });
        let parent = Arc::downgrade(self);
        *ts.notifications.lock().unwrap_or_else(|e| e.into_inner()) =
            Some(Arc::new(move |message| {
                if message["method"] == "textDocument/publishDiagnostics"
                    && let Some(parent) = parent.upgrade()
                {
                    let mut params = message["params"].clone();
                    params["reviewboxEngine"] = json!("vue-typescript");
                    tag_items(&mut params["diagnostics"], "typescript");
                    parent.notify("textDocument/publishDiagnostics", params);
                }
            }));
        *ts.live_settings.lock().unwrap_or_else(|e| e.into_inner()) = self.configuration();
        if let Err(error) = ts.initialize_live().await {
            ts.stop();
            return Err(error);
        }
        *self
            .vue_typescript
            .lock()
            .unwrap_or_else(|e| e.into_inner()) = Some(ts);
        Ok(())
    }
    pub(super) fn bridge_vue(self: &Arc<Self>, params: &Value) {
        let ts = self
            .vue_typescript
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone();
        let Some(ts) = ts else { return };
        // string-method JSON-RPC notifications carry the upstream tuple as one argument.
        let tuple = params
            .as_array()
            .filter(|a| a.len() == 1)
            .and_then(|a| a.first())
            .unwrap_or(params);
        let Some(args) = tuple.as_array().filter(|a| a.len() == 3) else {
            return;
        };
        let Some(command) = args[1].as_str().filter(|c| c.starts_with("_vue:")) else {
            return;
        };
        let request_id = args[0].clone();
        let params = json!({"command":"typescript.tsserverRequest","arguments":[command,args[2],{"isAsync":true,"expectsResult":true}]});
        let weak = Arc::downgrade(self);
        tauri::async_runtime::spawn(async move {
            let response = ts
                .rpc("vue-bridge", "workspace/executeCommand", params, None)
                .await;
            if let Some(session) = weak.upgrade() {
                let value = response.map(|v| v["body"].clone()).unwrap_or(Value::Null);
                let _=session.send(&json!({"jsonrpc":"2.0","method":"tsserver/response","params":[[request_id,value]]})).await;
            }
        });
    }
}

pub(super) fn routed_method(method: &str) -> bool {
    matches!(
        method,
        "textDocument/completion"
            | "completionItem/resolve"
            | "textDocument/hover"
            | "textDocument/signatureHelp"
            | "textDocument/definition"
            | "textDocument/references"
            | "textDocument/rename"
            | "textDocument/prepareRename"
            | "textDocument/codeAction"
            | "codeAction/resolve"
            | "textDocument/linkedEditingRange"
    )
}
fn tag_items(value: &mut Value, engine: &str) {
    let values = if value.is_array() {
        value.as_array_mut()
    } else {
        value.get_mut("items").and_then(Value::as_array_mut)
    };
    if let Some(values) = values {
        for item in values {
            let original = item["data"].clone();
            item["data"] = json!({"reviewboxVueEngine":engine,"original":original});
        }
    }
}
fn list(value: Value) -> Vec<Value> {
    if let Some(items) = value.as_array() {
        items.clone()
    } else if value.get("uri").is_some() || value.get("targetUri").is_some() {
        vec![value]
    } else {
        value["items"].as_array().cloned().unwrap_or_default()
    }
}
fn route_diagnostics(params: &mut Value, engine: &str) {
    if let Some(diagnostics) = params["context"]["diagnostics"].as_array_mut() {
        diagnostics.retain_mut(|diagnostic| {
            let origin = diagnostic["data"]["reviewboxVueEngine"]
                .as_str()
                .unwrap_or("vue");
            if origin != engine {
                return false;
            }
            if diagnostic["data"].get("reviewboxVueEngine").is_some() {
                diagnostic["data"] = diagnostic["data"]["original"].clone();
            }
            true
        });
    }
}
impl Session {
    pub(super) async fn vue_rpc(
        &self,
        label: &str,
        method: &str,
        mut params: Value,
        cancelled: Option<&std::sync::atomic::AtomicBool>,
    ) -> AppResult<Value> {
        let Some(ts) = self
            .vue_typescript
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
        else {
            return self.rpc_raw(label, method, params, cancelled).await;
        };
        if matches!(method, "completionItem/resolve" | "codeAction/resolve") {
            let typescript = params["data"]["reviewboxVueEngine"] == "typescript";
            if params["data"].get("reviewboxVueEngine").is_some() {
                params["data"] = params["data"]["original"].clone();
            }
            return if typescript {
                ts.rpc_raw(label, method, params, cancelled).await
            } else {
                self.rpc_raw(label, method, params, cancelled).await
            };
        }
        let mut ts_params = params.clone();
        if method == "textDocument/codeAction" {
            route_diagnostics(&mut params, "vue");
            route_diagnostics(&mut ts_params, "typescript");
        }
        let (vue, typescript) = tokio::join!(
            self.rpc_raw(label, method, params, cancelled),
            ts.rpc_raw(label, method, ts_params, cancelled)
        );
        if vue.is_err() && typescript.is_err() {
            return vue;
        }
        match method {
            "textDocument/completion" | "textDocument/codeAction" => {
                let mut vue = vue.unwrap_or(Value::Null);
                let mut ts = typescript.unwrap_or(Value::Null);
                let incomplete = vue["isIncomplete"] == true || ts["isIncomplete"] == true;
                tag_items(&mut vue, "vue");
                tag_items(&mut ts, "typescript");
                let mut seen = std::collections::BTreeSet::new();
                let items = list(ts)
                    .into_iter()
                    .chain(list(vue))
                    .filter(|i| {
                        seen.insert((
                            i["label"].to_string(),
                            i["title"].to_string(),
                            i["detail"].to_string(),
                        ))
                    })
                    .collect::<Vec<_>>();
                Ok(if method == "textDocument/completion" {
                    json!({"items":items,"isIncomplete":incomplete})
                } else {
                    json!(items)
                })
            }
            "textDocument/definition" | "textDocument/references" => {
                let mut locations = list(typescript.unwrap_or(Value::Null));
                locations.extend(list(vue.unwrap_or(Value::Null)));
                let mut seen = std::collections::BTreeSet::new();
                locations.retain(|v| seen.insert(v.to_string()));
                Ok(json!(locations))
            }
            _ => {
                if let Ok(ts) = typescript
                    && !ts.is_null()
                    && ts["contents"].as_array().is_none_or(|a| !a.is_empty())
                    && !ts.as_array().is_some_and(Vec::is_empty)
                {
                    return Ok(ts);
                }
                vue
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn code_actions_receive_only_their_engines_original_diagnostics() {
        let original = json!({"message":"typescript", "data":{"fixId":"missingImport"}});
        let mut typed = json!([original.clone()]);
        tag_items(&mut typed, "typescript");
        let primary = json!({"message":"template", "data":{"id":42}});
        let mut vue = json!({"context":{"diagnostics":[primary.clone(),typed[0]]}});
        let mut ts = vue.clone();
        route_diagnostics(&mut vue, "vue");
        route_diagnostics(&mut ts, "typescript");
        assert_eq!(vue["context"]["diagnostics"], json!([primary]));
        assert_eq!(ts["context"]["diagnostics"], json!([original]));
    }
}
