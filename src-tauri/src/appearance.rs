//! Personal code appearance. File icons are bundled data, never imported editor profiles.
use crate::{contracts::*, storage::Storage};

pub fn settings(storage: &Storage) -> AppResult<AppearancePreferences> {
    match storage.get("appearance", "preferences") {
        Ok(value) => Ok(value),
        Err(e) if e.code == "not_found" => Ok(AppearancePreferences::default()),
        Err(e) => Err(e),
    }
}

pub fn configure(
    storage: &Storage,
    mut value: AppearancePreferences,
) -> AppResult<AppearancePreferences> {
    if value.code_font_family.is_empty()
        || value.code_font_family.len() > 200
        || value.code_font_family.chars().any(char::is_control)
        || !(100..=900).contains(&value.code_font_weight)
        || !value.code_font_weight.is_multiple_of(100)
    {
        return Err(AppError::new(
            "appearance",
            "Choose a font family and a weight from 100 to 900.",
        ));
    }
    match storage.get::<AppearancePreferences>("appearance", "preferences") {
        Ok(_) => {
            let revision = value.revision;
            value.revision += 1;
            storage.replace("appearance", "preferences", revision, &value)?;
        }
        Err(e) if e.code == "not_found" => {
            value.revision = 0;
            storage.insert("appearance", "preferences", &value)?;
        }
        Err(e) => return Err(e),
    }
    Ok(value)
}

#[tauri::command]
pub async fn appearance_settings(
    storage: tauri::State<'_, Storage>,
) -> AppResult<AppearancePreferences> {
    settings(&storage)
}
#[tauri::command]
pub async fn configure_appearance(
    app: tauri::AppHandle,
    storage: tauri::State<'_, Storage>,
    preferences: AppearancePreferences,
) -> AppResult<AppearancePreferences> {
    let result = configure(&storage, preferences)?;
    use tauri::Emitter;
    let _ = app.emit("reviewbox:appearance-changed", &result);
    Ok(result)
}
#[tauri::command]
pub async fn system_code_fonts() -> AppResult<Vec<String>> {
    tauri::async_runtime::spawn_blocking(|| {
        let mut db = fontdb::Database::new();
        db.load_system_fonts();
        let mut families = std::collections::BTreeSet::from(["Geist Mono".to_owned()]);
        for face in db.faces().filter(|face| face.monospaced) {
            if let Some((name, _)) = face.families.first()
                && !name.starts_with('.')
                && !name.chars().any(char::is_control)
            {
                families.insert(name.clone());
            }
        }
        families.into_iter().collect()
    })
    .await
    .map_err(|_| AppError::new("fonts", "System fonts could not be listed."))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn legacy_icons_are_ignored_and_code_preferences_survive() {
        let old = serde_json::json!({"revision":3,"codeTheme":"reviewbox","fileIcons":{"activeIconPack":"nest"},"importedProfile":"private","importWarnings":["old"]});
        let value: AppearancePreferences = serde_json::from_value(old).unwrap();
        assert!(matches!(value.code_theme, CodeTheme::Reviewbox));
        assert_eq!(value.code_font_weight, 400);
        let saved = serde_json::to_value(value).unwrap();
        assert!(saved.get("fileIcons").is_none());
        assert_eq!(saved["revision"], 3);
    }
}
