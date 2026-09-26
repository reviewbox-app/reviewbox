mod agents;
mod app_info;
mod commands;
pub mod contracts;
mod evidence;
mod integrations;
mod knowledge;
pub use integrations::run_cli;
mod language_servers;
mod onboarding;
mod processes;
mod project_storage;
#[cfg(test)]
mod project_storage_tests;
mod prompts;
mod proposals;
mod repositories;
mod reviews;
mod snapshots;
mod storage;
pub use project_storage::schemas as project_schemas;
mod tours;
use tauri::Manager;

pub fn run() {
    let builder = tauri::Builder::default();
    #[cfg(feature = "native-validation")]
    let builder = builder.plugin(tauri_plugin_wdio_webdriver::init());
    builder
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
            Ok(())
        })
        .on_window_event(|window, event| {
            if window.label() == "main" && matches!(event, tauri::WindowEvent::Destroyed) {
                window.state::<agents::AgentManager>().stop_all();
            }
        })
        .invoke_handler(tauri::generate_handler![
            app_info::get_app_info,
            commands::list_repositories,
            commands::open_repository,
            commands::choose_repository,
            commands::forget_repository,
            commands::list_reviews,
            commands::create_review,
            commands::load_review,
            commands::update_review,
            commands::refresh_review,
            commands::delete_review,
            commands::read_change,
            commands::review_coverage,
            commands::check_repository_changed,
            commands::read_snapshot_file,
            commands::preview_prompt,
            commands::load_knowledge,
            commands::save_knowledge,
            commands::provider_status,
            commands::export_tour,
            commands::import_tour,
            commands::start_agent,
            commands::cancel_agent,
            commands::prepare_test,
            commands::answer_test_permission,
            commands::cancel_test,
            commands::list_test_runs,
            commands::language_server_settings,
            commands::configure_language_servers,
            commands::find_definition,
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
        .run(tauri::generate_context!())
        .expect("failed to run ReviewBox");
}
