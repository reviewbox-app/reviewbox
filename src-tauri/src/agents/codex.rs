use super::*;
use serde_json::json;
mod draft;

async fn response(transport: &mut Transport, id: u32) -> AppResult<Value> {
    loop {
        let value = transport.next().await?;
        if value["id"] == id {
            if value.get("error").is_some() {
                return Err(AppError::new(
                    "provider_error",
                    "Codex rejected the request. Check CLI compatibility, authentication and configuration.",
                ));
            }
            return Ok(value["result"].clone());
        }
        handle_request(transport, &value).await?;
    }
}
async fn handle_request(transport: &mut Transport, value: &Value) -> AppResult<()> {
    if value.get("id").is_none() {
        return Ok(());
    }
    let Some(method) = value["method"].as_str() else {
        return Ok(());
    };
    // This runtime is explicitly configured for autonomous tool execution.
    // Approval decisions are local policy, never imported from project files.
    let result = match method {
        "item/commandExecution/requestApproval" | "item/fileChange/requestApproval" => {
            json!({"decision":"accept"})
        }
        "item/permissions/requestApproval" => {
            json!({"permissions":value["params"]["permissions"],"scope":"session"})
        }
        _ => {
            return Err(AppError::new(
                "provider_input",
                format!(
                    "Codex requires interactive input ({method}). The captured review is kept."
                ),
            ));
        }
    };
    transport
        .send(&json!({"id":value["id"],"result":result}))
        .await
}

// Normalize only user-visible work. Raw tool payloads and reasoning never cross IPC.
fn progress(value: &Value) -> Option<AgentProgress> {
    let params = &value["params"];
    let method = value["method"].as_str()?;
    if method == "turn/plan/updated" {
        let steps = params["plan"]
            .as_array()?
            .iter()
            .take(50)
            .filter_map(|step| {
                Some(AgentPlanStep {
                    text: step["step"].as_str()?.chars().take(300).collect(),
                    status: match step["status"].as_str()? {
                        "pending" => AgentPlanStatus::Pending,
                        "inProgress" => AgentPlanStatus::InProgress,
                        "completed" => AgentPlanStatus::Completed,
                        _ => return None,
                    },
                })
            })
            .collect();
        return Some(AgentProgress::Plan { steps });
    }
    let completed = method == "item/completed";
    if !completed && method != "item/started" {
        return None;
    }
    let item = &params["item"];
    let id = item["id"].as_str()?;
    // Do not truncate identities: collisions would merge unrelated activities.
    if id.is_empty() || id.len() > 256 {
        return None;
    }
    let id = id.to_owned();
    let category = match item["type"].as_str()? {
        "agentMessage" if item["phase"] == "commentary" && completed => {
            let text = item["text"].as_str()?;
            if text.trim().is_empty() {
                return None;
            }
            return Some(AgentProgress::Message {
                id,
                text: text.chars().take(4000).collect(),
            });
        }
        "agentMessage" if item["phase"] == "final_answer" => AgentActivityKind::Draft,
        "commandExecution" => {
            let actions = item["commandActions"].as_array();
            // A mixed command remains a general action; never guess from shell text.
            let kind = actions.and_then(|actions| {
                let first = actions.first()?["type"].as_str()?;
                actions
                    .iter()
                    .all(|action| action["type"] == first)
                    .then_some(first)
            });
            match kind {
                Some("read") => AgentActivityKind::Read,
                Some("search") => AgentActivityKind::Search,
                Some("listFiles") => AgentActivityKind::ListFiles,
                _ => AgentActivityKind::Command,
            }
        }
        "mcpToolCall" | "dynamicToolCall" => AgentActivityKind::Tool,
        "fileChange" => AgentActivityKind::FileChange,
        "webSearch" => AgentActivityKind::WebSearch,
        "contextCompaction" => AgentActivityKind::Compaction,
        _ => return None,
    };
    let status = if !completed {
        AgentActivityStatus::InProgress
    } else {
        match item["status"].as_str() {
            Some("failed" | "declined") => AgentActivityStatus::Failed,
            Some("interrupted" | "cancelled") => AgentActivityStatus::Interrupted,
            _ if item["exitCode"].as_i64().is_some_and(|code| code != 0)
                || item["success"] == false
                || item.get("error").is_some_and(|error| !error.is_null()) =>
            {
                AgentActivityStatus::Failed
            }
            _ => AgentActivityStatus::Completed,
        }
    };
    Some(AgentProgress::Activity {
        id,
        category,
        status,
    })
}

#[derive(Default)]
struct Messages {
    drafts: HashMap<String, draft::Draft>,
    partial: HashMap<String, String>,
    last_id: String,
    final_text: Option<String>,
    last_completed: Option<String>,
}
impl Messages {
    fn receive(&mut self, value: &Value, stream: &mut Stream) -> AppResult<()> {
        if let Some(event) = progress(value) {
            stream.progress(event)?;
        }
        let params = &value["params"];
        let item = &params["item"];
        if value["method"] == "item/started"
            && item["type"] == "agentMessage"
            && item["phase"] == "final_answer"
            && let Some(id) = item["id"].as_str()
        {
            self.drafts.entry(id.to_owned()).or_default();
        }
        if value["method"] == "item/agentMessage/delta" {
            let id = params["itemId"].as_str().unwrap_or("message").to_owned();
            if let Some(text) = params["delta"].as_str() {
                let partial = self.partial.entry(id.clone()).or_default();
                if partial.len() + text.len() > 2 * 1024 * 1024 {
                    return Err(AppError::new("output_limit", "Agent output exceeds 2 MiB."));
                }
                partial.push_str(text);
                if let Some(draft) = self.drafts.get_mut(&id)
                    && let Some(event) = draft.update(partial, false)
                {
                    stream.progress(event)?;
                }
                self.last_id = id;
            }
        }
        if value["method"] == "item/completed"
            && item["type"] == "agentMessage"
            && let Some(text) = item["text"].as_str()
        {
            if item["phase"] == "final_answer" {
                let id = item["id"].as_str().unwrap_or("message");
                let mut draft = if self
                    .partial
                    .get(id)
                    .is_some_and(|partial| text.starts_with(partial))
                {
                    self.drafts.remove(id).unwrap_or_default()
                } else {
                    draft::Draft::default()
                };
                if let Some(event) = draft.update(text, true) {
                    stream.progress(event)?;
                }
                self.final_text = Some(text.into());
            } else if item["phase"] != "commentary" {
                self.last_completed = Some(text.into());
            }
            if item["phase"] == "commentary" {
                if let Some(id) = item["id"].as_str() {
                    self.partial.remove(id);
                }
                stream.emit("status", &text.chars().take(280).collect::<String>())?;
            }
        }
        if value["method"] == "item/started" {
            let status = match item["type"].as_str() {
                Some("commandExecution") => "Codex is exploring the project with a command…",
                Some("mcpToolCall" | "dynamicToolCall") => "Codex is using a project tool…",
                Some("fileChange") => "Codex is working with project files…",
                Some("contextCompaction") => {
                    "Codex is compacting its context; exploration continues…"
                }
                Some("webSearch") => "Codex is searching for supporting context…",
                _ => return Ok(()),
            };
            stream.emit("status", status)?;
        }
        Ok(())
    }
    fn finish(self) -> AppResult<String> {
        self.final_text
            .or(self.last_completed)
            .or_else(|| self.partial.get(&self.last_id).cloned())
            .filter(|text| !text.trim().is_empty())
            .ok_or_else(|| AppError::new("provider_output", "Codex returned no final response."))
    }
}

pub(super) async fn run(
    root: &std::path::Path,
    prompt: &str,
    config: &ProviderConfig,
    cancel: Arc<AtomicBool>,
    stream: &mut Stream,
) -> AppResult<()> {
    providers::require_codex_version(config).await?;
    let effort = models::effort(config, cancel.clone()).await?;
    // Protocol inspection never writes generated files into the user's project.
    let protocol = tempfile::tempdir()?;
    let generated = tokio::time::timeout(
        Duration::from_secs(15),
        tokio::process::Command::new(providers::resolve_executable(&config.executable))
            .args([
                "app-server",
                "generate-json-schema",
                "--experimental",
                "--out",
            ])
            .arg(protocol.path())
            .kill_on_drop(true)
            .output(),
    )
    .await
    .map_err(|_| AppError::new("timeout", "Codex capability detection timed out."))??;
    if !generated.status.success() {
        return Err(AppError::new(
            "incompatible_provider",
            "Cannot inspect this Codex executable's protocol.",
        ));
    }
    let schema: Value = serde_json::from_slice(&std::fs::read(
        protocol.path().join("v2/ThreadStartParams.json"),
    )?)?;
    let supported = schema["definitions"]["SandboxMode"]["enum"]
        .as_array()
        .is_some_and(|values| values.iter().any(|value| value == "danger-full-access"));
    if !supported {
        return Err(AppError::new(
            "incompatible_provider",
            "This Codex executable does not expose the full-access session policy required by Rev.",
        ));
    }
    let ephemeral = &schema["properties"]["ephemeral"]["type"];
    if ephemeral != "boolean"
        && !ephemeral
            .as_array()
            .is_some_and(|types| types.iter().any(|kind| kind == "boolean"))
    {
        return Err(AppError::new(
            "incompatible_provider",
            "This Codex executable does not support ephemeral sessions. Update it in Settings > Rev.",
        ));
    }
    let mut command =
        tokio::process::Command::new(providers::resolve_executable(&config.executable));
    command
        .args(["app-server", "--listen", "stdio://"])
        .current_dir(root);
    let mut transport = Transport::new(command, cancel)?;
    let result = async {
        transport.send(&json!({"id":1,"method":"initialize","params":{"clientInfo":{"name":"reviewbox","title":"ReviewBox","version":env!("CARGO_PKG_VERSION")}}})).await?;
        response(&mut transport, 1).await?;
        transport.send(&json!({"method":"initialized","params":{}})).await?;
        transport.send(&json!({"id":2,"method":"thread/start","params":{
            "cwd":root,"approvalPolicy":"never","sandbox":"danger-full-access",
            "serviceName":"reviewbox","model":config.model,"ephemeral":true
        }})).await?;
        let started = response(&mut transport, 2).await?;
        if started["thread"]["ephemeral"] != true {
            return Err(AppError::new("incompatible_provider", "Codex did not confirm an ephemeral session. The review request was not sent."));
        }
        let thread = started["thread"]["id"].as_str().ok_or_else(|| AppError::new("protocol", "Codex did not provide a thread ID."))?;
        stream.emit("status", "Codex is exploring the project…")?;
        let mut turn = json!({"id":3,"method":"turn/start","params":{
            "threadId":thread,"input":[{"type":"text","text":prompt}],
            "approvalPolicy":"never","sandboxPolicy":{"type":"dangerFullAccess"}
        }});
        if let Some(effort) = effort { turn["params"]["effort"] = json!(effort); }
        transport.send(&turn).await?;
        let mut messages = Messages::default();
        loop {
            let value = transport.next().await?;
            handle_request(&mut transport, &value).await?;
            if value.get("error").is_some() {
                return Err(AppError::new("provider_error", "Codex rejected the review request."));
            }
            messages.receive(&value, stream)?;
            if value["method"] == "turn/completed" {
                if value["params"]["turn"]["status"] != "completed" {
                    return Err(AppError::new("provider_error", "Codex did not complete this turn."));
                }
                stream.emit("delta", &messages.finish()?)?;
                return Ok(());
            }
        }
    }.await;
    transport.finish().await;
    result
}

#[cfg(test)]
mod progress_tests {
    use super::*;

    fn event(method: &str, item: Value) -> Value {
        json!({"method": method, "params": {"item": item}})
    }
    #[test]
    fn maps_plans_and_real_action_outcomes_without_raw_payloads() {
        let plan = json!({"method":"turn/plan/updated","params":{"plan":[
            {"step":"Inspect changes","status":"completed"},
            {"step":"Prepare topics","status":"inProgress"},
            {"step":"Unsupported","status":"unknown"}
        ]}});
        let normalized = serde_json::to_value(progress(&plan).unwrap()).unwrap();
        assert_eq!(normalized["steps"].as_array().unwrap().len(), 2);
        assert_eq!(normalized["steps"][1]["status"], "inProgress");
        for (status, code, expected) in [
            ("completed", 0, "completed"),
            ("completed", 1, "failed"),
            ("failed", 0, "failed"),
            ("interrupted", 0, "interrupted"),
        ] {
            let item = json!({"type":"commandExecution","id":"read-1","status":status,
                "exitCode":code,"command":"secret raw command","aggregatedOutput":"raw output",
                "commandActions":[{"type":"read"}]});
            let started =
                serde_json::to_value(progress(&event("item/started", item.clone())).unwrap())
                    .unwrap();
            assert_eq!(started["status"], "inProgress");
            let done =
                serde_json::to_value(progress(&event("item/completed", item)).unwrap()).unwrap();
            assert_eq!(
                done,
                json!({"type":"activity","id":"read-1","category":"read","status":expected})
            );
        }
        assert!(
            progress(&event(
                "item/started",
                json!({"id":"r","type":"reasoning","text":"private"})
            ))
            .is_none()
        );
        assert!(
            progress(&event(
                "item/started",
                json!({"id":"r","type":"futureTool"})
            ))
            .is_none()
        );
    }

    #[test]
    fn separates_commentary_and_final_output_and_preserves_item_identity() {
        let received = Arc::new(Mutex::new(Vec::<AgentEvent>::new()));
        let output = received.clone();
        let channel = Channel::new(move |body| {
            let tauri::ipc::InvokeResponseBody::Json(text) = body else {
                panic!("expected JSON")
            };
            output
                .lock()
                .unwrap()
                .push(serde_json::from_str(&text).unwrap());
            Ok(())
        });
        let mut stream = Stream {
            id: "run".into(),
            sequence: 0,
            channel,
            text: String::new(),
        };
        let mut messages = Messages::default();
        for id in ["one", "two"] {
            messages
                .receive(
                    &event("item/started", json!({"id":id,"type":"webSearch"})),
                    &mut stream,
                )
                .unwrap();
        }
        messages
            .receive(
                &event("item/completed", json!({"id":"two","type":"webSearch"})),
                &mut stream,
            )
            .unwrap();
        messages.receive(&event("item/completed", json!({"id":"comment","type":"agentMessage","phase":"commentary","text":"**Inspecting** changes"})), &mut stream).unwrap();
        messages.receive(&event("item/completed", json!({"id":"final","type":"agentMessage","phase":"final_answer","text":"{\"kind\":\"topics\",\"topics\":[]}"})), &mut stream).unwrap();
        assert!(stream.text.is_empty());
        assert_eq!(
            messages.finish().unwrap(),
            "{\"kind\":\"topics\",\"topics\":[]}"
        );
        let events = received.lock().unwrap();
        assert!(
            events
                .windows(2)
                .all(|pair| pair[1].sequence > pair[0].sequence)
        );
        assert!(events.iter().any(|event| matches!(&event.progress, Some(AgentProgress::Message { text, .. }) if text == "**Inspecting** changes")));
        assert!(events.iter().any(|event| matches!(&event.progress, Some(AgentProgress::Activity { id, status: AgentActivityStatus::Completed, .. }) if id == "two")));
    }
}
