//! Import appearance data only. VS Code commands, extensions and other settings never execute.
use crate::{contracts::*, storage::Storage};
use serde_json::Value;
use std::{collections::BTreeMap, path::PathBuf};

fn code_user_dir() -> Option<PathBuf> {
    #[cfg(target_os = "macos")]
    {
        std::env::var_os("HOME")
            .map(|p| PathBuf::from(p).join("Library/Application Support/Code/User"))
    }
    #[cfg(target_os = "windows")]
    {
        std::env::var_os("APPDATA").map(|p| PathBuf::from(p).join("Code/User"))
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        std::env::var_os("XDG_CONFIG_HOME")
            .map(PathBuf::from)
            .or_else(|| std::env::var_os("HOME").map(|p| PathBuf::from(p).join(".config")))
            .map(|p| p.join("Code/User"))
    }
}

fn jsonc(path: &std::path::Path) -> AppResult<Value> {
    if std::fs::metadata(path)?.len() > 2 * 1024 * 1024 {
        return Err(AppError::new(
            "settings_size",
            "The editor settings file is too large.",
        ));
    }
    json5::from_str(&std::fs::read_to_string(path)?).map_err(|_| {
        AppError::new(
            "editor_settings",
            "The VS Code appearance settings could not be read.",
        )
    })
}

pub fn profiles() -> AppResult<Vec<EditorProfile>> {
    let Some(root) = code_user_dir().filter(|p| p.is_dir()) else {
        return Ok(vec![]);
    };
    let mut result = vec![EditorProfile {
        id: "default".into(),
        name: "Default".into(),
    }];
    let metadata = jsonc(&root.join("globalStorage/storage.json")).unwrap_or(Value::Null);
    if let Ok(entries) = std::fs::read_dir(root.join("profiles")) {
        for entry in entries
            .flatten()
            .filter(|p| p.path().join("settings.json").is_file())
        {
            let id = entry.file_name().to_string_lossy().into_owned();
            let name = metadata["userDataProfiles"]
                .as_array()
                .and_then(|rows| {
                    rows.iter().find(|v| {
                        v["location"].as_str() == Some(&id) || v["id"].as_str() == Some(&id)
                    })
                })
                .and_then(|p| p["name"].as_str())
                .unwrap_or(&id)
                .to_string();
            result.push(EditorProfile { id, name });
        }
    }
    result.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(result)
}

fn associations(value: &Value) -> BTreeMap<String, String> {
    value
        .as_object()
        .map(|rows| {
            rows.iter()
                .filter_map(|(k, v)| v.as_str().map(|s| (k.clone(), s.into())))
                .collect()
        })
        .unwrap_or_default()
}

pub(crate) fn parse_icons(value: &Value) -> AppResult<(FileIconPreferences, Vec<String>)> {
    let mut warnings = vec![];
    let requested_pack = value["material-icon-theme.activeIconPack"]
        .as_str()
        .unwrap_or("default");
    let pack = if ["default", "nest"].contains(&requested_pack) {
        requested_pack
    } else {
        warnings.push(format!(
            "Icon pack {requested_pack} is not bundled. Using the default pack."
        ));
        "default"
    };
    let clones = |key: &str| -> AppResult<Vec<IconClone>> {
        value
            .get(key)
            .map(|v| {
                serde_json::from_value(v.clone())
                    .map_err(|_| AppError::new("icon_settings", format!("Invalid {key} settings.")))
            })
            .unwrap_or(Ok(vec![]))
    };
    let icons = FileIconPreferences {
        active_icon_pack: pack.into(),
        file_associations: associations(&value["material-icon-theme.files.associations"]),
        folder_associations: associations(&value["material-icon-theme.folders.associations"]),
        file_clones: clones("material-icon-theme.files.customClones")?,
        folder_clones: clones("material-icon-theme.folders.customClones")?,
    };
    for clone in &icons.folder_clones {
        for pattern in clone.folder_names.iter().chain(&clone.root_folder_names) {
            if pattern.contains(['*', '?']) {
                warnings.push(format!(
                    "Folder icon pattern \"{pattern}\" is unsupported; folder names must be exact."
                ));
            }
        }
    }
    validate_icons(&icons)?;
    Ok((icons, warnings))
}

fn validate_icons(icons: &FileIconPreferences) -> AppResult<()> {
    let safe_id = |s: &str| {
        !s.is_empty()
            && s.len() <= 120
            && s.bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
    };
    if !["default", "nest"].contains(&icons.active_icon_pack.as_str())
        || icons.file_clones.len() + icons.folder_clones.len() > 1000
    {
        return Err(AppError::new("icon_settings", "Invalid icon preferences."));
    }
    for item in icons.file_clones.iter().chain(&icons.folder_clones) {
        if !safe_id(&item.name) || !safe_id(&item.base) {
            return Err(AppError::new(
                "icon_settings",
                "An icon clone has an invalid name or base.",
            ));
        }
    }
    Ok(())
}

fn imported(profile: &EditorProfile) -> AppResult<(FileIconPreferences, Vec<String>)> {
    if profile.id != "default"
        && (!profile
            .id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-')
            || profile.id.is_empty())
    {
        return Err(AppError::new("editor_profile", "Invalid editor profile."));
    }
    let root = code_user_dir()
        .ok_or_else(|| AppError::new("editor_profile", "VS Code settings were not found."))?;
    let path = if profile.id == "default" {
        root.join("settings.json")
    } else {
        root.join("profiles")
            .join(&profile.id)
            .join("settings.json")
    };
    parse_icons(&jsonc(&path)?)
}

pub fn settings(storage: &Storage) -> AppResult<AppearancePreferences> {
    match storage.get("appearance", "preferences") {
        Ok(value) => Ok(value),
        Err(e) if e.code == "not_found" => {
            let mut value = AppearancePreferences::default();
            // On this explicitly requested first import, prefer the only named profile.
            let profiles = profiles().unwrap_or_default();
            let named: Vec<_> = profiles.iter().filter(|p| p.id != "default").collect();
            let candidate = if named.len() == 1 {
                named.first().copied()
            } else {
                profiles.iter().find(|p| p.id == "default")
            };
            if let Some(profile) = candidate
                && let Ok((icons, warnings)) = imported(profile)
            {
                value.file_icons = icons;
                value.imported_profile = Some(profile.name.clone());
                value.import_warnings = warnings;
            }
            match storage.insert("appearance", "preferences", &value) {
                Ok(()) => Ok(value),
                Err(error) => storage.get("appearance", "preferences").map_err(|_| error),
            }
        }
        Err(e) => Err(e),
    }
}

pub fn configure(
    storage: &Storage,
    mut value: AppearancePreferences,
) -> AppResult<AppearancePreferences> {
    validate_icons(&value.file_icons)?;
    let revision = value.revision;
    value.revision += 1;
    storage.replace("appearance", "preferences", revision, &value)?;
    Ok(value)
}

pub fn import_icons(storage: &Storage, profile_id: &str) -> AppResult<AppearancePreferences> {
    let profile = profiles()?
        .into_iter()
        .find(|p| p.id == profile_id)
        .ok_or_else(|| {
            AppError::new(
                "editor_profile",
                "This editor profile is no longer available.",
            )
        })?;
    let (icons, warnings) = imported(&profile)?;
    let mut value = settings(storage)?;
    value.file_icons = icons;
    value.imported_profile = Some(profile.name);
    value.import_warnings = warnings;
    configure(storage, value)
}

#[tauri::command]
pub async fn appearance_settings(
    storage: tauri::State<'_, Storage>,
) -> AppResult<AppearancePreferences> {
    let storage = storage.inner().clone();
    tauri::async_runtime::spawn_blocking(move || settings(&storage))
        .await
        .map_err(|_| AppError::new("task", "Appearance settings could not load."))?
}
#[tauri::command]
pub async fn configure_appearance(
    app: tauri::AppHandle,
    storage: tauri::State<'_, Storage>,
    preferences: AppearancePreferences,
) -> AppResult<AppearancePreferences> {
    let storage = storage.inner().clone();
    let result = tauri::async_runtime::spawn_blocking(move || configure(&storage, preferences))
        .await
        .map_err(|_| AppError::new("task", "Appearance settings could not save."))??;
    use tauri::Emitter;
    let _ = app.emit("reviewbox:appearance-changed", &result);
    Ok(result)
}
#[tauri::command]
pub async fn editor_profiles() -> AppResult<Vec<EditorProfile>> {
    tauri::async_runtime::spawn_blocking(profiles)
        .await
        .map_err(|_| AppError::new("task", "Editor profiles could not load."))?
}
#[tauri::command]
pub async fn import_editor_icons(
    app: tauri::AppHandle,
    storage: tauri::State<'_, Storage>,
    profile_id: String,
) -> AppResult<AppearancePreferences> {
    let storage = storage.inner().clone();
    let result = tauri::async_runtime::spawn_blocking(move || import_icons(&storage, &profile_id))
        .await
        .map_err(|_| AppError::new("task", "Editor icons could not be imported."))??;
    use tauri::Emitter;
    let _ = app.emit("reviewbox:appearance-changed", &result);
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn imports_only_icon_data_from_jsonc() {
        let value: Value = json5::from_str(r##"{ // profile
            "material-icon-theme.activeIconPack":"nest",
            "material-icon-theme.files.customClones":[{"name":"helper", "base":"settings", "color":"#aabbcc", "fileExtensions":["helpers.ts"]}],
            "terminal.integrated.env.osx":{"SECRET":"ignored"},
        }"##).unwrap();
        let (icons, warnings) = parse_icons(&value).unwrap();
        assert_eq!(icons.active_icon_pack, "nest");
        assert!(warnings.is_empty());
        assert_eq!(icons.file_clones[0].file_extensions, ["helpers.ts"]);
        assert!(!serde_json::to_string(&icons).unwrap().contains("SECRET"));
    }
    #[test]
    fn rejects_external_icon_paths_and_reports_folder_patterns() {
        assert!(parse_icons(&serde_json::json!({"material-icon-theme.files.customClones":[{"name":"x","base":"../secret"}]})).is_err());
        let (_, warnings) = parse_icons(&serde_json::json!({"material-icon-theme.folders.customClones":[{"name":"x","base":"folder","folderNames":["*.helpers"]}]})).unwrap();
        assert_eq!(warnings.len(), 1);
    }
}
