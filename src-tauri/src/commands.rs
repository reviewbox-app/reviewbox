use crate::{contracts::*, repositories, reviews, snapshots, storage::Storage};
use std::path::PathBuf;
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
    details: Option<bool>,
    operation_id: Option<String>,
) -> AppResult<ReviewPreview> {
    let s = storage.scoped(Some(&request.repository_id));
    let cache = s.repository_cache.clone();
    let task = cache.begin(&operation_id.unwrap_or_else(id))?;
    blocking(move || {
        let result = crate::review_creation::cached_preview::read(
            &s,
            request,
            details.unwrap_or(true),
            &task,
        );
        cache.finish(&task);
        result
    })
    .await
}

#[tauri::command]
pub fn cancel_repository_read(storage: State<'_, Storage>, operation_id: String) {
    storage.repository_cache.cancel(&operation_id);
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
pub async fn check_provider_updates(
    storage: State<'_, Storage>,
    provider: String,
) -> AppResult<ProviderUpdateCheck> {
    crate::agents::setup::updates::check(&storage, &provider).await
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
pub async fn open_repository(
    app: tauri::AppHandle,
    storage: State<'_, Storage>,
    path: String,
) -> AppResult<Repository> {
    let s = storage.inner().clone();
    let resources = resource_root(&app)?;
    blocking(move || {
        let repository = repositories::open(&s, &path)?;
        let result = crate::project_skills::bootstrap(&s, &repository, &resources);
        let error = match result {
            Ok(report) => report.error,
            Err(error) => Some(error),
        };
        if let Some(error) = error {
            let _ = app
                .state::<std::sync::Arc<crate::diagnostics::Diagnostics>>()
                .record(DiagnosticInput {
                    source: "native".into(),
                    operation: "project_skills_import".into(),
                    code: error.code,
                    message: error.message,
                    details: error.details,
                    stack: None,
                    context: Default::default(),
                });
        }
        Ok(repository)
    })
    .await
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
    preparation: State<'_, crate::preparation::PreparationManager>,
    languages: State<'_, crate::language_servers::LanguageServers>,
    storage: State<'_, Storage>,
    repository_id: Option<String>,
    id: String,
    revision: u32,
) -> AppResult<Workspace> {
    let s = storage.scoped(repository_id.as_deref());
    let _pause = preparation.quiesce(&s, &id).await?;
    let current: Review = s.get("review", &id)?;
    languages.release_snapshot(&current.snapshot_id);
    blocking(move || reviews::refresh(&s, &id, revision)).await
}
#[tauri::command]
pub async fn delete_review(
    preparation: State<'_, crate::preparation::PreparationManager>,
    languages: State<'_, crate::language_servers::LanguageServers>,
    storage: State<'_, Storage>,
    repository_id: Option<String>,
    id: String,
) -> AppResult<()> {
    let s = storage.scoped(repository_id.as_deref());
    let _pause = preparation.quiesce(&s, &id).await?;
    let current: Review = s.get("review", &id)?;
    languages.release_snapshot(&current.snapshot_id);
    blocking(move || {
        s.remove("review", &id)?;
        s.remove(
            "review_preparation",
            &format!("{}:{id}", current.repository_id),
        )?;
        s.collect_review_garbage(&current.repository_id)
    })
    .await
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
pub async fn check_review_freshness(
    storage: State<'_, Storage>,
    repository_id: Option<String>,
    id: String,
) -> AppResult<ReviewFreshness> {
    let s = storage.scoped(repository_id.as_deref());
    blocking(move || snapshots::review_freshness(&s, &reviews::load(&s, &id)?)).await
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
pub(crate) fn resource_root(app: &tauri::AppHandle) -> AppResult<PathBuf> {
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
pub async fn language_server_settings(
    storage: State<'_, Storage>,
) -> AppResult<LanguageServerSettings> {
    let s = storage.inner().clone();
    blocking(move || crate::language_servers::settings(&s)).await
}
#[tauri::command]
pub async fn configure_language_servers(
    app: tauri::AppHandle,
    storage: State<'_, Storage>,
    manager: State<'_, crate::language_servers::LanguageServers>,
    live: State<'_, crate::language_servers::live::LiveLanguages>,
    settings: LanguageServerSettings,
) -> AppResult<LanguageServerSettings> {
    let s = storage.inner().clone();
    let (previous, result) = blocking(move || {
        let previous = crate::language_servers::settings(&s)?;
        Ok((previous, crate::language_servers::configure(&s, settings)?))
    })
    .await?;
    let ids = previous
        .servers
        .iter()
        .chain(&result.servers)
        .map(|server| server.id.clone())
        .collect::<std::collections::BTreeSet<_>>();
    for id in ids {
        let before = previous.servers.iter().find(|s| s.id == id);
        let after = result.servers.iter().find(|s| s.id == id);
        if serde_json::to_value(before)? != serde_json::to_value(after)? {
            manager.stop_server(&id);
            live.invalidate_server(&id);
        }
    }
    use tauri::Emitter;
    let _ = app.emit("reviewbox:language-servers-changed", ());
    Ok(result)
}
#[tauri::command]
pub async fn find_definition(
    storage: State<'_, Storage>,
    manager: State<'_, crate::language_servers::LanguageServers>,
    repository_id: Option<String>,
    snapshot_id: String,
    path: String,
    line: u32,
    column: u32,
) -> AppResult<Vec<CodeLocation>> {
    crate::language_servers::definition(
        &manager,
        storage.scoped(repository_id.as_deref()),
        snapshot_id,
        path,
        line,
        column,
    )
    .await
}

#[tauri::command]
pub async fn language_request(
    storage: State<'_, Storage>,
    manager: State<'_, crate::language_servers::LanguageServers>,
    repository_id: Option<String>,
    request: LanguageRequest,
) -> AppResult<LanguageResponse> {
    manager
        .request(storage.scoped(repository_id.as_deref()), request)
        .await
}

#[tauri::command]
pub fn cancel_language_request(
    manager: State<'_, crate::language_servers::LanguageServers>,
    request_id: String,
) {
    manager.cancel(&request_id);
}

#[tauri::command]
pub async fn read_language_source(
    storage: State<'_, Storage>,
    repository_id: Option<String>,
    document: LanguageDocument,
) -> AppResult<String> {
    let storage = storage.scoped(repository_id.as_deref());
    blocking(move || crate::language_servers::read_source(&storage, &document)).await
}

#[tauri::command]
pub fn release_language_snapshot(
    manager: State<'_, crate::language_servers::LanguageServers>,
    snapshot_id: String,
) {
    manager.release_snapshot(&snapshot_id);
}

#[tauri::command]
pub async fn language_repository_paths(
    storage: State<'_, Storage>,
    repository_id: String,
) -> AppResult<Vec<String>> {
    let storage = storage.inner().clone();
    blocking(move || {
        let root = repositories::root(&storage, &repository_id)?;
        let paths = repositories::git(
            &root,
            &[
                "ls-files",
                "--cached",
                "--others",
                "--exclude-standard",
                "-z",
            ],
        )?;
        let mut paths = paths
            .split(|b| *b == 0)
            .filter(|v| !v.is_empty())
            .filter_map(|v| std::str::from_utf8(v).ok())
            .filter(|v| !snapshots::is_metadata(v))
            .map(str::to_owned)
            .collect::<Vec<_>>();
        paths.sort();
        paths.dedup();
        Ok(paths)
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

#[tauri::command]
pub async fn read_review_source(
    storage: State<'_, Storage>,
    repository_id: Option<String>,
    snapshot_id: String,
    source_id: String,
) -> AppResult<FrozenSource> {
    let s = storage.scoped(repository_id.as_deref());
    blocking(move || {
        let snapshot = s.get("snapshot", &snapshot_id)?;
        crate::reader::source(&s, &snapshot, &source_id)
    })
    .await
}
#[tauri::command]
pub async fn read_review_file(
    storage: State<'_, Storage>,
    repository_id: Option<String>,
    review_id: String,
    file_id: String,
) -> AppResult<ReviewFileContent> {
    let s = storage.scoped(repository_id.as_deref());
    blocking(move || crate::reader::read_file(&s, &review_id, &file_id)).await
}
#[tauri::command]
pub async fn export_review_summary(
    storage: State<'_, Storage>,
    repository_id: Option<String>,
    id: String,
    level: ReadingLevel,
) -> AppResult<bool> {
    let s = storage.scoped(repository_id.as_deref());
    let text =
        blocking(move || reviews::load(&s, &id).map(|w| crate::reader::summary(&w, level))).await?;
    let Some(file) = rfd::AsyncFileDialog::new()
        .set_file_name("review-summary.md")
        .save_file()
        .await
    else {
        return Ok(false);
    };
    file.write(text.as_bytes()).await?;
    Ok(true)
}
#[tauri::command]
pub async fn start_review_preparation(
    app: tauri::AppHandle,
    storage: State<'_, Storage>,
    repository_id: Option<String>,
    manager: State<'_, crate::preparation::PreparationManager>,
    request: PreparationRequest,
) -> AppResult<PreparationState> {
    let storage = storage.scoped(repository_id.as_deref());
    let manager = manager.inner().clone();
    let resources = resource_root(&app)?;
    let state = blocking(move || manager.start(storage, resources, request)).await?;
    crate::notifications::prepare(&app);
    Ok(state)
}
#[tauri::command]
pub async fn update_review_with_rev(
    app: tauri::AppHandle,
    storage: State<'_, Storage>,
    repository_id: Option<String>,
    manager: State<'_, crate::preparation::PreparationManager>,
    review_id: String,
    revision: u32,
    provider: String,
) -> AppResult<Option<PreparationState>> {
    let storage = storage.scoped(repository_id.as_deref());
    let manager = manager.inner().clone();
    let resources = resource_root(&app)?;
    let state =
        blocking(move || manager.adapt(storage, resources, &review_id, revision, provider)).await?;
    if state.is_some() {
        crate::notifications::prepare(&app);
    }
    Ok(state)
}
#[tauri::command]
pub async fn discard_review_update(
    storage: State<'_, Storage>,
    repository_id: Option<String>,
    manager: State<'_, crate::preparation::PreparationManager>,
    review_id: String,
) -> AppResult<()> {
    let storage = storage.scoped(repository_id.as_deref());
    let manager = manager.inner().clone();
    blocking(move || manager.discard_update(&storage, &review_id)).await
}
#[tauri::command]
pub async fn get_review_preparation(
    storage: State<'_, Storage>,
    repository_id: Option<String>,
    manager: State<'_, crate::preparation::PreparationManager>,
    review_id: String,
    after_sequence: Option<u32>,
) -> AppResult<Option<PreparationState>> {
    let storage = storage.scoped(repository_id.as_deref());
    let manager = manager.inner().clone();
    blocking(move || manager.get(&storage, &review_id, after_sequence)).await
}
#[tauri::command]
pub async fn resume_review_preparation(
    app: tauri::AppHandle,
    storage: State<'_, Storage>,
    repository_id: Option<String>,
    manager: State<'_, crate::preparation::PreparationManager>,
    review_id: String,
) -> AppResult<PreparationState> {
    let storage = storage.scoped(repository_id.as_deref());
    let manager = manager.inner().clone();
    let resources = resource_root(&app)?;
    let state = blocking(move || manager.resume(storage, resources, &review_id)).await?;
    if state.status == PreparationStatus::Running {
        crate::notifications::prepare(&app);
    }
    Ok(state)
}
#[tauri::command]
pub async fn cancel_review_preparation(
    storage: State<'_, Storage>,
    repository_id: Option<String>,
    manager: State<'_, crate::preparation::PreparationManager>,
    review_id: String,
) -> AppResult<()> {
    let storage = storage.scoped(repository_id.as_deref());
    let manager = manager.inner().clone();
    blocking(move || manager.cancel(&storage, &review_id)).await
}
