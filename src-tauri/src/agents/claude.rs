use super::*;
pub(super) async fn run(
    root: &std::path::Path,
    prompt: &str,
    config: &ProviderConfig,
    cancel: Arc<AtomicBool>,
    stream: &mut Stream,
) -> AppResult<()> {
    let mut command = tokio::process::Command::new(&config.executable);
    // No project/user hooks or MCP servers; all code is supplied in the reviewed context.
    command
        .args([
            "-p",
            "--output-format",
            "stream-json",
            "--verbose",
            "--include-partial-messages",
            "--tools",
            "",
            "--disallowedTools",
            "mcp__*",
            "--strict-mcp-config",
            "--setting-sources",
            "",
            "--settings",
            "{\"disableAllHooks\":true}",
        ])
        .current_dir(root);
    if let Some(model) = config.model.as_ref().filter(|m| !m.is_empty()) {
        command.args(["--model", model]);
    }
    let mut transport = Transport::new(command, cancel)?;
    let result=async {
        transport.input.write_all(prompt.as_bytes()).await?;transport.input.shutdown().await?;
        stream.emit("status","Waiting for Claude Code…")?;
        loop {let value=transport.next().await?;
            if value["type"]=="stream_event" && value["event"]["delta"]["type"]=="text_delta" && let Some(text)=value["event"]["delta"]["text"].as_str(){stream.emit("delta",text)?;}
            if value["type"]=="result" {
                if value["is_error"]==true{return Err(AppError::new("provider_error","Claude could not complete the request. Check CLI authentication and configuration."));}
                if stream.text.is_empty() && let Some(text)=value["result"].as_str(){stream.emit("delta",text)?;}
                return Ok(());
            }
        }
    }.await;
    transport.finish().await;
    result
}
