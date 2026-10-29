use serde::{Deserialize, Serialize};
use ts_rs::TS;

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LanguageDefinition {
    pub id: String,
    pub name: String,
    pub lsp_id: String,
    pub extensions: Vec<String>,
    #[serde(default)]
    pub filenames: Vec<String>,
    #[serde(default)]
    pub aliases: Vec<String>,
    #[serde(default)]
    pub interpreters: Vec<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LanguagePackArtifact {
    pub platform: String,
    pub url: String,
    pub sha256: String,
    pub format: String,
    pub executable: String,
    #[serde(default)]
    pub strip_components: usize,
}
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum LanguagePackInstallation {
    Executable {
        executable: String,
    },
    Archive {
        artifacts: Vec<LanguagePackArtifact>,
    },
    Npm {
        package: String,
        bin: String,
    },
}
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LanguagePackServer {
    pub installation: LanguagePackInstallation,
    #[serde(default)]
    pub arguments: Vec<String>,
    #[serde(default)]
    #[ts(type = "Record<string, unknown>")]
    pub settings: serde_json::Value,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional, type = "Record<string, unknown>")]
    pub initialization_options: Option<serde_json::Value>,
}
#[derive(Debug, Clone, Copy, Serialize, Deserialize, TS, Default)]
#[serde(rename_all = "camelCase")]
pub enum LanguageRootStrategy {
    #[default]
    Nearest,
    Workspace,
}
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LanguagePack {
    pub id: String,
    pub name: String,
    pub version: String,
    pub source_url: String,
    pub languages: Vec<LanguageDefinition>,
    #[serde(default)]
    pub root_markers: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub root_strategy: Option<LanguageRootStrategy>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub watched_files: Option<Vec<String>>,
    pub server: Option<LanguagePackServer>,
    #[serde(default)]
    #[ts(type = "Record<string, unknown>[]")]
    pub grammars: Vec<serde_json::Value>,
    #[serde(default = "enabled")]
    pub enabled: bool,
}
fn enabled() -> bool {
    true
}
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct LanguageRegistry {
    pub languages: Vec<LanguageDefinition>,
    pub packs: Vec<LanguagePack>,
}
