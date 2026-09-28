mod agents;
mod app_info;
mod appearance;
mod commands;
pub mod contracts;
mod illustrations;
mod integrations;
mod knowledge;
pub use integrations::run_cli;
mod language_servers;
mod onboarding;
mod preparation;
mod processes;
mod project_storage;
#[cfg(test)]
mod project_storage_tests;
mod prompts;
mod proposals;
mod reader;
mod repositories;
mod review_creation;
mod reviews;
mod snapshots;
mod storage;
pub use project_storage::schemas as project_schemas;
use tauri::Manager;

pub fn run() {
    let builder = tauri::Builder::default();
    #[cfg(feature = "native-validation")]
    let builder = builder.plugin(tauri_plugin_wdio_webdriver::init());
    builder
        .manage(illustrations::Illustrations::default())
        .register_uri_scheme_protocol("reviewbox-illustration", illustrations::protocol)
        .plugin(
            tauri::plugin::Builder::<tauri::Wry, ()>::new("reader-isolation")
                .on_navigation(|_, url| illustrations::navigation_allowed(url))
                .build(),
        )
        .setup(|app| {
            #[cfg(not(feature = "native-validation"))]
            let data_dir = app.path().app_data_dir()?;
            #[cfg(feature = "native-validation")]
            let data_dir = std::env::var_os("REVIEWBOX_VALIDATION_DATA")
                .map(std::path::PathBuf::from)
                .ok_or_else(|| {
                    std::io::Error::other("Validation requires an isolated data directory")
                })?;
            let storage = storage::Storage::open(data_dir.clone())
                .map_err(|e| std::io::Error::other(e.message))?;
            #[cfg(unix)]
            app.manage(
                integrations::LocalBridge::start(storage.clone(), &data_dir)
                    .map_err(|e| std::io::Error::other(e.message))?,
            );
            app.manage(storage);
            app.manage(agents::AgentManager::default());
            app.manage(preparation::PreparationManager::default());
            app.manage(agents::models::CatalogManager::default());
            app.manage(review_creation::CaptureManager::default());
            app.manage(agents::setup::SetupManager::default());
            let language_sessions = language_servers::LanguageServers::default();
            let language_app = app.handle().clone();
            language_sessions.set_notifier(move || {
                use tauri::Emitter;
                let _ = language_app.emit("reviewbox:language-servers-changed", ());
            });
            app.manage(language_sessions);
            let installer = language_servers::install::LanguageServerInstaller::default();
            let language_app = app.handle().clone();
            installer.set_notifier(move || {
                use tauri::Emitter;
                let _ = language_app.emit("reviewbox:language-servers-changed", ());
            });
            app.manage(installer);
            Ok(())
        })
        .on_window_event(|window, event| {
            if matches!(event, tauri::WindowEvent::Destroyed) {
                window
                    .state::<illustrations::Illustrations>()
                    .release_window(window.label());
                window
                    .state::<agents::models::CatalogManager>()
                    .0
                    .stop_all();
            }
            if window.label() == "main" && matches!(event, tauri::WindowEvent::Destroyed) {
                window.state::<agents::AgentManager>().stop_all();
                window.state::<preparation::PreparationManager>().stop_all();
                window
                    .state::<review_creation::CaptureManager>()
                    .cancel_all();
                window.state::<agents::setup::SetupManager>().stop_all();
                window
                    .state::<language_servers::LanguageServers>()
                    .stop_all();
                window
                    .state::<language_servers::install::LanguageServerInstaller>()
                    .shutdown();
            }
        })
        .invoke_handler(tauri::generate_handler![
            app_info::get_app_info,
            appearance::appearance_settings,
            appearance::configure_appearance,
            appearance::editor_profiles,
            appearance::import_editor_icons,
            illustrations::register_illustration,
            illustrations::release_illustration,
            commands::list_repositories,
            commands::open_repository,
            commands::choose_repository,
            commands::forget_repository,
            commands::list_reviews,
            commands::create_review,
            commands::preview_review,
            commands::review_references,
            commands::create_review_operation,
            commands::cancel_review_creation,
            commands::choose_provider_executable,
            commands::install_provider,
            commands::cancel_provider_setup,
            commands::open_provider_login,
            commands::agent_preparation_context,
            commands::diagnose_proposal,
            commands::load_review,
            commands::update_review,
            commands::refresh_review,
            commands::delete_review,
            commands::read_change,
            commands::read_review_source,
            commands::read_review_file,
            commands::export_review_summary,
            commands::start_review_preparation,
            commands::get_review_preparation,
            commands::resume_review_preparation,
            commands::cancel_review_preparation,
            commands::review_coverage,
            commands::check_repository_changed,
            commands::read_snapshot_file,
            commands::preview_prompt,
            commands::load_knowledge,
            commands::save_knowledge,
            commands::provider_status,
            commands::provider_models,
            commands::cancel_provider_models,
            commands::start_agent,
            commands::cancel_agent,
            commands::language_server_settings,
            commands::configure_language_servers,
            commands::find_definition,
            commands::language_request,
            commands::cancel_language_request,
            commands::read_language_source,
            commands::release_language_snapshot,
            commands::language_repository_paths,
            language_servers::catalog::get_language_server_catalogue,
            language_servers::catalog::install_language_server,
            language_servers::catalog::cancel_language_server_install,
            language_servers::catalog::set_language_server_enabled,
            language_servers::catalog::uninstall_language_server,
            commands::proposal_from_run,
            commands::answer_proposal,
            commands::list_proposals,
            commands::list_onboarding_tours,
            commands::save_onboarding_tour,
            commands::read_onboarding_step,
            commands::import_onboarding_tour,
            commands::export_onboarding_tour,
            commands::review_history,
            commands::read_historical_review,
            commands::open_settings,
            commands::preview_agent_request,
            commands::reveal_storage,
            commands::provider_settings,
            commands::configure_providers,
            commands::project_settings,
            commands::configure_project,
            commands::list_agent_runs
        ])
        .build(tauri::generate_context!())
        .expect("failed to build ReviewBox")
        .run(|app, event| {
            if matches!(
                event,
                tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit
            ) {
                app.state::<agents::AgentManager>().stop_all();
                app.state::<preparation::PreparationManager>().stop_all();
                app.state::<agents::models::CatalogManager>().0.stop_all();
                app.state::<review_creation::CaptureManager>().cancel_all();
                app.state::<agents::setup::SetupManager>().stop_all();
                app.state::<language_servers::LanguageServers>().stop_all();
                app.state::<language_servers::install::LanguageServerInstaller>()
                    .shutdown();
                processes::shutdown();
            }
        });
}
