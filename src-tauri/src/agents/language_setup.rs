use super::*;
use ts_rs::TS;

pub(crate) async fn plan(
    storage: &Storage,
    root: &std::path::Path,
    resources: &std::path::Path,
    request: &LanguageSetupRequest,
    context: String,
    cancel: Arc<AtomicBool>,
    channel: Channel<AgentEvent>,
) -> AppResult<String> {
    let settings = settings(storage)?;
    let project = storage.project_settings(&request.repository_id)?;
    let provider = project
        .provider
        .as_deref()
        .unwrap_or(&settings.default_provider)
        .to_owned();
    let mut config = settings
        .providers
        .iter()
        .find(|c| c.provider == provider)
        .cloned()
        .ok_or_else(|| AppError::new("provider", "Configure a harness before asking Rev."))?;
    config = models::for_project(config, project);
    if config.model.is_none() && provider == "codex" {
        config.model = Some(settings.helper_model);
    }
    let template = std::fs::read_to_string(resources.join("prompts/language-setup.md"))?;
    let cfg = ts_rs::Config::default();
    let contract = [
        LanguageDefinition::decl(&cfg),
        LanguagePackArtifact::decl(&cfg),
        LanguagePackInstallation::decl(&cfg),
        LanguagePackServer::decl(&cfg),
        LanguagePack::decl(&cfg),
        LanguageSetupFile::decl(&cfg),
        LanguageSetupCommand::decl(&cfg),
        LanguageSetupServer::decl(&cfg),
        LanguageSetupPlan::decl(&cfg),
    ]
    .join("\n");
    let prompt = prompts::render(
        &template,
        &BTreeMap::from([("context".into(), context), ("contract".into(), contract)]),
    )?;
    let mut stream = Stream {
        id: request.operation_id.clone(),
        sequence: 0,
        channel,
        text: String::new(),
        preview: None,
    };
    if provider == "codex" {
        let prepared = codex::prepare(&config, cancel.clone(), None).await?;
        let mut session = codex::Session::start(root, &config, prepared, cancel).await?;
        session.read_only();
        let result = session.run(&prompt, None, &mut stream).await;
        session.finish().await;
        result?;
    } else {
        claude::run_policy(root, &prompt, &config, cancel, &mut stream, true).await?;
    }
    Ok(stream.text)
}
