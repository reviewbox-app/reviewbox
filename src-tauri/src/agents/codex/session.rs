//! One owned app-server, with isolated ephemeral threads for successive batches.
use super::*;
use std::collections::HashMap;

pub(in crate::agents) struct Session {
    transport: Transport,
    next_id: u32,
    preparation_tools: Option<Value>,
    root: PathBuf,
    config: ProviderConfig,
    prepared: Prepared,
    pub(in crate::agents) reusable: bool,
}
fn failure(value: &Value) -> AppError {
    let error = &value["error"];
    let info = &error["codexErrorInfo"];
    let http = info.as_object().and_then(|object| {
        object
            .values()
            .find_map(|value| value["httpStatusCode"].as_u64())
    });
    let code = match (info.as_str(), http) {
        (Some("usageLimitExceeded" | "sessionBudgetExceeded"), _) => "provider_quota",
        (Some("unauthorized"), _) | (_, Some(401 | 403)) => "provider_authentication",
        (Some("rateLimitExceeded" | "serverOverloaded"), _) | (_, Some(429 | 503)) => {
            "provider_rate_limit"
        }
        _ => "provider_error",
    };
    AppError::new(
        code,
        "Codex could not complete the request. Completed preparation results are kept.",
    )
    .with_details(super::error_details(error))
}
impl Session {
    pub(in crate::agents) fn preparation_tools(&mut self, configuration: Value) {
        self.transport.read_only = true;
        self.preparation_tools = Some(configuration);
    }
    pub(in crate::agents) fn read_only(&mut self) {
        self.transport.read_only = true;
    }
    pub(in crate::agents) async fn start(
        root: &std::path::Path,
        config: &ProviderConfig,
        prepared: Prepared,
        cancel: Arc<AtomicBool>,
    ) -> AppResult<Self> {
        Self::start_with_delegation(root, config, prepared, cancel, true).await
    }
    pub(in crate::agents) async fn start_with_delegation(
        root: &std::path::Path,
        config: &ProviderConfig,
        prepared: Prepared,
        cancel: Arc<AtomicBool>,
        allow_delegation: bool,
    ) -> AppResult<Self> {
        let mut command = providers::command(&providers::resolve_executable(&config.executable));
        command
            .args(["app-server", "--listen", "stdio://"])
            .current_dir(root);
        if let Some(helper) = &prepared.helper {
            command
                .args([
                    "-c",
                    "agents.enabled=true",
                    "-c",
                    "agents.max_concurrent_threads_per_session=3",
                    "-c",
                ])
                .arg(format!(
                    "agents.default_subagent_reasoning_effort={}",
                    serde_json::to_string(&prepared.helper_effort)?
                ))
                .arg("-c")
                .arg(format!(
                    "agents.default_subagent_model={}",
                    serde_json::to_string(helper)?
                ));
        }
        if !allow_delegation {
            command.args(["-c", "agents.enabled=false"]);
        }
        let mut transport = Transport::new(command, cancel)?;
        transport.send(&json!({"id":1,"method":"initialize","params":{"clientInfo":{"name":"reviewbox","title":"ReviewBox","version":env!("CARGO_PKG_VERSION")}}})).await?;
        response(&mut transport, 1).await?;
        transport
            .send(&json!({"method":"initialized","params":{}}))
            .await?;
        Ok(Self {
            transport,
            next_id: 2,
            preparation_tools: None,
            root: root.into(),
            config: config.clone(),
            prepared,
            reusable: true,
        })
    }
    async fn request(&mut self, method: &str, params: Value) -> AppResult<Value> {
        let id = self.next_id;
        self.next_id += 1;
        self.transport
            .send(&json!({"id":id,"method":method,"params":params}))
            .await?;
        response(&mut self.transport, id).await
    }
    pub(in crate::agents) async fn run(
        &mut self,
        prompt: &str,
        schema: Option<Value>,
        stream: &mut Stream,
    ) -> AppResult<()> {
        let mut start = json!({"cwd":self.root,"approvalPolicy":"never","sandbox":if self.transport.read_only { "read-only" } else { "danger-full-access" },"serviceName":"reviewbox","model":self.config.model,"ephemeral":true});
        if self.transport.read_only {
            let effective = self
                .request(
                    "config/read",
                    json!({"cwd": self.root, "includeLayers": false}),
                )
                .await?;
            start["config"] = planning_configuration(&effective["config"]);
            if let Some(configuration) = &self.preparation_tools {
                start["config"]["features.shell_tool"] = json!(false);
                start["config"]["agents.enabled"] = json!(true);
                start["config"]["features.multi_agent"] = json!(true);
                start["config"]["mcp_servers"]["reviewbox_preparation"] = configuration.clone();
                for name in [
                    "review_state",
                    "review_source",
                    "review_read_document",
                    "review_search",
                    "review_context_assess",
                    "review_activity",
                    "review_plan",
                    "review_document",
                    "review_decide",
                    "review_finish",
                ] {
                    start["config"]["mcp_servers"]["reviewbox_preparation"]["tools"][name] =
                        json!({"approval_mode":"approve"});
                }
            }
        }
        let started = self.request("thread/start", start).await?;
        if started["thread"]["ephemeral"] != true {
            return Err(AppError::new(
                "incompatible_provider",
                "Codex did not confirm an ephemeral session.",
            ));
        }
        let thread = started["thread"]["id"]
            .as_str()
            .ok_or_else(|| AppError::new("protocol", "Missing Codex thread ID."))?
            .to_owned();
        let turn_request = self.next_id;
        self.next_id += 1;
        let mut params = json!({"threadId":thread,"input":[{"type":"text","text":prompt}],"approvalPolicy":"never","sandboxPolicy":{"type":if self.transport.read_only { "readOnly" } else { "dangerFullAccess" }}});
        if let Some(effort) = &self.prepared.effort {
            params["effort"] = json!(effort);
        }
        if let Some(schema) = schema {
            params["outputSchema"] = schema;
        }
        self.transport
            .send(&json!({"id":turn_request,"method":"turn/start","params":params}))
            .await?;
        let mut messages = Messages::default();
        let mut turn_id = None;
        let mut pending = Vec::new();
        let mut children = HashMap::new();
        let mut child_reads: HashMap<u32, String> = HashMap::new();
        loop {
            let value = if turn_id.is_some() && !pending.is_empty() {
                pending.remove(0)
            } else {
                self.transport.next().await?
            };
            if value["id"] == turn_request {
                if value.get("error").is_some() {
                    return Err(failure(&value));
                }
                turn_id = Some(
                    value["result"]["turn"]["id"]
                        .as_str()
                        .ok_or_else(|| AppError::new("protocol", "Missing Codex turn ID."))?
                        .to_owned(),
                );
                continue;
            }
            if let Some(rpc) = value["id"].as_u64()
                && let Ok(rpc) = u32::try_from(rpc)
                && let Some(child) = child_reads.remove(&rpc)
            {
                if let Some(model) = value["result"]["thread"]["model"].as_str() {
                    stream.progress(AgentProgress::Delegation {
                        id: child.clone(),
                        parent: thread.clone(),
                        task: "Delegated preparation work".into(),
                        model: Some(model.into()),
                        status: children
                            .get(&child)
                            .cloned()
                            .unwrap_or(AgentActivityStatus::InProgress),
                    })?;
                }
                continue;
            }
            let params = &value["params"];
            // Current Codex also reports delegation through child thread metadata
            // and subAgentActivity, independently of collab tool call items.
            if value["method"] == "thread/started"
                && params["thread"]["source"]["subAgent"]["thread_spawn"]["parent_thread_id"]
                    == thread
                && let Some(child) = params["thread"]["id"].as_str()
            {
                children.insert(child.to_owned(), AgentActivityStatus::InProgress);
                stream.progress(AgentProgress::Delegation {
                    id: child.into(),
                    parent: thread.clone(),
                    task: "Delegated preparation work".into(),
                    model: params["thread"]["model"].as_str().map(str::to_owned),
                    status: AgentActivityStatus::InProgress,
                })?;
                continue;
            }
            // Never accept final JSON or completion from a descendant or an old turn.
            if params["threadId"] != thread {
                if params["threadId"]
                    .as_str()
                    .is_some_and(|id| children.contains_key(id))
                {
                    handle_request(&mut self.transport, &value).await?;
                }
                continue;
            }
            if value["method"] == "thread/tokenUsage/updated" {
                let usage = &params["tokenUsage"]["total"];
                stream.progress(AgentProgress::Usage {
                    id: thread.clone(),
                    input: usage["inputTokens"].as_u64().unwrap_or(0),
                    cached: usage["cachedInputTokens"].as_u64().unwrap_or(0),
                    output: usage["outputTokens"].as_u64().unwrap_or(0),
                })?;
            }
            if turn_id.is_none() {
                if pending.len() >= 100 {
                    return Err(AppError::new(
                        "protocol",
                        "Codex did not acknowledge the turn.",
                    ));
                }
                pending.push(value);
                continue;
            }
            let current_turn = turn_id.as_deref().unwrap_or_default();
            let event_turn = params["turnId"]
                .as_str()
                .or_else(|| params["turn"]["id"].as_str());
            if event_turn != Some(current_turn) {
                continue;
            }
            handle_request(&mut self.transport, &value).await?;
            if value["method"] == "error" && params["willRetry"] != true {
                return Err(failure(params));
            }
            let item = &params["item"];
            if item["type"] == "subAgentActivity"
                && let Some(child) = item["agentThreadId"].as_str()
            {
                if !children.contains_key(child) {
                    // Read only metadata; some CLI versions never emit a child's
                    // thread/started notification or its requested spawn model.
                    let rpc = self.next_id;
                    self.next_id += 1;
                    self.transport.send(&json!({"id":rpc,"method":"thread/read","params":{"threadId":child,"includeTurns":false}})).await?;
                    child_reads.insert(rpc, child.to_owned());
                }
                let status = match item["kind"].as_str() {
                    Some("completed") => AgentActivityStatus::Completed,
                    Some("interrupted") => AgentActivityStatus::Interrupted,
                    Some("started" | "interacted") => AgentActivityStatus::InProgress,
                    _ => continue,
                };
                children.insert(child.to_owned(), status.clone());
                stream.progress(AgentProgress::Delegation {
                    id: child.into(),
                    parent: thread.clone(),
                    task: item["agentPath"]
                        .as_str()
                        .and_then(|path| path.rsplit('/').next())
                        .filter(|name| !name.is_empty())
                        .map(|name| name.chars().take(160).collect())
                        .unwrap_or_else(|| "Delegated preparation work".into()),
                    model: None,
                    status,
                })?;
            }
            if item["type"] == "collabAgentToolCall"
                && let Some(ids) = item["receiverThreadIds"].as_array()
            {
                for child in ids.iter().filter_map(Value::as_str) {
                    let state = item["agentsStates"][child]["status"]
                        .as_str()
                        .unwrap_or("running");
                    let status = match state {
                        "completed" => AgentActivityStatus::Completed,
                        "shutdown"
                            if matches!(
                                children.get(child),
                                Some(AgentActivityStatus::Completed)
                            ) =>
                        {
                            AgentActivityStatus::Completed
                        }
                        "shutdown" | "interrupted" => AgentActivityStatus::Interrupted,
                        "errored" | "notFound" => AgentActivityStatus::Failed,
                        _ => AgentActivityStatus::InProgress,
                    };
                    children.insert(child.to_owned(), status.clone());
                    let task = item["prompt"]
                        .as_str()
                        .and_then(|prompt| prompt.lines().next())
                        .and_then(|line| line.strip_prefix("Task: "))
                        .filter(|title| !title.trim().is_empty())
                        .map(|title| title.chars().take(160).collect())
                        .unwrap_or_else(|| "Delegated preparation work".into());
                    stream.progress(AgentProgress::Delegation {
                        id: child.into(),
                        parent: thread.clone(),
                        task,
                        model: item["model"].as_str().map(str::to_owned),
                        status,
                    })?;
                }
            }
            messages.receive(&value, stream)?;
            if value["method"] == "turn/completed" {
                if params["turn"]["status"] != "completed" {
                    return Err(failure(&params["turn"]));
                }
                // Only an explicit final_answer on the matching root turn is a batch result.
                let text = messages.final_text.ok_or_else(|| {
                    AppError::new(
                        "provider_output",
                        "Codex returned no final answer for this batch.",
                    )
                })?;
                #[cfg(test)]
                if std::env::var_os("REVIEWBOX_REAL_PROVIDER").is_some() {
                    eprintln!("Real harness final: {text}");
                }
                stream.emit("delta", &text)?;
                if self.prepared.helper.is_some() {
                    for (child, status) in children {
                        if self.unload(&child).await.is_err() {
                            self.reusable = false;
                        }
                        if matches!(status, AgentActivityStatus::InProgress) {
                            stream.progress(AgentProgress::Delegation {
                                id: child,
                                parent: thread.clone(),
                                task: "Delegated preparation work".into(),
                                model: None,
                                status: AgentActivityStatus::Interrupted,
                            })?;
                        }
                    }
                    if self.unload(&thread).await.is_err() {
                        self.reusable = false;
                    }
                    if !self.reusable {
                        self.finish().await;
                    }
                }
                return Ok(());
            }
        }
    }
    async fn unload(&mut self, thread: &str) -> AppResult<()> {
        let result = tokio::time::timeout(
            Duration::from_secs(5),
            self.request("thread/unsubscribe", json!({"threadId":thread})),
        )
        .await
        .map_err(|_| AppError::new("provider_cleanup", "Codex session cleanup timed out."))??;
        if !matches!(
            result["status"].as_str(),
            Some("unsubscribed" | "notLoaded")
        ) {
            return Err(AppError::new(
                "provider_cleanup",
                "Codex could not confirm thread cleanup.",
            ));
        }
        Ok(())
    }
    pub(in crate::agents) async fn finish(&mut self) {
        self.transport.finish().await;
    }
}

/// Read-only filesystem sandbox plus no out-of-sandbox connectors or delegated tools.
fn planning_configuration(effective: &Value) -> Value {
    let mut config = json!({"features.apps": false, "features.plugins": false, "features.multi_agent": false, "agents.enabled": false, "apps._default.enabled": false, "web_search": "disabled", "features.web_search_request": false});
    for category in ["mcp_servers", "plugins", "apps"] {
        if let Some(entries) = effective[category].as_object() {
            // App-server splits override paths on dots; it does not parse TOML
            // quoting. Nested objects preserve literal connector names and merge
            // only this flag into their existing transport configuration.
            config[category] = entries
                .keys()
                .map(|name| (name.clone(), json!({"enabled": false})))
                .collect::<serde_json::Map<String, Value>>()
                .into();
        }
    }
    config
}
#[cfg(test)]
mod planning_tests {
    use super::*;
    #[test]
    fn provider_failure_keeps_actionable_details_without_credentials_or_rpc_payloads() {
        let error = failure(&json!({"error": {
            "message": "Request failed, HTTP 403; Authorization: Bearer private-token",
            "codexErrorInfo": {"httpConnectionFailed":{"httpStatusCode":403}},
            "code": -32000,
            "data": {"prompt": "private-source-sentinel"}
        }}));
        assert_eq!(error.code, "provider_authentication");
        let details = error.details.unwrap();
        assert!(details.contains("HTTP 403"));
        assert!(details.contains("-32000"));
        assert!(!details.contains("private-token"));
        assert!(!details.contains("private-source-sentinel"));
    }
    #[test]
    fn disables_configured_connectors_and_delegation_without_writing_preferences() {
        let source = json!({"mcp_servers":{"files":{"command":"test"}, "files.with.dots":{"url":"https://example.test/mcp"}},"apps":{"writer":{"enabled":true}},"plugins":{"tool@local":{"enabled":true}}});
        let config = planning_configuration(&source);
        assert_eq!(config["mcp_servers"]["files"], json!({"enabled": false}));
        assert_eq!(
            config["mcp_servers"]["files.with.dots"],
            json!({"enabled": false})
        );
        assert_eq!(config["apps"]["writer"]["enabled"], false);
        assert_eq!(config["plugins"]["tool@local"]["enabled"], false);
        assert_eq!(config["features.multi_agent"], false);
        assert_eq!(source["apps"]["writer"]["enabled"], true);
    }
}
