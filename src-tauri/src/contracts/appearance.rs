use super::*;

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "kebab-case")]
pub enum CodeTheme {
    TokyoNight,
    Reviewbox,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", default)]
pub struct AppearancePreferences {
    pub revision: u32,
    pub code_theme: CodeTheme,
    pub code_font_family: String,
    pub code_font_weight: u16,
}
impl Default for AppearancePreferences {
    fn default() -> Self {
        Self {
            revision: 0,
            code_theme: CodeTheme::TokyoNight,
            code_font_family: "Geist Mono".into(),
            code_font_weight: 400,
        }
    }
}
