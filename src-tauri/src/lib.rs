mod agents;
mod app_info;
mod appearance;
mod commands;
pub mod contracts;
mod diagnostics;
mod editor;
mod editor_extensions;
mod illustrations;
mod integrations;
mod knowledge;
pub use integrations::run_cli;
mod editor_menu;
mod language_servers;
mod notifications;
mod onboarding;
mod preparation;
mod processes;
mod project_skills;
mod project_storage;
#[cfg(test)]
mod project_storage_tests;
mod prompts;
mod proposals;
mod reader;
mod repositories;
mod repository_cache;
mod review_comments;
mod review_creation;
mod review_menu;
mod reviews;
mod snapshots;
mod source_control;
mod storage;
mod terminals;
mod working_context;
pub use project_storage::schemas as project_schemas;
use tauri::Manager;

pub fn run() {
    let builder = tauri::Builder::default();
    #[cfg(feature = "native-validation")]
    let builder = builder.plugin(tauri_plugin_wdio_webdriver::init());
    builder
        .manage(illustrations::Illustrations::default())
        .manage(editor::commands::EditorState::default())
        .manage(terminals::Terminals::default())
        .manage(notifications::Notifications::default())
        .manage(language_servers::live::LiveLanguages::default())
        .manage(language_servers::setup::Setup::default())
        .register_uri_scheme_protocol("reviewbox-illustration", illustrations::protocol)
        .plugin(
            tauri::plugin::Builder::<tauri::Wry, ()>::new("reader-isolation")
                .on_navigation(|_, url| illustrations::navigation_allowed(url))
                .build(),
        )
        .setup(|app| {
            #[cfg(target_os = "macos")]
            editor::macos::install(app.handle())?;
            review_menu::install(app.handle())?;
            #[cfg(not(feature = "native-validation"))]
            let data_dir = app.path().app_data_dir()?;
            #[cfg(feature = "native-validation")]
            let data_dir = std::env::var_os("REVIEWBOX_VALIDATION_DATA")
                .map(std::path::PathBuf::from)
                .ok_or_else(|| {
                    std::io::Error::other("Validation requires an isolated data directory")
                })?;
            let error_log =
                std::sync::Arc::new(diagnostics::Diagnostics::new(data_dir.join("logs")));
            diagnostics::install_panic_hook(&error_log);
            app.manage(error_log.clone());
            let storage = storage::Storage::open(data_dir.clone()).map_err(|e| {
                let _ = error_log.record(contracts::DiagnosticInput {
                    source: "native".into(),
                    operation: "startup".into(),
                    code: e.code,
                    message: e.message.clone(),
                    details: e.details,
                    stack: None,
                    context: Default::default(),
                });
                std::io::Error::other(e.message)
            })?;
            #[cfg(unix)]
            app.manage(
                integrations::LocalBridge::start(storage.clone(), &data_dir)
                    .map_err(|e| std::io::Error::other(e.message))?,
            );
            let cache_app = app.handle().clone();
            storage.repository_cache.set_notifier(move |repository_id| {
                use tauri::Emitter;
                let _ = cache_app.emit("reviewbox:repository-read-invalidated", repository_id);
            });
            let live = app
                .state::<language_servers::live::LiveLanguages>()
                .inner()
                .clone();
            storage
                .repository_cache
                .set_native_notifier(move |root, change| {
                    let live = live.clone();
                    let root = root.to_path_buf();
                    let change = change.clone();
                    tauri::async_runtime::spawn(async move {
                        live.repository_changed(&root, &change).await;
                    });
                });
            app.manage(storage);
            app.manage(source_control::SourceControl::default());
            notifications::install(app.handle());
            let notification_app = app.handle().clone();
            app.manage(
                preparation::PreparationManager::with_ready_notifier(move |target| {
                    notifications::review_ready(&notification_app, target);
                })
                .with_diagnostics(error_log),
            );
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
            if window.label() == "main"
                && let tauri::WindowEvent::CloseRequested { api, .. } = event
                && editor::commands::confirm_exit(window.app_handle())
            {
                api.prevent_close();
            }
            if matches!(event, tauri::WindowEvent::Focused(true)) {
                review_menu::focused(window.app_handle(), window.label());
                editor_menu::focused(window.app_handle(), window.label());
            }
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
                window.state::<terminals::Terminals>().stop_all();
                notifications::shutdown(window.app_handle());
                window
                    .state::<language_servers::setup::Setup>()
                    .0
                    .stop_all();
                window
                    .state::<language_servers::live::LiveLanguages>()
                    .stop_all();
                window.state::<source_control::SourceControl>().stop_all();
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
            project_skills::project_skill_preferences,
            project_skills::configure_project_skills,
            project_skills::import_project_skills,
            working_context::review_working_context,
            working_context::retry_working_context_cleanup,
            review_comments::read_review_comments,
            review_comments::mutate_review_comment,
            editor::commands::editor_navigation,
            editor::commands::editor_store_navigation,
            terminals::terminal_create,
            terminals::terminal_list,
            terminals::terminal_write,
            terminals::terminal_resize,
            terminals::terminal_ack,
            terminals::terminal_close,
            terminals::terminal_open_url,
            terminals::terminal_resolve_file,
            app_info::get_app_info,
            diagnostics::diagnostics_record,
            diagnostics::diagnostics_read,
            diagnostics::diagnostics_reveal,
            notifications::pending_review_notification,
            notifications::acknowledge_review_notification,
            language_servers::packs::language_registry,
            language_servers::packs::export_language_pack,
            language_servers::packs::save_language_pack,
            language_servers::packs::remove_language_pack,
            language_servers::setup::plan_language_setup,
            language_servers::setup::get_language_setup,
            language_servers::setup::latest_language_setup,
            language_servers::setup::cancel_language_setup,
            language_servers::setup::apply_language_setup,
            language_servers::live::live_language_open,
            language_servers::live::live_language_sync,
            language_servers::live::live_language_request,
            language_servers::live::live_language_close,
            language_servers::live::live_language_cancel,
            language_servers::live::live_language_restart,
            language_servers::live::live_language_source,
            language_servers::project::get_live_language_project_settings,
            language_servers::project::set_live_language_project_settings,
            editor::commands::editor_inventory,
            editor::commands::editor_watch,
            editor::commands::editor_watch_status,
            editor::commands::editor_search_content,
            editor::commands::editor_cancel_search,
            editor::commands::editor_read,
            editor::commands::editor_revision,
            editor::commands::editor_mutate,
            editor::commands::editor_recovery,
            editor::commands::editor_store_recovery,
            editor::commands::editor_dirty,
            editor::commands::editor_exit,
            knowledge::context::release_code_context,
            knowledge::context::code_explain_context,
            source_control::commands::local_git_state,
            source_control::commands::local_file_diff,
            source_control::commands::stage_local_file,
            source_control::commands::stage_local_files,
            source_control::commands::reveal_local_path,
            source_control::commands::discard_local_files,
            source_control::commands::git_commit_detail,
            source_control::commands::fetch_git_remote,
            source_control::commands::push_git_branch,
            source_control::commands::list_git_branches,
            source_control::commands::switch_git_branch,
            source_control::commands::commit_local_changes,
            source_control::commands::cancel_git_operation,
            source_control::commands::last_git_operation,
            review_menu::configure_review_menu,
            editor_menu::configure_editor_menu,
            review_menu::configure_repository_menu,
            appearance::appearance_settings,
            appearance::configure_appearance,
            appearance::system_code_fonts,
            editor_extensions::editor_extension_settings,
            editor_extensions::set_prettier_on_save,
            editor_extensions::set_editor_extension,
            editor_extensions::ensure_editor_engine,
            editor_extensions::formatting::format_editor_document,
            editor_extensions::completions::complete_editor_paths,
            illustrations::register_illustration,
            illustrations::release_illustration,
            commands::list_repositories,
            commands::open_repository,
            commands::choose_repository,
            commands::forget_repository,
            commands::list_reviews,
            commands::create_review,
            commands::preview_review,
            commands::cancel_repository_read,
            commands::review_references,
            commands::create_review_operation,
            commands::cancel_review_creation,
            commands::choose_provider_executable,
            commands::check_provider_updates,
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
            commands::update_review_with_rev,
            commands::discard_review_update,
            commands::resume_review_preparation,
            commands::cancel_review_preparation,
            commands::review_coverage,
            commands::check_repository_changed,
            commands::check_review_freshness,
            commands::read_snapshot_file,
            commands::load_knowledge,
            commands::save_knowledge,
            commands::provider_status,
            commands::provider_models,
            commands::cancel_provider_models,
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
            commands::answer_proposal,
            commands::list_onboarding_tours,
            commands::save_onboarding_tour,
            commands::read_onboarding_step,
            commands::import_onboarding_tour,
            commands::export_onboarding_tour,
            commands::open_settings,
            commands::reveal_storage,
            commands::provider_settings,
            commands::configure_providers,
            commands::project_settings,
            commands::configure_project,
        ])
        .build(tauri::generate_context!())
        .expect("failed to build ReviewBox")
        .run(|app, event| {
            if let tauri::RunEvent::ExitRequested { ref api, .. } = event
                && editor::commands::confirm_exit(app)
            {
                api.prevent_exit();
                return;
            }
            if matches!(
                event,
                tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit
            ) {
                app.state::<language_servers::setup::Setup>().0.stop_all();
                app.state::<terminals::Terminals>().stop_all();
                app.state::<language_servers::live::LiveLanguages>()
                    .stop_all();
                app.state::<preparation::PreparationManager>().stop_all();
                app.state::<agents::models::CatalogManager>().0.stop_all();
                app.state::<review_creation::CaptureManager>().cancel_all();
                app.state::<agents::setup::SetupManager>().stop_all();
                app.state::<language_servers::LanguageServers>().stop_all();
                app.state::<language_servers::install::LanguageServerInstaller>()
                    .shutdown();
                let storage = app.state::<storage::Storage>();
                storage.repository_cache.shutdown(&storage);
                processes::shutdown();
            }
        });
}
