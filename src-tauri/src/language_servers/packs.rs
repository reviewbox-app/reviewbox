use super::catalog::{self, Artifact, ServerSpec};
use crate::{contracts::*, storage::Storage};
use std::{collections::BTreeMap, fs, io::Write};
use tauri::{Emitter, State};

pub(crate) fn builtin_languages() -> Vec<LanguageDefinition> {
    serde_json::from_str(include_str!("../../../resources/languages/languages.json"))
        .expect("bundled language definitions")
}
fn matches_name(pattern: &str, name: &str) -> bool {
    let pattern = pattern.to_lowercase();
    let name = name.to_lowercase();
    let parts = pattern.split('*').collect::<Vec<_>>();
    if parts.len() == 1 {
        return name == pattern;
    }
    let Some(mut rest) = name.strip_prefix(parts[0]) else {
        return false;
    };
    for part in &parts[1..parts.len() - 1] {
        let Some(index) = rest.find(part) else {
            return false;
        };
        rest = &rest[index + part.len()..];
    }
    rest.ends_with(parts[parts.len() - 1])
}
pub(crate) fn detect_language<'a>(
    languages: &'a [LanguageDefinition],
    path: &str,
    first_line: Option<&str>,
) -> Option<&'a LanguageDefinition> {
    let name = path.rsplit(['/', '\\']).next().unwrap_or(path);
    languages
        .iter()
        .find(|language| language.filenames.iter().any(|p| matches_name(p, name)))
        .or_else(|| {
            name.rsplit_once('.').and_then(|(_, extension)| {
                languages.iter().find(|language| {
                    language
                        .extensions
                        .iter()
                        .any(|e| e.eq_ignore_ascii_case(extension))
                })
            })
        })
        .or_else(|| {
            let line = first_line?.strip_prefix("#!")?;
            languages.iter().find(|language| {
                language.interpreters.iter().any(|pattern| {
                    line.split_whitespace()
                        .any(|word| matches_name(pattern, word.rsplit('/').next().unwrap_or(word)))
                })
            })
        })
}
pub(crate) fn all(storage: &Storage) -> AppResult<Vec<LanguagePack>> {
    let root = catalog::root(storage).join("packs");
    if !root.exists() {
        return Ok(vec![]);
    }
    let mut packs = Vec::new();
    for item in fs::read_dir(root)? {
        let entry = item?;
        if entry.path().extension().is_none_or(|e| e != "json") {
            continue;
        }
        let pack: LanguagePack = serde_json::from_slice(&fs::read(entry.path())?)?;
        validate(&pack)?;
        packs.push(pack);
    }
    packs.sort_by(|a, b| a.id.cmp(&b.id));
    Ok(packs)
}
pub(crate) fn validate(pack: &LanguagePack) -> AppResult<()> {
    let invalid = |message| AppError::new("invalid_language_pack", message);
    if !catalog::valid_id(&pack.id)
        || !catalog::valid_id(&pack.version)
        || pack.languages.is_empty()
        || pack.languages.len() > 100
    {
        return Err(invalid(
            "The pack needs a valid ID, version and language definitions.",
        ));
    }
    if catalog::specs()?.iter().any(|s| s.id == pack.id) {
        return Err(invalid("Custom packs cannot replace a bundled server ID."));
    }
    if !pack.source_url.starts_with("https://") {
        return Err(invalid("Provide an HTTPS source URL."));
    }
    for language in &pack.languages {
        if !catalog::valid_id(&language.id)
            || !catalog::valid_id(&language.lsp_id)
            || language
                .extensions
                .iter()
                .chain(&language.filenames)
                .chain(&language.interpreters)
                .any(|e| e.is_empty() || e.contains(['/', '\\', '\0']) || e.len() > 256)
        {
            return Err(invalid("Invalid language identifier or extension."));
        }
    }
    for marker in &pack.root_markers {
        if marker.is_empty() || marker.contains(['/', '\\']) || marker == ".." {
            return Err(invalid("Root markers must be file names."));
        }
    }
    for grammar in &pack.grammars {
        if !grammar.is_object()
            || grammar["scopeName"].as_str().is_none()
            || grammar["name"].as_str().is_none()
            || !grammar["patterns"].is_array()
        {
            return Err(invalid(
                "Provide TextMate grammar objects with name, scopeName and patterns.",
            ));
        }
    }
    if let Some(server) = &pack.server {
        match &server.installation {
            LanguagePackInstallation::Archive { artifacts } => {
                for artifact in artifacts {
                    if !artifact.url.starts_with("https://")
                        || artifact.sha256.len() != 64
                        || !artifact.sha256.bytes().all(|b| b.is_ascii_hexdigit())
                    {
                        return Err(invalid(
                            "Archives require an HTTPS URL and SHA-256 checksum.",
                        ));
                    }
                    crate::snapshots::safe_path(&artifact.executable)?;
                    if !matches!(artifact.format.as_str(), "zip" | "tar.gz" | "file" | "gz") {
                        return Err(invalid(
                            "Supported archives are zip, tar.gz, gz and file (uncompressed executable).",
                        ));
                    }
                }
            }
            LanguagePackInstallation::Npm { package, bin } => {
                if package.is_empty()
                    || package.starts_with('-')
                    || package.contains([':', '\\', ' '])
                    || package.contains("..")
                    || !catalog::valid_id(bin)
                {
                    return Err(invalid("Provide an npm package name and executable name."));
                }
                semver::Version::parse(&pack.version)
                    .map_err(|_| invalid("Npm packs require an exact semantic version."))?;
            }
            LanguagePackInstallation::Executable { executable } => {
                if executable.trim().is_empty() {
                    return Err(invalid("Provide a server executable."));
                }
            }
        }
    }
    if serde_json::to_vec(pack)?.len() > 4 * 1024 * 1024 {
        return Err(invalid("Pack manifests must be smaller than 4 MiB."));
    }
    Ok(())
}
pub(crate) fn save(storage: &Storage, pack: &LanguagePack) -> AppResult<()> {
    validate(pack)?;
    let root = catalog::root(storage).join("packs");
    fs::create_dir_all(&root)?;
    let mut file = tempfile::NamedTempFile::new_in(&root)?;
    file.write_all(&serde_json::to_vec_pretty(pack)?)?;
    file.as_file().sync_all()?;
    file.persist(root.join(format!("{}.json", pack.id)))
        .map_err(|e| AppError::new("pack_save", e.to_string()))?;
    Ok(())
}
pub(crate) fn specs(storage: &Storage) -> AppResult<Vec<ServerSpec>> {
    let mut result = catalog::specs()?;
    for pack in all(storage)? {
        if let Some(spec) = pack_spec(&pack) {
            result.push(spec);
        }
    }
    Ok(result)
}
pub(crate) fn pack_spec(pack: &LanguagePack) -> Option<ServerSpec> {
    let server = pack.server.as_ref()?;
    let (method, package, bin) = match &server.installation {
        LanguagePackInstallation::Npm { package, bin } => ("npm", package.clone(), bin.clone()),
        LanguagePackInstallation::Executable { executable } => {
            ("external", executable.clone(), String::new())
        }
        LanguagePackInstallation::Archive { .. } => ("native", String::new(), String::new()),
    };
    Some(ServerSpec {
        id: pack.id.clone(),
        name: pack.name.clone(),
        description: "User language pack".into(),
        languages: pack.languages.iter().map(|l| l.lsp_id.clone()).collect(),
        extensions: pack
            .languages
            .iter()
            .flat_map(|l| l.extensions.clone())
            .collect(),
        version: pack.version.clone(),
        method: method.into(),
        source_url: pack.source_url.clone(),
        runtime: None,
        prerequisites: vec![],
        setup_required: (!pack.enabled).then(|| "This language pack is disabled.".into()),
        packages: if method == "npm" {
            BTreeMap::from([(package.clone(), pack.version.clone())])
        } else {
            BTreeMap::new()
        },
        package,
        bin,
        arguments: server.arguments.clone(),
        overrides: BTreeMap::new(),
    })
}
pub(crate) fn spec(storage: &Storage, id: &str) -> AppResult<ServerSpec> {
    if let Ok(bundled) = catalog::spec(id) {
        return Ok(bundled);
    }
    specs(storage)?
        .into_iter()
        .find(|s| s.id == id)
        .ok_or_else(|| {
            AppError::new(
                "unknown_language_server",
                "Import a language pack before installing it.",
            )
        })
}
pub(crate) fn artifact(storage: &Storage, id: &str) -> AppResult<Artifact> {
    if let Ok(artifact) = catalog::artifact(id) {
        return Ok(artifact);
    }
    for pack in all(storage)? {
        if pack.id != id {
            continue;
        }
        if let Some(artifact) = pack_artifact(&pack) {
            return Ok(artifact);
        }
    }
    Err(AppError::new(
        "unsupported_platform",
        "The pack has no archive for this platform.",
    ))
}
pub(crate) fn pack_artifact(pack: &LanguagePack) -> Option<Artifact> {
    let server = pack.server.as_ref()?;
    let LanguagePackInstallation::Archive { artifacts } = &server.installation else {
        return None;
    };
    let artifact = artifacts
        .iter()
        .find(|a| a.platform == catalog::platform())?;
    Some(Artifact {
        id: pack.id.clone(),
        version: pack.version.clone(),
        platform: artifact.platform.clone(),
        url: artifact.url.clone(),
        sha256: Some(artifact.sha256.clone()),
        sha512: None,
        format: artifact.format.clone(),
        executable: artifact.executable.clone(),
        arguments: server.arguments.clone(),
        strip_components: artifact.strip_components,
        dependencies: vec![],
        recipe: None,
    })
}
#[tauri::command]
pub fn language_registry(storage: State<'_, Storage>) -> AppResult<LanguageRegistry> {
    registry(&storage)
}
pub(crate) fn registry(storage: &Storage) -> AppResult<LanguageRegistry> {
    let packs = all(storage)?;
    let mut languages = builtin_languages();
    for pack in packs.iter().filter(|p| p.enabled) {
        for language in &pack.languages {
            languages.retain(|l| l.id != language.id);
            languages.push(language.clone());
        }
    }
    Ok(LanguageRegistry { languages, packs })
}
#[tauri::command]
pub fn save_language_pack(
    app: tauri::AppHandle,
    storage: State<'_, Storage>,
    live: State<'_, super::live::LiveLanguages>,
    pack: LanguagePack,
) -> AppResult<LanguageRegistry> {
    save(&storage, &pack)?;
    live.stop_all();
    let _ = app.emit("reviewbox:language-packs-changed", ());
    registry(&storage)
}
#[tauri::command]
pub fn remove_language_pack(
    app: tauri::AppHandle,
    storage: State<'_, Storage>,
    live: State<'_, super::live::LiveLanguages>,
    pack_id: String,
    installer: State<'_, super::install::LanguageServerInstaller>,
) -> AppResult<LanguageRegistry> {
    if !catalog::valid_id(&pack_id) {
        return Err(AppError::new("invalid_pack", "Invalid pack ID."));
    }
    live.stop_all();
    if catalog::installed(&storage, &pack_id)?.is_some() {
        installer.uninstall(&storage, &pack_id)?;
    }
    fs::remove_file(
        catalog::root(&storage)
            .join("packs")
            .join(format!("{pack_id}.json")),
    )?;
    live.stop_all();
    let _ = app.emit("reviewbox:language-packs-changed", ());
    registry(&storage)
}

#[tauri::command]
pub async fn export_language_pack(storage: State<'_, Storage>, pack_id: String) -> AppResult<()> {
    let pack = all(&storage)?
        .into_iter()
        .find(|p| p.id == pack_id)
        .ok_or_else(|| AppError::new("not_found", "Language pack not found."))?;
    let bytes = serde_json::to_vec_pretty(&pack)?;
    if let Some(file) = rfd::AsyncFileDialog::new()
        .set_file_name(format!("{}.json", pack.id))
        .add_filter("Language pack", &["json"])
        .save_file()
        .await
    {
        file.write(&bytes).await?;
    }
    Ok(())
}

#[cfg(test)]
#[path = "packs_tests.rs"]
mod tests;
