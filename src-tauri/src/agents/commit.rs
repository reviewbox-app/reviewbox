//! The helper plans commits; only source_control executes Git mutations.
use super::*;

pub(crate) async fn plan(
    storage: &Storage,
    root: &std::path::Path,
    resources: &std::path::Path,
    request: &GitCommitRequest,
    context: String,
    cancel: Arc<AtomicBool>,
    channel: Channel<AgentEvent>,
) -> AppResult<String> {
    let settings = settings(storage)?;
    let project = storage.project_settings(&request.repository_id)?;
    let provider = project
        .provider
        .as_deref()
        .unwrap_or(&settings.default_provider);
    let mut config = settings
        .providers
        .iter()
        .find(|c| c.provider == provider)
        .cloned()
        .ok_or_else(|| AppError::new("provider", "Configure the project's harness first."))?;
    config.model = Some(if provider == "codex" {
        settings.helper_model
    } else {
        "claude-sonnet-5".into()
    });
    let template = std::fs::read_to_string(resources.join("prompts/commit.md"))?;
    let prompt = prompts::render(&template, &BTreeMap::from([("context".into(), context)]))?;
    let mut stream = Stream {
        id: request.operation_id.clone(),
        sequence: 0,
        channel,
        text: String::new(),
        preview: None,
    };
    let schema = serde_json::json!({"type":"object","additionalProperties":false,"required":["commits"],"properties":{"commits":{"type":"array","items":{"type":"object","additionalProperties":false,"required":["message","paths"],"properties":{"message":{"type":"string"},"paths":{"type":"array","items":{"type":"string"}}}}}}});
    if provider == "codex" {
        let prepared = codex::prepare(&config, cancel.clone(), None).await?;
        let mut session = codex::Session::start(root, &config, prepared, cancel).await?;
        let result = session.run(&prompt, Some(schema), &mut stream).await;
        session.finish().await;
        result?;
    } else {
        claude::run(root, &prompt, &config, cancel, &mut stream).await?;
    }
    Ok(stream.text)
}
