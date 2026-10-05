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
    let directory = tempfile::tempdir()?;
    let prompt = planning_prompt(&template, &context, &directory.path().join("staged.json"))?;
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
        session.read_only();
        let result = session.run(&prompt, Some(schema), &mut stream).await;
        session.finish().await;
        result.map_err(commit_error)?;
    } else {
        claude::run_terminal(root, &prompt, &config, cancel, &mut stream)
            .await
            .map_err(commit_error)?;
    }
    Ok(stream.text)
}

fn planning_prompt(template: &str, context: &str, manifest: &std::path::Path) -> AppResult<String> {
    let value: Value = serde_json::from_str(context)?;
    std::fs::write(manifest, context)?;
    let input = serde_json::json!({
        "manifest": manifest,
        "baseTree":value["baseTree"],
        "stagedTree":value["stagedTree"],
        "stagedFileCount":value["files"].as_array().map_or(0, Vec::len),
    });
    prompts::render(
        template,
        &BTreeMap::from([("context".into(), input.to_string())]),
    )
}

fn commit_error(mut error: AppError) -> AppError {
    if error.code == "provider_error" {
        error.message = "Rev could not prepare the commit plan. No commit was created; your staged changes are kept.".into();
    }
    error
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn large_inventory_stays_on_disk_not_in_the_provider_prompt() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("staged.json");
        let files: Vec<_> = (0..20_000)
            .map(|i| json!({"path":format!("long-directory/{i}/file.ts")}))
            .collect();
        let context = json!({"baseTree":"base","stagedTree":"frozen","files":files}).to_string();
        let prompt =
            planning_prompt("Inspect with your terminal: {{context}}", &context, &path).unwrap();
        assert!(prompt.len() < 1024);
        assert!(!prompt.contains("long-directory"));
        assert_eq!(std::fs::read_to_string(&path).unwrap(), context);
    }
}
