use crate::{contracts::*, storage::Storage};
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    fs,
    path::{Path, PathBuf},
};

use super::install::LanguageServerInstaller;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ServerSpec {
    pub id: String,
    pub name: String,
    pub description: String,
    pub languages: Vec<String>,
    #[serde(default)]
    pub extensions: Vec<String>,
    pub version: String,
    pub method: String,
    pub source_url: String,
    pub runtime: Option<String>,
    pub prerequisites: Vec<String>,
    #[serde(default)]
    pub setup_required: Option<String>,
    #[serde(default)]
    pub package: String,
    #[serde(default)]
    pub bin: String,
    #[serde(default)]
    pub arguments: Vec<String>,
    #[serde(default)]
    pub packages: BTreeMap<String, String>,
    #[serde(default)]
    pub overrides: BTreeMap<String, String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Artifact {
    pub id: String,
    pub version: String,
    pub platform: String,
    pub url: String,
    #[serde(default)]
    pub sha256: Option<String>,
    #[serde(default)]
    pub sha512: Option<String>,
    pub format: String,
    pub executable: String,
    #[serde(default)]
    pub arguments: Vec<String>,
    #[serde(default)]
    pub strip_components: usize,
    #[serde(default)]
    pub dependencies: Vec<String>,
    #[serde(default)]
    pub recipe: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct InstalledServer {
    pub version: String,
    pub enabled: bool,
    pub executable: String,
    pub arguments: Vec<String>,
    pub environment: BTreeMap<String, String>,
    /// Only this directory is eligible for uninstallation. Toolchain detection has none.
    pub directory: Option<PathBuf>,
}

pub(crate) fn specs() -> AppResult<Vec<ServerSpec>> {
    let mut specs: Vec<ServerSpec> =
        serde_json::from_str(include_str!("../../../resources/languages/catalogue.json"))?;
    let languages = super::packs::builtin_languages();
    for spec in &mut specs {
        spec.extensions = languages
            .iter()
            .filter(|l| spec.languages.contains(&l.lsp_id))
            .flat_map(|l| l.extensions.clone())
            .collect();
    }
    Ok(specs)
}
pub(crate) fn spec(id: &str) -> AppResult<ServerSpec> {
    specs()?
        .into_iter()
        .find(|item| item.id == id)
        .ok_or_else(|| {
            AppError::new(
                "unknown_language_server",
                "This language server is not in the bundled catalogue.",
            )
        })
}
pub(crate) fn platform() -> String {
    format!(
        "{}-{}",
        if std::env::consts::OS == "macos" {
            "darwin"
        } else {
            std::env::consts::OS
        },
        std::env::consts::ARCH
    )
}
pub(crate) fn artifact(id: &str) -> AppResult<Artifact> {
    let artifacts: Vec<Artifact> = serde_json::from_str(include_str!(
        "../../../resources/languages/native-artifacts.json"
    ))?;
    artifacts
        .into_iter()
        .find(|item| item.id == id && item.platform == platform())
        .ok_or_else(|| {
            AppError::new(
                "unsupported_platform",
                format!(
                    "No verified {id} installation is available for {}.",
                    platform()
                ),
            )
        })
}
pub(crate) fn root(storage: &Storage) -> PathBuf {
    storage.root().join("language-servers")
}
pub(crate) fn installed(storage: &Storage, id: &str) -> AppResult<Option<InstalledServer>> {
    if !valid_id(id) {
        return Err(AppError::new(
            "invalid_server",
            "Invalid language server ID.",
        ));
    }
    match fs::read(root(storage).join("state").join(format!("{id}.json"))) {
        Ok(bytes) => Ok(Some(serde_json::from_slice(&bytes)?)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error.into()),
    }
}
pub(crate) fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'+'))
        && id != "."
        && id != ".."
}
pub(crate) fn save_installed(
    storage: &Storage,
    id: &str,
    value: &InstalledServer,
) -> AppResult<()> {
    if !valid_id(id) {
        return Err(AppError::new(
            "invalid_server",
            "Invalid language server ID.",
        ));
    }
    let directory = root(storage).join("state");
    fs::create_dir_all(&directory)?;
    let mut temporary = tempfile::NamedTempFile::new_in(&directory)?;
    use std::io::Write;
    temporary.write_all(&serde_json::to_vec(value)?)?;
    temporary.as_file().sync_all()?;
    temporary
        .persist(directory.join(format!("{id}.json")))
        .map_err(|error| AppError::from(error.error))?;
    Ok(())
}

fn matches_path(server: &ServerSpec, path: &str, languages: &[LanguageDefinition]) -> bool {
    super::packs::detect_language(languages, path, None)
        .is_some_and(|l| server.languages.contains(&l.lsp_id))
}

pub(crate) fn resolve(storage: &Storage, path: &str) -> AppResult<LanguageServerConfig> {
    resolve_language(storage, path, None, None)
}
pub(crate) fn resolve_language(
    storage: &Storage,
    path: &str,
    language: Option<&str>,
    selected: Option<&str>,
) -> AppResult<LanguageServerConfig> {
    let extension = Path::new(path)
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("");
    if selected.is_none()
        && let Ok(settings) = storage.get::<LanguageServerSettings>("language_servers", "settings")
        && let Some(server) = settings.servers.into_iter().find(|server| {
            server
                .extensions
                .iter()
                .any(|value| value.eq_ignore_ascii_case(extension))
        })
    {
        return Ok(server);
    }
    let candidates = super::packs::specs(storage)?;
    let languages = super::packs::registry(storage)?.languages;
    let candidate = candidates.iter().find(|server| {
        if let Some(id) = selected {
            server.id == id
        } else if let Some(id) = language {
            server.languages.iter().any(|l| l == id)
        } else {
            matches_path(server, path, &languages)
        }
    });
    if let Some(reason) = candidate.and_then(|server| server.setup_required.as_ref()) {
        return Err(AppError::new("language_server_setup_required", reason));
    }
    if let Some(server) = candidate
        && let Some(receipt) = installed(storage, &server.id)?
    {
        if !receipt.enabled {
            return Err(AppError::new(
                "language_server_disabled",
                format!("{} is disabled in Settings > Languages.", server.name),
            ));
        }
        if !Path::new(&receipt.executable).is_file()
            && receipt.executable.contains(std::path::MAIN_SEPARATOR)
        {
            return Err(AppError::new(
                "language_server_missing",
                format!("Reinstall {} in Settings > Languages.", server.name),
            ));
        }
        return Ok(LanguageServerConfig {
            id: server.id.clone(),
            name: server.name.clone(),
            extensions: server.extensions.clone(),
            executable: receipt.executable,
            arguments: receipt.arguments,
        });
    }
    // Explicit legacy/manual configuration remains a supported local escape hatch.
    super::settings(storage)?
        .servers
        .into_iter()
        .find(|server| {
            selected.is_none_or(|id| id == server.id)
                && (server
                    .extensions
                    .iter()
                    .any(|value| value.eq_ignore_ascii_case(extension))
                    || language.is_some_and(|id| {
                        super::packs::builtin_languages().iter().any(|l| {
                            l.lsp_id == id
                                && l.extensions.iter().any(|e| server.extensions.contains(e))
                        })
                    }))
        })
        .ok_or_else(|| {
            AppError::new(
                "missing_language_server",
                "Install or enable a language server in Settings > Languages.",
            )
        })
}
pub(crate) fn launch_environment(
    storage: &Storage,
    server: &LanguageServerConfig,
) -> AppResult<Vec<(String, String)>> {
    Ok(installed(storage, &server.id)?
        .filter(|receipt| receipt.executable == server.executable)
        .map(|receipt| receipt.environment.into_iter().collect())
        .unwrap_or_default())
}

pub(crate) fn catalogue(
    storage: &Storage,
    installer: &LanguageServerInstaller,
) -> AppResult<LanguageServerCatalogue> {
    installer.recover(storage)?;
    let operations = installer.operations();
    let mut entries = Vec::new();
    for server in super::packs::specs(storage)? {
        let native = (server.method == "native")
            .then(|| super::packs::artifact(storage, &server.id).ok())
            .flatten();
        let supported = server.setup_required.is_none()
            && match server.method.as_str() {
                "npm" => artifact("runtime-node").is_ok(),
                "go" => artifact("runtime-go").is_ok(),
                "ruby" => artifact("runtime-ruby").is_ok(),
                "swift" => std::env::consts::OS == "macos",
                "external" => true,
                _ => native.is_some(),
            };
        let receipt = installed(storage, &server.id)?;
        let operation = operations
            .iter()
            .rev()
            .find(|operation| operation.server_id == server.id);
        let active = operation
            .filter(|operation| matches!(operation.status.as_str(), "queued" | "installing"));
        let error = operation
            .filter(|operation| matches!(operation.status.as_str(), "failed" | "interrupted"))
            .map(|operation| operation.message.clone());
        let status = if server.setup_required.is_some() {
            "setup-required"
        } else if active.is_some() {
            "installing"
        } else if receipt.as_ref().is_some_and(|value| !value.enabled) {
            "disabled"
        } else if receipt.is_some() {
            "installed"
        } else if !supported {
            "unsupported"
        } else if error.is_some() {
            "failed"
        } else {
            "available"
        };
        entries.push(LanguageServerCatalogueEntry {
            preview: matches!(server.id.as_str(), "kotlin" | "csharp"),
            capabilities: None,
            live_capabilities: None,
            id: server.id,
            name: server.name,
            description: server.description,
            languages: server.languages,
            extensions: server.extensions,
            version: if server.method == "swift" {
                receipt
                    .as_ref()
                    .map(|value| value.version.clone())
                    .unwrap_or(server.version)
            } else {
                native
                    .map(|artifact| artifact.version)
                    .unwrap_or(server.version)
            },
            installed_version: receipt.as_ref().map(|value| value.version.clone()),
            status: status.into(),
            enabled: receipt.as_ref().is_some_and(|value| value.enabled),
            supported,
            setup_required: server.setup_required,
            source_url: server.source_url,
            runtime: server.runtime,
            prerequisites: server.prerequisites,
            error,
        });
    }
    Ok(LanguageServerCatalogue {
        entries,
        operations,
    })
}

#[tauri::command]
pub fn get_language_server_catalogue(
    storage: tauri::State<'_, Storage>,
    installer: tauri::State<'_, LanguageServerInstaller>,
    sessions: tauri::State<'_, super::LanguageServers>,
    live: tauri::State<'_, super::live::LiveLanguages>,
) -> AppResult<LanguageServerCatalogue> {
    let mut result = catalogue(&storage, &installer)?;
    for entry in &mut result.entries {
        entry.capabilities = sessions.capabilities(&entry.id);
        entry.live_capabilities = live.capabilities(&entry.id);
    }
    Ok(result)
}
#[tauri::command]
pub fn install_language_server(
    server_id: String,
    storage: tauri::State<'_, Storage>,
    installer: tauri::State<'_, LanguageServerInstaller>,
    sessions: tauri::State<'_, super::LanguageServers>,
    live: tauri::State<'_, super::live::LiveLanguages>,
) -> AppResult<LanguageServerInstallOperation> {
    let operation = installer.start(
        storage.inner().clone(),
        server_id.clone(),
        Some(sessions.inner().clone()),
    )?;
    live.stop_server(&server_id);
    Ok(operation)
}
#[tauri::command]
pub fn cancel_language_server_install(
    operation_id: String,
    installer: tauri::State<'_, LanguageServerInstaller>,
) -> AppResult<()> {
    installer.cancel(&operation_id)
}
#[tauri::command]
pub async fn set_language_server_enabled(
    server_id: String,
    enabled: bool,
    storage: tauri::State<'_, Storage>,
    installer: tauri::State<'_, LanguageServerInstaller>,
    sessions: tauri::State<'_, super::LanguageServers>,
    live: tauri::State<'_, super::live::LiveLanguages>,
) -> AppResult<()> {
    sessions.stop_server(&server_id);
    live.stop_server(&server_id);
    installer.set_enabled(&storage, &server_id, enabled)
}
#[tauri::command]
pub async fn uninstall_language_server(
    server_id: String,
    storage: tauri::State<'_, Storage>,
    installer: tauri::State<'_, LanguageServerInstaller>,
    sessions: tauri::State<'_, super::LanguageServers>,
    live: tauri::State<'_, super::live::LiveLanguages>,
) -> AppResult<()> {
    sessions.stop_server(&server_id);
    live.stop_server(&server_id);
    let installer = installer.inner().clone();
    let storage = storage.inner().clone();
    tauri::async_runtime::spawn_blocking(move || installer.uninstall(&storage, &server_id))
        .await
        .map_err(|_| AppError::new("task", "Language server removal failed."))?
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn blocked_preview_requires_setup_before_installation_or_managed_launch() {
        let temp = tempfile::tempdir().unwrap();
        let storage = Storage::open(temp.path().join("local")).unwrap();
        let installer = LanguageServerInstaller::default();
        let entry = catalogue(&storage, &installer)
            .unwrap()
            .entries
            .into_iter()
            .find(|value| value.id == "kotlin")
            .unwrap();
        assert!(!entry.supported);
        assert_eq!(entry.status, "setup-required");
        assert!(entry.setup_required.is_some());
        assert_eq!(
            installer
                .start(storage.clone(), "kotlin".into(), None)
                .unwrap_err()
                .code,
            "language_server_setup_required"
        );
        assert_eq!(
            resolve(&storage, "Main.kt").unwrap_err().code,
            "language_server_setup_required"
        );
        assert!(installer.operations().is_empty());
    }
    #[test]
    fn artifacts_are_pinned_and_each_platform_has_its_private_dependencies() {
        let artifacts: Vec<Artifact> = serde_json::from_str(include_str!(
            "../../../resources/languages/native-artifacts.json"
        ))
        .unwrap();
        let mut ids = std::collections::BTreeSet::new();
        for artifact in &artifacts {
            assert!(
                ids.insert((&artifact.id, &artifact.platform)),
                "duplicate {}",
                artifact.id
            );
            assert!(valid_id(&artifact.id) && valid_id(&artifact.version));
            assert!(artifact.url.starts_with("https://"));
            assert!(
                artifact
                    .sha256
                    .as_ref()
                    .is_some_and(|value| value.len() == 64
                        && value.bytes().all(|byte| byte.is_ascii_hexdigit()))
                    || artifact
                        .sha512
                        .as_ref()
                        .is_some_and(|value| value.len() == 128
                            && value.bytes().all(|byte| byte.is_ascii_hexdigit()))
            );
            for dependency in &artifact.dependencies {
                assert!(artifacts.iter().any(|other| other.id==*dependency && other.platform==artifact.platform), "missing {dependency} on {}",artifact.platform);
            }
        }
    }
    #[test]
    fn catalogue_matches_special_names_and_rejects_unknown_ids() {
        let languages = super::super::packs::builtin_languages();
        assert!(matches_path(
            &spec("docker").unwrap(),
            "ops/Dockerfile.dev",
            &languages
        ));
        assert!(matches_path(&spec("ruby").unwrap(), "Gemfile", &languages));
        assert!(matches_path(
            &spec("typescript").unwrap(),
            "src/Widget.TSX",
            &languages
        ));
        assert!(spec("../../source").is_err());
        assert!(!valid_id("../state"));
    }
    #[test]
    fn local_receipt_is_atomic_and_outside_the_project() {
        let temp = tempfile::tempdir().unwrap();
        let storage = Storage::open(temp.path().join("local")).unwrap();
        let receipt = InstalledServer {
            version: "1".into(),
            enabled: true,
            executable: "/bin/false".into(),
            arguments: vec![],
            environment: BTreeMap::new(),
            directory: None,
        };
        save_installed(&storage, "typescript", &receipt).unwrap();
        assert!(installed(&storage, "typescript").unwrap().unwrap().enabled);
        assert!(installed(&storage, "missing").unwrap().is_none());
        assert!(!temp.path().join(".reviewbox").exists());
    }
}
