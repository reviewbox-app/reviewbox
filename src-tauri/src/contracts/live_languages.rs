use serde::{Deserialize, Serialize};
use ts_rs::TS;

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LiveLanguageDocument {
    pub path: String,
    pub version: i32,
    pub text: String,
    pub language_id: String,
    /// Monaco changes are applied in order to this version. Missing/mismatched
    /// bases use a complete replacement to recover a lost IPC change.
    #[serde(default)]
    pub base_version: Option<i32>,
    #[serde(default)]
    pub changes: Vec<LiveLanguageChange>,
}
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LiveLanguageChange {
    pub start_line: u32,
    pub start_character: u32,
    pub end_line: u32,
    pub end_character: u32,
    pub text: String,
}
#[derive(Debug, Clone, Serialize, Deserialize, TS, Default)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LiveLanguageProjectSettings {
    #[serde(default)]
    pub revision: u32,
    pub root: Option<String>,
    #[serde(default)]
    pub environment: std::collections::BTreeMap<String, String>,
    #[serde(default)]
    #[ts(type = "Record<string, unknown>")]
    pub settings: serde_json::Value,
    #[ts(type = "Record<string, unknown> | null")]
    pub initialization_options: Option<serde_json::Value>,
}
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct LiveLanguageProjectContext {
    pub root_uri: String,
    pub configuration_files: Vec<String>,
    pub environment: std::collections::BTreeMap<String, String>,
    pub missing: Vec<String>,
    pub signature: String,
}
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct LiveLanguageSession {
    pub id: String,
    pub server_id: String,
    pub root_uri: String,
    #[ts(type = "Record<string, unknown>")]
    pub capabilities: serde_json::Value,
    pub context: LiveLanguageProjectContext,
}
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct LiveLanguageEvent {
    pub session_id: String,
    pub method: String,
    #[ts(type = "unknown")]
    pub params: serde_json::Value,
}
