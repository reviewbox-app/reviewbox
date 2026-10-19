//! Explicit commit execution in the project's harness. Git is the result source.
use super::*;

pub(crate) async fn run(
    storage: &Storage,
    root: &std::path::Path,
    resources: &std::path::Path,
    request: &GitCommitRequest,
    stage_all: bool,
    cancel: Arc<AtomicBool>,
) -> AppResult<()> {
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
        settings.helper_model.clone()
    } else {
        "claude-sonnet-5".into()
    });
    let template = std::fs::read_to_string(resources.join("prompts/commit.md"))?;
    let scope = if stage_all {
        "Stage and commit all saved Git changes in this project, including changes outside the completed review."
    } else {
        "Commit the changes currently staged in Git. Keep unrelated unstaged changes in the working tree."
    };
    let prompt = prompts::render(&template, &BTreeMap::from([("scope".into(), scope.into())]))?;
    // Provider commentary is not a commit receipt. The source-control observer
    // streams only commits it can actually read back from Git.
    let mut stream = Stream {
        live_text: false,
        id: request.operation_id.clone(),
        sequence: 0,
        channel: Channel::new(|_| Ok(())),
        text: String::new(),
        preview: None,
    };
    if provider == "codex" {
        let prepared = codex::prepare(&config, cancel.clone(), Some(settings.helper_model)).await?;
        let mut session = codex::Session::start(root, &config, prepared, cancel).await?;
        let result = session.run(&prompt, None, &mut stream).await;
        session.finish().await;
        result
    } else {
        claude::run(root, &prompt, &config, cancel, &mut stream).await
    }
}
