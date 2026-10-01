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
    let mut previews = TextPreviews::default();
    let result=async {
        transport.send_text_and_close(prompt).await?;
        stream.emit("status","Waiting for Claude Code…")?;
        loop {let value=transport.next().await?;
            activity(&value, stream)?;
            previews.receive(&value, stream)?;
            if value["type"]=="result" {
                if value["is_error"]==true{return Err(AppError::new("provider_error","Claude could not complete the request. Check CLI authentication and configuration."));}
                let text = value["result"].as_str().ok_or_else(||AppError::new("provider_output", "Claude returned no final response."))?;
                if let Some(preview) = &mut stream.preview { preview.update("result", text); }
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

#[derive(Default)]
struct TextPreviews {
    blocks: BTreeMap<u64, String>,
    message: u64,
}
impl TextPreviews {
    fn receive(&mut self, value: &Value, stream: &mut Stream) -> AppResult<()> {
        if stream.preview.is_none() {
            return Ok(());
        }
        if value["parent_tool_use_id"].is_null() && value["type"] == "stream_event" {
            let event = &value["event"];
            let index = event["index"].as_u64().unwrap_or(0);
            match event["type"].as_str() {
                Some("message_start") => {
                    self.message += 1;
                    self.blocks.clear();
                }
                Some("content_block_start") if event["content_block"]["type"] == "text" => {
                    self.blocks.insert(index, String::new());
                }
                Some("content_block_delta") if event["delta"]["type"] == "text_delta" => {
                    if let Some(text) = self.blocks.get_mut(&index) {
                        let delta = event["delta"]["text"].as_str().unwrap_or_default();
                        if text.len() + delta.len() > 2 * 1024 * 1024 {
                            return Err(AppError::new(
                                "output_limit",
                                "Agent output exceeds 2 MiB.",
                            ));
                        }
                        text.push_str(delta);
                        if let Some(preview) = &mut stream.preview {
                            preview.update(&format!("{}:{index}", self.message), text);
                        }
                    }
                }
                _ => {}
            }
        }
        if value["type"] == "assistant"
            && value["parent_tool_use_id"].is_null()
            && let Some(blocks) = value["message"]["content"].as_array()
        {
            for (index, block) in blocks.iter().enumerate() {
                if block["type"] == "text"
                    && let Some(text) = block["text"].as_str()
                    && let Some(preview) = &mut stream.preview
                {
                    preview.update(&format!("{}:{index}", self.message), text);
                }
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn previews_exclude_child_tool_and_thinking_blocks() {
        let seen = Arc::new(Mutex::new(Vec::new()));
        let output = seen.clone();
        let mut stream = Stream {
            id: "test".into(),
            sequence: 0,
            text: String::new(),
            channel: Channel::new(|_| Ok(())),
            preview: Some(outline_preview::Preview::new(Arc::new(move |items| {
                *output.lock().unwrap() = items;
            }))),
        };
        let mut previews = TextPreviews::default();
        let text = r#"{"items":[{"id":"outline","result":{"topics":[{"title":"Parent","brief":"Context","steps":[{"title":"One"}]}]}}]}"#;
        for kind in ["tool_use", "thinking"] {
            previews.receive(&serde_json::json!({"type":"stream_event","event":{"type":"content_block_start","index":0,"content_block":{"type":kind}}}), &mut stream).unwrap();
            previews.receive(&serde_json::json!({"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":text}}}), &mut stream).unwrap();
            assert!(seen.lock().unwrap().is_empty());
        }
        previews.receive(&serde_json::json!({"type":"assistant","parent_tool_use_id":"child","message":{"content":[{"type":"text","text":text}]}}), &mut stream).unwrap();
        assert!(seen.lock().unwrap().is_empty());
        previews.receive(&serde_json::json!({"type":"assistant","message":{"content":[{"type":"text","text":text}]}}), &mut stream).unwrap();
        assert_eq!(seen.lock().unwrap().len(), 1);
        assert!(
            stream.text.is_empty(),
            "Progress must not contaminate final JSON"
        );
    }
}
