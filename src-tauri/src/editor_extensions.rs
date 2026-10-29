//! Built-in editor features and their private, pinned engines.
pub(crate) mod completions;
pub(crate) mod formatting;
use crate::{
    contracts::*,
    language_servers::{
        LanguageServers, catalog, install::LanguageServerInstaller, live::LiveLanguages,
    },
    storage::Storage,
};
use tauri::{Emitter, State};

pub(crate) fn settings(storage: &Storage) -> AppResult<EditorExtensionPreferences> {
    let mut value =
        match storage.get::<EditorExtensionPreferences>("editor_extensions", "preferences") {
            Ok(value) => value,
            Err(e) if e.code == "not_found" => {
                let mut value = EditorExtensionPreferences::default();
                for id in EditorExtensionId::ALL {
                    if let Some(server) = id.server()
                        && catalog::installed(storage, server)?.is_some_and(|s| !s.enabled)
                    {
                        value.enabled.insert(id, false);
                    }
                }
                value
            }
            Err(e) => return Err(e),
        };
    for id in EditorExtensionId::ALL {
        value.enabled.entry(id).or_insert(true);
    }
    Ok(value)
}
pub(crate) fn enabled(storage: &Storage, id: EditorExtensionId) -> AppResult<bool> {
    Ok(settings(storage)?.enabled.get(&id).copied().unwrap_or(true))
}
pub(crate) fn server_feature(server: &str) -> Option<EditorExtensionId> {
    EditorExtensionId::ALL
        .into_iter()
        .find(|id| id.server() == Some(server))
}
pub(crate) fn require_engine(storage: &Storage, server: &str) -> AppResult<()> {
    if let Some(id) = server_feature(server)
        && !enabled(storage, id)?
    {
        return Err(AppError::new(
            "extension_disabled",
            "Enable this feature in Settings > Extensions.",
        ));
    }
    Ok(())
}
pub(crate) fn update(
    storage: &Storage,
    id: EditorExtensionId,
    enabled: bool,
) -> AppResult<EditorExtensionPreferences> {
    let mut value = settings(storage)?;
    value.enabled.insert(id, enabled);
    save_settings(storage, value)
}
fn save_settings(
    storage: &Storage,
    mut value: EditorExtensionPreferences,
) -> AppResult<EditorExtensionPreferences> {
    match storage.get::<EditorExtensionPreferences>("editor_extensions", "preferences") {
        Ok(_) => {
            let revision = value.revision;
            value.revision += 1;
            storage.replace("editor_extensions", "preferences", revision, &value)?;
        }
        Err(e) if e.code == "not_found" => {
            value.revision = 0;
            storage.insert("editor_extensions", "preferences", &value)?;
        }
        Err(e) => return Err(e),
    }
    Ok(value)
}
#[tauri::command]
pub fn editor_extension_settings(
    storage: State<'_, Storage>,
) -> AppResult<EditorExtensionPreferences> {
    settings(&storage)
}
#[tauri::command]
pub fn set_editor_extension(
    app: tauri::AppHandle,
    storage: State<'_, Storage>,
    installer: State<'_, LanguageServerInstaller>,
    live: State<'_, LiveLanguages>,
    sessions: State<'_, LanguageServers>,
    id: EditorExtensionId,
    enabled: bool,
) -> AppResult<EditorExtensionPreferences> {
    let value = update(&storage, id, enabled)?;
    if let Some(server) = id.server() {
        let active = installer
            .operations()
            .into_iter()
            .filter(|o| {
                o.server_id == server && matches!(o.status.as_str(), "queued" | "installing")
            })
            .collect::<Vec<_>>();
        if !enabled {
            for operation in &active {
                let _ = installer.cancel(&operation.id);
            }
            live.stop_server(server);
            sessions.stop_server(server);
        }
    }
    if id == EditorExtensionId::Vue {
        live.invalidate_server("typescript");
    }
    let _ = app.emit("reviewbox:extensions-changed", &value);
    let _ = app.emit("reviewbox:language-servers-changed", ());
    Ok(value)
}
#[tauri::command]
pub fn ensure_editor_engine(
    storage: State<'_, Storage>,
    installer: State<'_, LanguageServerInstaller>,
    server_id: String,
) -> AppResult<Option<LanguageServerInstallOperation>> {
    ensure_engine(&storage, &installer, &server_id)
}
pub(crate) fn ensure_engine(
    storage: &Storage,
    installer: &LanguageServerInstaller,
    server_id: &str,
) -> AppResult<Option<LanguageServerInstallOperation>> {
    if !matches!(
        server_id,
        "typescript" | "html" | "css" | "vue" | "prisma" | "tailwind" | "slang" | "prettier"
    ) {
        return Err(AppError::new(
            "engine",
            "This engine requires explicit installation in Languages.",
        ));
    }
    require_engine(storage, server_id)?;
    if let Some(installed) = catalog::installed(storage, server_id)? {
        if server_feature(server_id).is_none() && !installed.enabled {
            return Err(AppError::new(
                "extension_disabled",
                "This engine was disabled in Settings > Languages.",
            ));
        }
        if installed.version == catalog::spec(server_id)?.version
            && std::path::Path::new(&installed.executable).is_file()
        {
            return Ok(None);
        }
    }
    installer
        .start(storage.clone(), server_id.into(), None)
        .map(Some)
}

#[tauri::command]
pub fn set_prettier_on_save(
    app: tauri::AppHandle,
    storage: State<'_, Storage>,
    enabled: bool,
) -> AppResult<EditorExtensionPreferences> {
    let mut value = settings(&storage)?;
    value.prettier_on_save = enabled;
    let value = save_settings(&storage, value)?;
    let _ = app.emit("reviewbox:extensions-changed", &value);
    Ok(value)
}
