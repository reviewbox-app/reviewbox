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

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum EditorExtensionId {
    AutoRenameTag,
    AutoImport,
    NpmIntellisense,
    PathIntellisense,
    ColorHighlight,
    Prettier,
    Prisma,
    Shaders,
    Tailwind,
    Vue,
    BracketColorization,
}
impl EditorExtensionId {
    pub const ALL: [Self; 11] = [
        Self::AutoRenameTag,
        Self::AutoImport,
        Self::NpmIntellisense,
        Self::PathIntellisense,
        Self::ColorHighlight,
        Self::Prettier,
        Self::Prisma,
        Self::Shaders,
        Self::Tailwind,
        Self::Vue,
        Self::BracketColorization,
    ];
    pub fn server(self) -> Option<&'static str> {
        match self {
            Self::Prisma => Some("prisma"),
            Self::Vue => Some("vue"),
            Self::Tailwind => Some("tailwind"),
            Self::Shaders => Some("slang"),
            Self::Prettier => Some("prettier"),
            _ => None,
        }
    }
}
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct EditorExtensionPreferences {
    pub revision: u32,
    #[serde(default = "prettier_on_save_default")]
    pub prettier_on_save: bool,
    pub enabled: std::collections::BTreeMap<EditorExtensionId, bool>,
}
fn prettier_on_save_default() -> bool {
    true
}
impl Default for EditorExtensionPreferences {
    fn default() -> Self {
        Self {
            revision: 0,
            prettier_on_save: true,
            enabled: EditorExtensionId::ALL
                .into_iter()
                .map(|id| (id, true))
                .collect(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct EditorPathSuggestion {
    pub label: String,
    pub directory: bool,
    pub package: bool,
}
