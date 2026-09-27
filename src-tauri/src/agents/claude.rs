use super::*;
pub(super) async fn run(
    root: &std::path::Path,
    prompt: &str,
    config: &ProviderConfig,
    cancel: Arc<AtomicBool>,
    stream: &mut Stream,
) -> AppResult<()> {
    let effort = models::effort(config, cancel.clone()).await?;
    let mut command =
        tokio::process::Command::new(providers::resolve_executable(&config.executable));
    // The harness owns discovery, context compaction and its configured tools.
    // Full tool execution is the locally chosen ReviewBox runtime policy.
    command
        .args([
            "-p",
            "--output-format",
            "stream-json",
            "--verbose",
            "--include-partial-messages",
            "--no-session-persistence",
            "--permission-mode",
            "bypassPermissions",
        ])
        .current_dir(root);
    if let Some(model) = config.model.as_ref().filter(|m| !m.is_empty()) {
        command.args(["--model", model]);
    }
    if let Some(effort) = effort {
        command.args(["--effort", effort]);
    }
    let mut transport = Transport::new(command, cancel)?;
    let result=async {
        transport.send_text_and_close(prompt).await?;
        stream.emit("status","Waiting for Claude Code…")?;
        loop {let value=transport.next().await?;
            activity(&value, stream)?;
            if value["type"]=="result" {
                if value["is_error"]==true{return Err(AppError::new("provider_error","Claude could not complete the request. Check CLI authentication and configuration."));}
                let text = value["result"].as_str().ok_or_else(||AppError::new("provider_output", "Claude returned no final response."))?;
                stream.emit("delta",text)?;
                return Ok(());
            }
        }
    }.await;
    transport.finish().await;
    result
}

fn activity(value: &Value, stream: &mut Stream) -> AppResult<()> {
    if value["type"] == "system" && value["subtype"] == "compact_boundary" {
        stream.emit(
            "status",
            "Claude Code compacted its context; exploration continues…",
        )?;
    }
    if value["type"] == "stream_event" {
        let event = &value["event"];
        if event["type"] == "content_block_start" && event["content_block"]["type"] == "tool_use" {
            if let Some(name) = event["content_block"]["name"].as_str() {
                stream.emit("status", &format!("Claude Code is using {name}…"))?;
            }
        } else if event["delta"]["type"] == "text_delta" {
            // Intermediate assistant turns are progress, never the JSON result.
            stream.emit("status", "Claude Code is analysing the review…")?;
        }
    }
    Ok(())
}
