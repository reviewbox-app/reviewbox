//! A saved, reviewable plan is the only input to installation/configuration execution.
use super::{
    catalog, install::LanguageServerInstaller, packs, session::Session, workspace::Workspace,
};
use crate::{contracts::*, storage::Storage};
use serde_json::json;
use std::{
    fs,
    io::Write,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};
use tauri::{Emitter, Manager, State, ipc::Channel};

#[derive(Default)]
pub struct Setup(pub crate::agents::AgentManager);

fn status_path(storage: &Storage, id: &str) -> AppResult<std::path::PathBuf> {
    if !catalog::valid_id(id) {
        return Err(AppError::new("invalid_plan", "Invalid plan ID."));
    }
    let directory = catalog::root(storage).join("setup");
    fs::create_dir_all(&directory)?;
    Ok(directory.join(format!("{id}.json")))
}
fn persist(storage: &Storage, status: &LanguageSetupStatus) -> AppResult<()> {
    let path = status_path(storage, &status.id)?;
    let mut file = tempfile::NamedTempFile::new_in(
        path.parent()
            .ok_or_else(|| AppError::new("invalid_path", "Missing setup directory."))?,
    )?;
    file.write_all(&serde_json::to_vec_pretty(status)?)?;
    file.as_file().sync_all()?;
    file.persist(path)
        .map_err(|e| AppError::new("setup_storage", e.to_string()))?;
    Ok(())
}
fn read_status(storage: &Storage, id: &str) -> AppResult<LanguageSetupStatus> {
    Ok(serde_json::from_slice(&fs::read(status_path(
        storage, id,
    )?)?)?)
}
fn check(cancel: &AtomicBool) -> AppResult<()> {
    if cancel.load(Ordering::SeqCst) {
        Err(AppError::new(
            "cancelled",
            "Language setup cancelled. Completed steps are listed below.",
        ))
    } else {
        Ok(())
    }
}
fn server_snapshot(
    storage: &Storage,
    plan: &LanguageSetupPlan,
) -> AppResult<Option<LanguageSetupServer>> {
    let Some(id) = &plan.server_id else {
        return Ok(None);
    };
    let registered = packs::all(storage)?;
    let pack = plan
        .pack
        .as_ref()
        .filter(|p| p.id == *id)
        .or_else(|| registered.iter().find(|p| p.id == *id));
    let server = if let Some(pack) = pack {
        packs::pack_spec(pack)
            .ok_or_else(|| AppError::new("invalid_plan", "The selected pack contains no server."))?
    } else {
        packs::spec(storage, id)?
    };
    let recipe = super::install::recipe(storage, server, pack.and_then(packs::pack_artifact))?;
    let mut frozen_recipe = serde_json::to_value(&recipe)?;
    // Root markers, grammar and initialization settings affect verification too.
    // Preserve them in the reviewed snapshot even when the pack is already installed.
    frozen_recipe["pack"] = serde_json::to_value(pack)?;
    Ok(Some(LanguageSetupServer {
        name: recipe.server.name.clone(),
        version: recipe
            .artifacts
            .get(id)
            .map(|a| a.version.clone())
            .unwrap_or_else(|| recipe.server.version.clone()),
        source_url: recipe.server.source_url.clone(),
        recipe: frozen_recipe,
    }))
}
fn check_server_snapshot(storage: &Storage, plan: &LanguageSetupPlan) -> AppResult<()> {
    if plan.server != server_snapshot(storage, plan)? {
        return Err(AppError::new(
            "stale_plan",
            "The language installation recipe changed. Request a new plan.",
        ));
    }
    Ok(())
}
pub(crate) fn validate_plan(
    storage: &Storage,
    root: &std::path::Path,
    plan: &mut LanguageSetupPlan,
) -> AppResult<()> {
    if plan.files.len() > 20 || plan.commands.len() > 10 || plan.summary.len() > 10_000 {
        return Err(AppError::new(
            "invalid_plan",
            "The language setup plan is too large.",
        ));
    }
    if let Some(pack) = &plan.pack {
        packs::validate(pack)?;
    }
    if let Some(server_id) = &plan.server_id
        && plan.pack.as_ref().is_none_or(|p| &p.id != server_id)
    {
        packs::spec(storage, server_id)?;
    }
    let mut paths = std::collections::HashSet::new();
    for file in &mut plan.files {
        if !paths.insert(file.path.clone()) || file.after.len() > 1024 * 1024 {
            return Err(AppError::new(
                "invalid_plan",
                "Invalid or repeated configuration file.",
            ));
        }
        let target = crate::editor::path(root, &file.path)?;
        if target.exists() {
            let current = crate::editor::read(root, &file.path)?;
            if current.read_only || file.before.as_deref() != Some(&current.text) {
                return Err(AppError::new(
                    "stale_plan",
                    "A proposed configuration does not match the current file. Request a new plan.",
                ));
            }
            file.expected_revision = Some(current.revision);
        } else {
            if file.before.is_some() {
                return Err(AppError::new(
                    "stale_plan",
                    "A proposed file no longer exists.",
                ));
            }
            file.expected_revision = None;
        }
    }
    for command in &plan.commands {
        if command.executable.trim().is_empty()
            || command.executable.contains('\0')
            || command.arguments.iter().any(|a| a.contains('\0'))
        {
            return Err(AppError::new("invalid_plan", "Invalid setup command."));
        }
        if command.directory != "." {
            crate::editor::path(root, &command.directory)?;
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn plan_language_setup(
    app: tauri::AppHandle,
    storage: State<'_, Storage>,
    manager: State<'_, Setup>,
    request: LanguageSetupRequest,
    channel: Channel<AgentEvent>,
) -> AppResult<LanguageSetupPlan> {
    let LanguageSetupRequest {
        repository_id,
        path,
        operation_id,
        diagnostic,
    } = request.clone();
    let cancel = manager.0.register(&operation_id)?;
    let result = async {
        let root = crate::repositories::root(&storage, &repository_id)?;
        crate::editor::path(&root, &path)?;
        let mut configurations = Vec::new();
        for name in ["package.json", "tsconfig.json", "jsconfig.json", "pyproject.toml", "Cargo.toml", "go.mod", "CMakeLists.txt", ".clangd", "compile_commands.json"] {
            if let Ok(file) = crate::editor::read(&root, name) && file.text.len() <= 128 * 1024 { configurations.push(file); }
        }
        let specs = packs::specs(&storage)?.into_iter().map(|s| json!({"id":s.id,"name":s.name,"languages":s.languages,"version":s.version,"sourceUrl":s.source_url,"prerequisites":s.prerequisites})).collect::<Vec<_>>();
        let tools = ["node", "python3", "cargo", "rust-analyzer", "clangd", "clang", "cmake", "go", "java", "dotnet"].into_iter().map(|name| {
            let executable = crate::agents::providers::resolve_executable(name);
            json!({"name":name,"path":executable,"found":std::path::Path::new(&executable).is_file()})
        }).collect::<Vec<_>>();
        let context = serde_json::to_string(&json!({"tools":tools,"path":path,"platform":catalog::platform(),"diagnostic":diagnostic,"configurations":configurations,"catalogue":specs,"installedPacks":packs::all(&storage)?}))?;
        let output = crate::agents::language_setup::plan(&storage, &root, &crate::commands::resource_root(&app)?, &request, context, cancel.clone(), channel).await?;
        check(&cancel)?;
        let text = output.trim().strip_prefix("```json").or_else(|| output.trim().strip_prefix("```" )).unwrap_or(output.trim()).trim().trim_end_matches("```").trim();
        let mut plan: LanguageSetupPlan = serde_json::from_str(text).map_err(|e| AppError::new("invalid_plan", format!("Rev returned an invalid setup plan: {e}")))?;
        plan.id = operation_id.clone(); plan.repository_id = repository_id; plan.path = path;
        validate_plan(&storage, &root, &mut plan)?;
        plan.server = server_snapshot(&storage, &plan)?;
        persist(&storage, &LanguageSetupStatus { id: plan.id.clone(), phase: "planned".into(), message: "Review the plan before applying it.".into(), completed_steps: vec![], plan: Some(plan.clone()), revisions: Default::default(), in_flight_command: None, log: String::new() })?;
        Ok(plan)
    }.await;
    manager.0.remove(&operation_id);
    result
}

#[tauri::command]
pub fn get_language_setup(
    storage: State<'_, Storage>,
    manager: State<'_, Setup>,
    plan_id: String,
) -> AppResult<LanguageSetupStatus> {
    recover_status(&storage, &manager, &plan_id)
}
fn recover_status(storage: &Storage, manager: &Setup, id: &str) -> AppResult<LanguageSetupStatus> {
    let mut status = read_status(storage, id)?;
    if status.phase == "applying" && !manager.0.is_active(id) {
        status.phase = "interrupted".into();
        status.message = "Setup was interrupted. Review completed steps before resuming.".into();
        persist(storage, &status)?;
    }
    let path = status_path(storage, id)?.with_extension("log");
    if let Ok(mut file) = fs::File::open(path) {
        use std::io::{Read, Seek, SeekFrom};
        let length = file.metadata()?.len();
        file.seek(SeekFrom::Start(length.saturating_sub(32768)))?;
        let mut bytes = Vec::new();
        file.take(32768).read_to_end(&mut bytes)?;
        status.log = String::from_utf8_lossy(&bytes).into_owned();
    }
    Ok(status)
}
#[tauri::command]
pub fn latest_language_setup(
    storage: State<'_, Storage>,
    manager: State<'_, Setup>,
    repository_id: String,
    path: String,
) -> AppResult<Option<LanguageSetupStatus>> {
    let directory = status_path(&storage, "index")?
        .parent()
        .expect("setup directory")
        .to_path_buf();
    let mut entries = fs::read_dir(directory)?
        .filter_map(Result::ok)
        .filter(|e| e.path().extension().is_some_and(|x| x == "json"))
        .collect::<Vec<_>>();
    entries.sort_by_key(|e| std::cmp::Reverse(e.metadata().and_then(|m| m.modified()).ok()));
    for entry in entries {
        let Ok(status) = serde_json::from_slice::<LanguageSetupStatus>(&fs::read(entry.path())?)
        else {
            continue;
        };
        if status
            .plan
            .as_ref()
            .is_some_and(|p| p.repository_id == repository_id && p.path == path)
            && status.phase != "ready"
        {
            return recover_status(&storage, &manager, &status.id).map(Some);
        }
    }
    Ok(None)
}
#[tauri::command]
pub fn cancel_language_setup(manager: State<'_, Setup>, operation_id: String) -> AppResult<()> {
    manager.0.cancel(&operation_id)
}

#[tauri::command]
pub fn apply_language_setup(
    app: tauri::AppHandle,
    storage: State<'_, Storage>,
    manager: State<'_, Setup>,
    plan_id: String,
) -> AppResult<LanguageSetupStatus> {
    let mut status = recover_status(&storage, &manager, &plan_id)?;
    if status.phase == "ready" {
        return Ok(status);
    }
    if !matches!(
        status.phase.as_str(),
        "planned" | "cancelled" | "incomplete" | "interrupted"
    ) || status.in_flight_command.is_some()
    {
        return Err(AppError::new(
            "setup_interrupted",
            "Request a new plan using the completed steps before retrying.",
        ));
    }
    let plan = status
        .plan
        .clone()
        .ok_or_else(|| AppError::new("invalid_plan", "Missing setup plan."))?;
    let root = crate::repositories::root(&storage, &plan.repository_id)?;
    check_server_snapshot(&storage, &plan)?;
    if let Some(pack) = &plan.pack
        && status
            .completed_steps
            .contains(&format!("Registered pack {}", pack.name))
        && packs::all(&storage)?
            .iter()
            .find(|p| p.id == pack.id)
            .map(serde_json::to_value)
            .transpose()?
            != Some(serde_json::to_value(pack)?)
    {
        return Err(AppError::new(
            "stale_plan",
            "The registered pack changed. Request a new plan.",
        ));
    }
    // Validate the saved plan without accepting fresh versions as implicit approval.
    let mut checked = plan.clone();
    for file in &mut checked.files {
        if let Some(revision) = status.revisions.get(&file.path) {
            let current = crate::editor::read(&root, &file.path)?;
            if current.revision != *revision {
                return Err(AppError::new(
                    "stale_plan",
                    "A completed configuration changed. Request a new plan.",
                ));
            }
            file.before = Some(current.text);
        }
    }
    validate_plan(&storage, &root, &mut checked)?;
    if checked.files.iter().zip(&plan.files).any(|(a, b)| {
        !status.revisions.contains_key(&b.path) && a.expected_revision != b.expected_revision
    }) {
        return Err(AppError::new(
            "stale_plan",
            "Configuration changed since the plan was prepared.",
        ));
    }
    let cancel = manager.0.register(&plan_id)?;
    status.phase = "applying".into();
    status.message = "Applying the approved plan…".into();
    persist(&storage, &status)?;
    let initial = status.clone();
    let storage = storage.inner().clone();
    tauri::async_runtime::spawn(async move {
        let result = execute_plan(&app, &storage, &root, &plan, &mut status, cancel).await;
        match result {
            Ok(()) => {
                status.phase = "ready".into();
                status.message = if plan.server_id.is_some() {
                    "Language support verified."
                } else {
                    "Language configuration applied."
                }
                .into();
            }
            Err(error) => {
                status.phase = if error.code == "cancelled" {
                    "cancelled"
                } else {
                    "incomplete"
                }
                .into();
                status.message = error.message;
            }
        }
        let _ = persist(&storage, &status);
        app.state::<Setup>().0.remove(&plan_id);
        let _ = app.emit("reviewbox:language-packs-changed", ());
        let _ = app.emit("reviewbox:language-servers-changed", ());
    });
    Ok(initial)
}
async fn execute_plan(
    app: &tauri::AppHandle,
    storage: &Storage,
    root: &std::path::Path,
    plan: &LanguageSetupPlan,
    status: &mut LanguageSetupStatus,
    cancel: Arc<AtomicBool>,
) -> AppResult<()> {
    check(&cancel)?;
    if let Some(pack) = &plan.pack
        && !status
            .completed_steps
            .contains(&format!("Registered pack {}", pack.name))
    {
        packs::save(storage, pack)?;
        status
            .completed_steps
            .push(format!("Registered pack {}", pack.name));
        persist(storage, status)?;
    }
    if let Some(server_id) = &plan.server_id
        && !status
            .completed_steps
            .contains(&format!("Installed {server_id}"))
    {
        let installer = app.state::<LanguageServerInstaller>();
        let approved = plan.server.as_ref().ok_or_else(|| {
            AppError::new("invalid_plan", "Missing approved installation recipe.")
        })?;
        let recipe = serde_json::from_value(approved.recipe.clone())?;
        let operation = installer.start_recipe(storage.clone(), recipe, None)?;
        loop {
            if cancel.load(Ordering::SeqCst) {
                let _ = installer.cancel(&operation.id);
                check(&cancel)?;
            }
            let current = installer
                .operations()
                .into_iter()
                .find(|o| o.id == operation.id)
                .ok_or_else(|| {
                    AppError::new("installation", "Installation status is unavailable.")
                })?;
            status.message = current.message.clone();
            persist(storage, status)?;
            match current.status.as_str() {
                "ready" => break,
                "failed" | "cancelled" | "interrupted" => {
                    return Err(AppError::new("installation", current.message));
                }
                _ => tokio::time::sleep(Duration::from_millis(250)).await,
            }
        }
        status
            .completed_steps
            .push(format!("Installed {server_id}"));
        persist(storage, status)?;
    }
    for file in &plan.files {
        if status.revisions.contains_key(&file.path) {
            continue;
        }
        check(&cancel)?;
        let state = app.state::<crate::editor::commands::EditorState>();
        let _guard = state.mutation.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(revision) = &file.expected_revision {
            crate::editor::mutate(
                root,
                EditorMutation::Save {
                    path: file.path.clone(),
                    text: file.after.clone(),
                    expected_revision: revision.clone(),
                },
            )?;
        } else {
            crate::editor::mutate(
                root,
                EditorMutation::Create {
                    path: file.path.clone(),
                    directory: false,
                },
            )?;
            crate::editor::mutate(
                root,
                EditorMutation::Save {
                    path: file.path.clone(),
                    text: file.after.clone(),
                    expected_revision: fingerprint(&[]),
                },
            )?;
        }
        status.revisions.insert(
            file.path.clone(),
            crate::editor::revision(&crate::editor::path(root, &file.path)?)?,
        );
        status
            .completed_steps
            .push(format!("Configured {}", file.path));
        persist(storage, status)?;
        storage.repository_cache.invalidate(root);
    }
    for (index, command) in plan.commands.iter().enumerate() {
        let step = format!("Command {}: {}", index + 1, command.purpose);
        if status.completed_steps.contains(&step) {
            continue;
        }
        check(&cancel)?;
        status.in_flight_command = Some(index);
        status.message = command.purpose.clone();
        persist(storage, status)?;
        let directory = if command.directory == "." {
            root.to_path_buf()
        } else {
            crate::editor::path(root, &command.directory)?
        };
        let log = fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(status_path(storage, &plan.id)?.with_extension("log"))?;
        let mut process = tokio::process::Command::new(&command.executable);
        process
            .args(&command.arguments)
            .current_dir(directory)
            .kill_on_drop(true)
            .stdin(std::process::Stdio::null())
            .stdout(log.try_clone()?)
            .stderr(log);
        #[cfg(unix)]
        process.process_group(0);
        let mut child = process.spawn()?;
        let group = crate::processes::ProcessGroup::new(
            child
                .id()
                .ok_or_else(|| AppError::new("process", "Missing process ID."))?,
        );
        let result = loop {
            if cancel.load(Ordering::SeqCst) {
                group.terminate();
                break Err(AppError::new("cancelled", "Setup command cancelled."));
            }
            if let Some(exit) = child.try_wait()? {
                break if exit.success() {
                    Ok(())
                } else {
                    Err(AppError::new(
                        "setup_command",
                        format!(
                            "{} failed. See the setup log in application storage.",
                            command.purpose
                        ),
                    ))
                };
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        };
        group.terminate();
        result?;
        status.in_flight_command = None;
        status.completed_steps.push(step);
        persist(storage, status)?;
    }
    check(&cancel)?;
    if let Some(server_id) = &plan.server_id {
        status.message = "Verifying the language server…".into();
        persist(storage, status)?;
        let server = catalog::resolve_language(storage, &plan.path, None, Some(server_id))?;
        if server.id != *server_id {
            return Err(AppError::new(
                "language_selection",
                "Another configured server takes priority. Select the installed server in language settings.",
            ));
        }
        let (project, settings) =
            super::live::project_configuration(storage, root, &plan.path, server_id)?;
        let session = Session::spawn(
            server.clone(),
            Workspace::live(project),
            catalog::launch_environment(storage, &server)?,
        )?;
        *session
            .live_settings
            .lock()
            .unwrap_or_else(|e| e.into_inner()) = settings;
        let result: AppResult<()> = async {
            session.initialize().await?;
            let file = crate::editor::read(root, &plan.path)?;
            let languages = packs::registry(storage)?.languages;
            let language = packs::detect_language(&languages, &plan.path, file.text.lines().next()).map(|l| l.lsp_id.clone()).unwrap_or_else(|| "plaintext".into());
            session.send(&json!({"jsonrpc":"2.0","method":"textDocument/didOpen","params":{"textDocument":{"uri":file.uri,"languageId":language,"version":1,"text":file.text}}})).await?;
            let caps = session.capability_data();
            for (capability, method, extra) in [
                ("documentSymbolProvider", "textDocument/documentSymbol", json!({})),
                ("completionProvider", "textDocument/completion", json!({"position":{"line":0,"character":0}})),
                ("definitionProvider", "textDocument/definition", json!({"position":{"line":0,"character":0}})),
            ] {
                if caps[capability].is_null() || caps[capability] == false { continue; }
                let mut params = extra; params["textDocument"] = json!({"uri":file.uri});
                session.rpc("verify", method, params, Some(&cancel)).await?;
            }
            Ok(())
        }.await;
        session.stop();
        result?;
        status
            .completed_steps
            .push("Server initialization and supported queries succeeded".into());
    }
    app.state::<super::live::LiveLanguages>().stop_all();
    if !plan.prerequisites.is_empty() {
        return Err(AppError::new(
            "setup_prerequisites",
            format!(
                "Completed the available steps. Remaining prerequisites: {}",
                plan.prerequisites.join("; ")
            ),
        ));
    }
    Ok(())
}

#[cfg(test)]
#[path = "setup_tests.rs"]
mod tests;
