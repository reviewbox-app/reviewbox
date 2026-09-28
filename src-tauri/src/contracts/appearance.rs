use super::*;
use std::collections::BTreeMap;

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "kebab-case")]
pub enum CodeTheme {
    TokyoNight,
    Reviewbox,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS, Default)]
#[serde(rename_all = "camelCase")]
pub struct IconClone {
    pub name: String,
    pub base: String,
    pub color: Option<String>,
    pub light_color: Option<String>,
    #[serde(default)]
    pub file_names: Vec<String>,
    #[serde(default)]
    pub file_extensions: Vec<String>,
    #[serde(default)]
    pub folder_names: Vec<String>,
    #[serde(default)]
    pub root_folder_names: Vec<String>,
    #[serde(default)]
    pub active_for_packs: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct FileIconPreferences {
    pub active_icon_pack: String,
    pub file_associations: BTreeMap<String, String>,
    pub folder_associations: BTreeMap<String, String>,
    pub file_clones: Vec<IconClone>,
    pub folder_clones: Vec<IconClone>,
}
impl Default for FileIconPreferences {
    fn default() -> Self {
        Self {
            active_icon_pack: "default".into(),
            file_associations: BTreeMap::new(),
            folder_associations: BTreeMap::new(),
            file_clones: vec![],
            folder_clones: vec![],
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct AppearancePreferences {
    pub revision: u32,
    pub code_theme: CodeTheme,
    pub file_icons: FileIconPreferences,
    pub imported_profile: Option<String>,
    pub import_warnings: Vec<String>,
}
impl Default for AppearancePreferences {
    fn default() -> Self {
        Self {
            revision: 0,
            code_theme: CodeTheme::TokyoNight,
            file_icons: FileIconPreferences::default(),
            imported_profile: None,
            import_warnings: vec![],
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct EditorProfile {
    pub id: String,
    pub name: String,
}
