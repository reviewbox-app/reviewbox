use crate::{contracts::*, prompts, repositories, reviews, snapshots, storage::Storage};
use std::{collections::BTreeMap, path::PathBuf};
use tauri::{Manager, State};

async fn blocking<T: Send + 'static>(
    work: impl FnOnce() -> AppResult<T> + Send + 'static,
) -> AppResult<T> {
    tauri::async_runtime::spawn_blocking(work)
        .await
        .map_err(|_| AppError::new("task_failed", "The native operation could not finish."))?
}

#[tauri::command]
pub async fn preview_review(
    storage: State<'_, Storage>,
    request: CaptureRequest,
) -> AppResult<ReviewPreview> {
    let s = storage.scoped(Some(&request.repository_id));
    blocking(move || crate::review_creation::preview(&s, &request)).await
}

#[tauri::command]
pub async fn review_references(
    storage: State<'_, Storage>,
    repository_id: String,
    query: String,
) -> AppResult<Vec<RepositoryRef>> {
    let s = storage.inner().clone();
    blocking(move || crate::review_creation::references(&s, &repository_id, &query)).await
}

#[tauri::command]
pub async fn create_review_operation(
    storage: State<'_, Storage>,
    manager: State<'_, crate::review_creation::CaptureManager>,
    operation_id: String,
    request: CaptureRequest,
    channel: tauri::ipc::Channel<CaptureProgress>,
) -> AppResult<Workspace> {
    let task = manager.begin(&operation_id)?;
    let s = storage.scoped(Some(&request.repository_id));
    let result = blocking(move || {
        crate::review_creation::create(&s, request, task, |progress| {
            channel
                .send(progress)
                .map_err(|_| AppError::new("cancelled", "The capture window was closed."))
        })
    })
    .await;
    manager.finish(&operation_id);
    result
}

#[tauri::command]
pub fn cancel_review_creation(
    manager: State<'_, crate::review_creation::CaptureManager>,
    operation_id: String,
) -> AppResult<()> {
    manager.cancel(&operation_id)
}

#[tauri::command]
pub async fn choose_provider_executable() -> AppResult<Option<String>> {
    Ok(rfd::AsyncFileDialog::new()
        .set_title("Choose harness executable")
        .pick_file()
        .await
        .map(|file| file.path().to_string_lossy().into_owned()))
}

#[tauri::command]
pub async fn install_provider(
    app: tauri::AppHandle,
    storage: State<'_, Storage>,
    manager: State<'_, crate::agents::setup::SetupManager>,
    request: ProviderSetupRequest,
    channel: tauri::ipc::Channel<ProviderSetupEvent>,
) -> AppResult<ProviderStatus> {
    let result = crate::agents::setup::install(&storage, &manager, request, channel).await;
    use tauri::Emitter;
    let _ = app.emit("reviewbox:providers-changed", ());
    result
}

#[tauri::command]
pub fn cancel_provider_setup(
    manager: State<'_, crate::agents::setup::SetupManager>,
    operation_id: String,
) -> AppResult<()> {
    manager.cancel(&operation_id)
}

#[tauri::command]
pub async fn open_provider_login(storage: State<'_, Storage>, provider: String) -> AppResult<()> {
    crate::agents::setup::open_login(&storage, &provider).await
}

#[tauri::command]
pub async fn agent_preparation_context(
    storage: State<'_, Storage>,
    repository_id: Option<String>,
    review_id: String,
) -> AppResult<AgentPreparationContext> {
    let s = storage.scoped(repository_id.as_deref());
    blocking(move || crate::agents::preparation_context(&s, &review_id)).await
}

#[tauri::command]
pub async fn diagnose_proposal(
    storage: State<'_, Storage>,
    repository_id: Option<String>,
    review_id: String,
    content: ProposalContent,
) -> AppResult<Vec<ProposalDiagnostic>> {
    let s = storage.scoped(repository_id.as_deref());
    blocking(move || crate::proposals::diagnostics(&s, &review_id, &content)).await
}
#[tauri::command]
pub async fn list_repositories(storage: State<'_, Storage>) -> AppResult<Vec<Repository>> {
    let s = storage.inner().clone();
    blocking(move || s.list("repository")).await
}
#[tauri::command]
pub async fn open_repository(storage: State<'_, Storage>, path: String) -> AppResult<Repository> {
    let s = storage.inner().clone();
    blocking(move || repositories::open(&s, &path)).await
}
#[tauri::command]
pub async fn choose_repository() -> AppResult<Option<String>> {
    Ok(rfd::AsyncFileDialog::new()
        .set_title("Open Git repository")
        .pick_folder()
        .await
        .map(|f| f.path().to_string_lossy().into_owned()))
}
#[tauri::command]
pub async fn forget_repository(storage: State<'_, Storage>, id: String) -> AppResult<()> {
    let s = storage.inner().clone();
    blocking(move || s.remove("repository", &id)).await
}
#[tauri::command]
pub async fn list_reviews(
    storage: State<'_, Storage>,
    repository_id: String,
) -> AppResult<Vec<Review>> {
    let s = storage.scoped(Some(repository_id.as_str()));
    blocking(move || {
        Ok(s.list::<Review>("review")?
            .into_iter()
            .filter(|r| r.repository_id == repository_id)
            .collect())
    })
    .await
}
#[tauri::command]
pub async fn create_review(
    storage: State<'_, Storage>,
    repository_id: Option<String>,
    request: CaptureRequest,
) -> AppResult<Workspace> {
    let s = storage.scoped(repository_id.as_deref());
    blocking(move || reviews::create(&s, request)).await
}
#[tauri::command]
pub async fn load_review(
    storage: State<'_, Storage>,
    repository_id: Option<String>,
    id: String,
) -> AppResult<Workspace> {
    let s = storage.scoped(repository_id.as_deref());
    blocking(move || reviews::load(&s, &id)).await
}
#[tauri::command]
pub async fn update_review(
    storage: State<'_, Storage>,
    repository_id: Option<String>,
    id: String,
    revision: u32,
    action: ReviewAction,
) -> AppResult<Workspace> {
    let s = storage.scoped(repository_id.as_deref());
    blocking(move || reviews::apply(&s, &id, revision, action)).await
}
#[tauri::command]
pub async fn refresh_review(
    storage: State<'_, Storage>,
    repository_id: Option<String>,
    id: String,
    revision: u32,
) -> AppResult<Workspace> {
    let s = storage.scoped(repository_id.as_deref());
    blocking(move || reviews::refresh(&s, &id, revision)).await
}
#[tauri::command]
pub async fn delete_review(
    storage: State<'_, Storage>,
    repository_id: Option<String>,
    id: String,
) -> AppResult<()> {
    let s = storage.scoped(repository_id.as_deref());
    blocking(move || s.remove("review", &id)).await
}
#[tauri::command]
pub async fn read_change(
    storage: State<'_, Storage>,
    repository_id: Option<String>,
    snapshot_id: String,
    change_id: String,
) -> AppResult<FileContent> {
    let s = storage.scoped(repository_id.as_deref());
    blocking(move || snapshots::content(&s, &snapshot_id, &change_id)).await
}
#[tauri::command]
pub async fn review_coverage(
    storage: State<'_, Storage>,
    repository_id: Option<String>,
    id: String,
) -> AppResult<Coverage> {
    let s = storage.scoped(repository_id.as_deref());
    blocking(move || Ok(reviews::coverage(&reviews::load(&s, &id)?))).await
}
#[tauri::command]
pub async fn check_repository_changed(
    storage: State<'_, Storage>,
    repository_id: Option<String>,
    snapshot_id: String,
) -> AppResult<bool> {
    let s = storage.scoped(repository_id.as_deref());
    blocking(move || {
        let snapshot: Snapshot = s.get("snapshot", &snapshot_id)?;
        snapshots::repository_changed(&s, &snapshot)
    })
    .await
}
#[tauri::command]
pub async fn read_snapshot_file(
    storage: State<'_, Storage>,
    repository_id: Option<String>,
    snapshot_id: String,
    path: String,
) -> AppResult<String> {
    let s = storage.scoped(repository_id.as_deref());
    blocking(move || {
        let snapshot: Snapshot = s.get("snapshot", &snapshot_id)?;
        let file = snapshot
            .files
            .iter()
            .find(|f| f.path == path)
            .ok_or_else(|| AppError::new("not_found", "File is not part of the snapshot."))?;
        if file.content.size > 2 * 1024 * 1024 {
            return Err(AppError::new(
                "large_preview",
                "File exceeds the 2 MiB preview limit.",
            ));
        }
        String::from_utf8(s.read_blob(&file.content.hash)?)
            .map_err(|_| AppError::new("encoding", "Not a UTF-8 text file."))
    })
    .await
}
#[tauri::command]
pub async fn preview_prompt(
    app: tauri::AppHandle,
    action: String,
    variables: BTreeMap<String, String>,
) -> AppResult<PromptPreview> {
    let root = resource_root(&app)?;
    blocking(move || prompts::load(&root, &action, &variables)).await
}
fn resource_root(app: &tauri::AppHandle) -> AppResult<PathBuf> {
    if cfg!(debug_assertions) {
        Ok(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../resources/agents"))
    } else {
        Ok(app
            .path()
            .resource_dir()
            .map_err(|e| AppError::new("resources", e.to_string()))?
            .join("agents"))
    }
}
#[tauri::command]
pub async fn load_knowledge(
    storage: State<'_, Storage>,
    repository_id: String,
) -> AppResult<ProjectKnowledge> {
    let s = storage.scoped(Some(repository_id.as_str()));
    blocking(move || crate::knowledge::load(&s, &repository_id)).await
}
#[tauri::command]
pub async fn save_knowledge(
    storage: State<'_, Storage>,
    repository_id: Option<String>,
    knowledge: ProjectKnowledge,
) -> AppResult<ProjectKnowledge> {
    let s = storage.scoped(repository_id.as_deref());
    blocking(move || crate::knowledge::save(&s, knowledge)).await
}
#[tauri::command]
pub async fn provider_models(
    storage: State<'_, Storage>,
    manager: State<'_, crate::agents::models::CatalogManager>,
    id: String,
    provider: String,
) -> AppResult<Vec<ProviderModel>> {
    let config = crate::agents::settings(storage.inner())?
        .providers
        .into_iter()
        .find(|config| config.provider == provider)
        .ok_or_else(|| AppError::new("provider", "Unknown provider."))?;
    let cancel = manager.0.register(&id)?;
    let result = crate::agents::models::discover(&config, cancel).await;
    manager.0.remove(&id);
    result
}

#[tauri::command]
pub fn cancel_provider_models(
    manager: State<'_, crate::agents::models::CatalogManager>,
    id: String,
) -> AppResult<()> {
    manager.0.cancel(&id)
}

#[tauri::command]
pub async fn provider_status(storage: State<'_, Storage>) -> AppResult<Vec<ProviderStatus>> {
    let configs = crate::agents::settings(storage.inner())?.providers;
    let mut statuses = vec![];
    for config in configs {
        statuses.push(crate::agents::providers::detect(&config).await);
    }
    Ok(statuses)
}

#[tauri::command]
pub async fn export_tour(
    storage: State<'_, Storage>,
    repository_id: Option<String>,
    id: String,
) -> AppResult<bool> {
    let s = storage.scoped(repository_id.as_deref());
    let text = blocking(move || crate::tours::export(&s, &id)).await?;
    let Some(file) = rfd::AsyncFileDialog::new()
        .set_file_name("review.reviewbox-tour.json")
        .save_file()
        .await
    else {
        return Ok(false);
    };
    file.write(text.as_bytes()).await?;
    Ok(true)
}
#[tauri::command]
pub async fn import_tour(
    storage: State<'_, Storage>,
    repository_id: Option<String>,
    id: String,
    revision: u32,
) -> AppResult<Option<Workspace>> {
    let Some(file) = rfd::AsyncFileDialog::new()
        .add_filter("ReviewBox tour", &["json"])
        .pick_file()
        .await
    else {
        return Ok(None);
    };
    let text = String::from_utf8(file.read().await)
        .map_err(|_| AppError::new("encoding", "Tour must be UTF-8."))?;
    let s = storage.scoped(repository_id.as_deref());
    blocking(move || crate::tours::import(&s, &id, revision, &text).map(Some)).await
}
#[tauri::command]
pub async fn start_agent(
    app: tauri::AppHandle,
    storage: State<'_, Storage>,
    repository_id: Option<String>,
    manager: State<'_, crate::agents::AgentManager>,
    request: AgentRequest,
    channel: tauri::ipc::Channel<AgentEvent>,
) -> AppResult<AgentRun> {
    let root = resource_root(&app)?;
    let cancel = manager.register(&request.id)?;
    let id = request.id.clone();
    let result = crate::agents::run(
        storage.scoped(repository_id.as_deref()),
        root,
        request,
        cancel,
        channel,
    )
    .await;
    manager.remove(&id);
    result
}
#[tauri::command]
pub async fn cancel_agent(
    manager: State<'_, crate::agents::AgentManager>,
    id: String,
) -> AppResult<()> {
    manager.cancel(&id)
}
#[tauri::command]
pub async fn list_agent_runs(
    storage: State<'_, Storage>,
    repository_id: Option<String>,
    review_id: String,
) -> AppResult<Vec<AgentRun>> {
    let s = storage.scoped(repository_id.as_deref());
    blocking(move || {
        Ok(s.list::<AgentRun>("agent_run")?
            .into_iter()
            .filter(|r| r.review_id == review_id)
            .collect())
    })
    .await
}
#[tauri::command]
pub async fn prepare_test(
    storage: State<'_, Storage>,
    repository_id: Option<String>,
    review_id: String,
    command: Vec<String>,
) -> AppResult<TestRun> {
    let s = storage.scoped(repository_id.as_deref());
    blocking(move || crate::evidence::prepare(&s, &review_id, command)).await
}
#[tauri::command]
pub async fn answer_test_permission(
    storage: State<'_, Storage>,
    repository_id: Option<String>,
    manager: State<'_, crate::agents::AgentManager>,
    id: String,
    approved: bool,
    channel: tauri::ipc::Channel<AgentEvent>,
) -> AppResult<TestRun> {
    let cancel = manager.register(&id)?;
    let result = crate::evidence::run(
        storage.scoped(repository_id.as_deref()),
        id.clone(),
        approved,
        cancel,
        channel,
    )
    .await;
    manager.remove(&id);
    result
}
#[tauri::command]
pub async fn cancel_test(
    manager: State<'_, crate::agents::AgentManager>,
    id: String,
) -> AppResult<()> {
    crate::evidence::cancel(&manager, &id)
}
#[tauri::command]
pub async fn list_test_runs(
    storage: State<'_, Storage>,
    repository_id: Option<String>,
    review_id: String,
) -> AppResult<Vec<TestRun>> {
    let s = storage.scoped(repository_id.as_deref());
    blocking(move || {
        Ok(s.list::<TestRun>("test_run")?
            .into_iter()
            .filter(|r| r.review_id == review_id)
            .collect())
    })
    .await
}
#[tauri::command]
pub async fn language_server_settings(
    storage: State<'_, Storage>,
) -> AppResult<LanguageServerSettings> {
    let s = storage.inner().clone();
    blocking(move || crate::language_servers::settings(&s)).await
}
#[tauri::command]
pub async fn configure_language_servers(
    storage: State<'_, Storage>,
    settings: LanguageServerSettings,
) -> AppResult<LanguageServerSettings> {
    let s = storage.inner().clone();
    blocking(move || crate::language_servers::configure(&s, settings)).await
}
#[tauri::command]
pub async fn find_definition(
    storage: State<'_, Storage>,
    repository_id: Option<String>,
    snapshot_id: String,
    path: String,
    line: u32,
    column: u32,
) -> AppResult<Vec<CodeLocation>> {
    crate::language_servers::definition(
        storage.scoped(repository_id.as_deref()),
        snapshot_id,
        path,
        line,
        column,
    )
    .await
}

#[tauri::command]
pub async fn proposal_from_run(
    storage: State<'_, Storage>,
    repository_id: Option<String>,
    run_id: String,
) -> AppResult<Proposal> {
    let s = storage.scoped(repository_id.as_deref());
    blocking(move || {
        if let Some(proposal) = s
            .list::<Proposal>("proposal")?
            .into_iter()
            .find(|p| p.run_id.as_ref() == Some(&run_id))
        {
            if proposal.status != "pending" {
                return Err(AppError::new(
                    "answered_proposal",
                    "This response has already been accepted or rejected.",
                ));
            }
            return Ok(proposal);
        }
        let run: AgentRun = s.get("agent_run", &run_id)?;
        crate::proposals::parse(&s, &run.review_id, &run.output, Some(run.id.clone()))
    })
    .await
}
#[tauri::command]
pub async fn answer_proposal(
    storage: State<'_, Storage>,
    repository_id: Option<String>,
    id: String,
    revision: u32,
    content: ProposalContent,
    accepted: bool,
) -> AppResult<Proposal> {
    let s = storage.scoped(repository_id.as_deref());
    blocking(move || crate::proposals::answer(&s, &id, revision, content, accepted)).await
}
#[tauri::command]
pub async fn list_proposals(
    storage: State<'_, Storage>,
    repository_id: Option<String>,
    review_id: String,
) -> AppResult<Vec<Proposal>> {
    let s = storage.scoped(repository_id.as_deref());
    blocking(move || {
        Ok(s.list::<Proposal>("proposal")?
            .into_iter()
            .filter(|p| p.review_id == review_id)
            .collect())
    })
    .await
}

#[tauri::command]
pub async fn list_onboarding_tours(
    storage: State<'_, Storage>,
    repository_id: String,
) -> AppResult<Vec<OnboardingTour>> {
    let s = storage.scoped(Some(repository_id.as_str()));
    blocking(move || {
        Ok(s.list::<OnboardingTour>("onboarding")?
            .into_iter()
            .filter(|t| t.repository_id == repository_id)
            .collect())
    })
    .await
}
#[tauri::command]
pub async fn save_onboarding_tour(
    storage: State<'_, Storage>,
    repository_id: Option<String>,
    tour: OnboardingTour,
) -> AppResult<OnboardingTour> {
    let s = storage.scoped(repository_id.as_deref());
    blocking(move || crate::onboarding::save(&s, tour)).await
}
#[tauri::command]
pub async fn read_onboarding_step(
    storage: State<'_, Storage>,
    repository_id: Option<String>,
    tour_id: String,
    step_id: String,
) -> AppResult<CurrentTourStep> {
    let s = storage.scoped(repository_id.as_deref());
    blocking(move || crate::onboarding::read_step(&s, &tour_id, &step_id)).await
}
#[tauri::command]
pub async fn import_onboarding_tour(
    storage: State<'_, Storage>,
    repository_id: String,
) -> AppResult<Option<TourImportReport>> {
    let Some(file) = rfd::AsyncFileDialog::new()
        .add_filter("CodeTour / ReviewBox onboarding", &["tour", "json"])
        .pick_file()
        .await
    else {
        return Ok(None);
    };
    let text = String::from_utf8(file.read().await)
        .map_err(|_| AppError::new("encoding", "Tour must be UTF-8."))?;
    let s = storage.scoped(Some(repository_id.as_str()));
    blocking(move || crate::onboarding::import(&s, &repository_id, &text).map(Some)).await
}
#[tauri::command]
pub async fn export_onboarding_tour(
    storage: State<'_, Storage>,
    repository_id: Option<String>,
    id: String,
) -> AppResult<bool> {
    let s = storage.scoped(repository_id.as_deref());
    let tour: OnboardingTour = blocking(move || s.get("onboarding", &id)).await?;
    let steps: Vec<_> = tour.steps.iter().map(|s| serde_json::json!({"title":s.title,"description":s.explanation,"file":s.path,"startLine":s.start_line,"endLine":s.end_line})).collect();
    let text = serde_json::to_vec_pretty(
        &serde_json::json!({"format":"reviewbox-onboarding","version":1,"title":tour.title,"steps":steps}),
    )?;
    let Some(file) = rfd::AsyncFileDialog::new()
        .set_file_name("onboarding.reviewbox.json")
        .save_file()
        .await
    else {
        return Ok(false);
    };
    file.write(&text).await?;
    Ok(true)
}

#[tauri::command]
pub async fn review_history(
    storage: State<'_, Storage>,
    repository_id: Option<String>,
    id: String,
) -> AppResult<Vec<Review>> {
    let s = storage.scoped(repository_id.as_deref());
    blocking(move || {
        Ok(s.list::<Review>("review_history")?
            .into_iter()
            .filter(|r| r.id == id)
            .collect())
    })
    .await
}
#[tauri::command]
pub async fn read_historical_review(
    storage: State<'_, Storage>,
    repository_id: Option<String>,
    id: String,
    revision: u32,
) -> AppResult<Workspace> {
    let s = storage.scoped(repository_id.as_deref());
    blocking(move || {
        let review: Review = s.get("review_history", &format!("{id}@{revision}"))?;
        let snapshot = s.get("snapshot", &review.snapshot_id)?;
        Ok(Workspace { review, snapshot })
    })
    .await
}

#[tauri::command]
pub async fn open_settings(app: tauri::AppHandle) -> AppResult<()> {
    if let Some(window) = app.get_webview_window("settings") {
        window
            .set_focus()
            .map_err(|e| AppError::new("window", e.to_string()))?;
    } else {
        // Next serves the route in dev; the bundled export contains its HTML file.
        let path = if tauri::is_dev() {
            "settings/"
        } else {
            "settings/index.html"
        };
        let window =
            tauri::WebviewWindowBuilder::new(&app, "settings", tauri::WebviewUrl::App(path.into()))
                .title("ReviewBox Settings")
                .inner_size(1040.0, 720.0)
                .min_inner_size(800.0, 600.0);
        #[cfg(target_os = "macos")]
        let window = window
            .title_bar_style(tauri::TitleBarStyle::Overlay)
            .hidden_title(true);
        window
            .build()
            .map_err(|e| AppError::new("window", e.to_string()))?;
    }
    Ok(())
}
#[tauri::command]
pub async fn preview_agent_request(
    app: tauri::AppHandle,
    storage: State<'_, Storage>,
    repository_id: Option<String>,
    request: AgentRequest,
) -> AppResult<PromptPreview> {
    let root = resource_root(&app)?;
    let s = storage.scoped(repository_id.as_deref());
    blocking(move || Ok(crate::agents::prepare(&s, &root, &request)?.prompt)).await
}
#[tauri::command]
pub async fn reveal_storage(app: tauri::AppHandle) -> AppResult<()> {
    let directory = app
        .path()
        .app_data_dir()
        .map_err(|e| AppError::new("storage", e.to_string()))?;
    #[cfg(target_os = "macos")]
    let result = tokio::process::Command::new("open")
        .arg(directory)
        .status()
        .await?;
    #[cfg(target_os = "windows")]
    let result = tokio::process::Command::new("explorer")
        .arg(directory)
        .status()
        .await?;
    #[cfg(all(unix, not(target_os = "macos")))]
    let result = tokio::process::Command::new("xdg-open")
        .arg(directory)
        .status()
        .await?;
    if !result.success() {
        return Err(AppError::new(
            "reveal_failed",
            "The file manager could not open the storage folder.",
        ));
    }
    Ok(())
}

#[tauri::command]
pub async fn provider_settings(storage: State<'_, Storage>) -> AppResult<ProviderSettings> {
    let s = storage.inner().clone();
    blocking(move || crate::agents::settings(&s)).await
}
#[tauri::command]
pub async fn configure_providers(
    app: tauri::AppHandle,
    storage: State<'_, Storage>,
    settings: ProviderSettings,
) -> AppResult<ProviderSettings> {
    let s = storage.inner().clone();
    let settings = blocking(move || crate::agents::configure(&s, settings)).await?;
    use tauri::Emitter;
    let _ = app.emit("reviewbox:providers-changed", ());
    Ok(settings)
}

#[tauri::command]
pub async fn project_settings(
    storage: State<'_, Storage>,
    repository_id: String,
) -> AppResult<ProjectSettings> {
    let s = storage.scoped(Some(repository_id.as_str()));
    blocking(move || {
        let repo: Repository = s.get("repository", &repository_id)?;
        s.mount(&repo)?;
        s.project_settings(&repository_id)
    })
    .await
}
#[tauri::command]
pub async fn configure_project(
    storage: State<'_, Storage>,
    repository_id: String,
    settings: ProjectSettings,
) -> AppResult<ProjectSettings> {
    let s = storage.scoped(Some(repository_id.as_str()));
    blocking(move || s.save_project_settings(&repository_id, settings)).await
}
