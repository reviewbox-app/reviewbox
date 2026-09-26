use super::*;
use serde_json::json;
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
        deny_request(transport, &value).await?;
    }
}
async fn deny_request(transport: &mut Transport, value: &Value) -> AppResult<()> {
    if value.get("method").is_some() && value.get("id").is_some() {
        let result = if value["method"]
            .as_str()
            .is_some_and(|s| s.ends_with("requestApproval"))
        {
            json!({"decision":"decline"})
        } else {
            json!({})
        };
        transport
            .send(&json!({"id":value["id"],"result":result}))
            .await?;
    }
    Ok(())
}
pub(super) async fn run(
    root: &std::path::Path,
    prompt: &str,
    config: &ProviderConfig,
    cancel: Arc<AtomicBool>,
    stream: &mut Stream,
) -> AppResult<()> {
    // Older servers silently ignore unknown sandbox fields. Fail before starting a
    // model unless this executable advertises restricted read roots.
    let schema_dir = root.join("protocol");
    let generated = tokio::time::timeout(
        std::time::Duration::from_secs(15),
        tokio::process::Command::new(&config.executable)
            .args(["app-server", "generate-json-schema", "--out"])
            .arg(&schema_dir)
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
    let schema: Value =
        serde_json::from_slice(&std::fs::read(schema_dir.join("v2/TurnStartParams.json"))?)?;
    let policies = schema["definitions"]["SandboxPolicy"]["oneOf"].as_array();
    let restricted = policies.is_some_and(|items| {
        items.iter().any(|item| {
            item["properties"]["type"]["enum"][0] == "readOnly"
                && item["properties"].get("access").is_some()
        })
    });
    if !restricted {
        return Err(AppError::new(
            "incompatible_provider",
            "This Codex version does not advertise restricted read access. Update Codex before connecting it to ReviewBox.",
        ));
    }
    let mut command = tokio::process::Command::new(&config.executable);
    command
        .args([
            "app-server",
            "--listen",
            "stdio://",
            "-c",
            "mcp_servers={}",
            "-c",
            "web_search=\"disabled\"",
        ])
        .current_dir(root);
    let mut transport = Transport::new(command, cancel)?;
    let result=async {
        transport.send(&json!({"id":1,"method":"initialize","params":{"clientInfo":{"name":"reviewbox","title":"ReviewBox","version":env!("CARGO_PKG_VERSION")}}})).await?;
        response(&mut transport,1).await?;transport.send(&json!({"method":"initialized","params":{}})).await?;
        transport.send(&json!({"id":2,"method":"thread/start","params":{"cwd":root,"approvalPolicy":"untrusted","sandbox":"read-only","ephemeral":true,"serviceName":"reviewbox","model":config.model}})).await?;
        let started=response(&mut transport,2).await?;let thread=started["thread"]["id"].as_str().ok_or_else(||AppError::new("protocol","Codex did not provide a thread ID."))?;
        stream.emit("status","Reading the supplied snapshot context…")?;
        transport.send(&json!({"id":3,"method":"turn/start","params":{"threadId":thread,"input":[{"type":"text","text":prompt}],"approvalPolicy":"untrusted","sandboxPolicy":{"type":"readOnly","access":{"type":"restricted","includePlatformDefaults":true,"readableRoots":[root]}}}})).await?;
        loop{let value=transport.next().await?;deny_request(&mut transport,&value).await?;
            if value.get("error").is_some(){return Err(AppError::new("provider_error","Codex rejected the read-only request."));}
            if value["method"]=="item/agentMessage/delta" && let Some(text)=value["params"]["delta"].as_str(){stream.emit("delta",text)?;}
            if value["method"]=="turn/completed" {if value["params"]["turn"]["status"]!="completed"{return Err(AppError::new("provider_error","Codex did not complete this turn."));}return Ok(());}
        }
    }.await;
    transport.finish().await;
    result
}
