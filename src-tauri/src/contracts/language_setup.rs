use serde::{Deserialize, Serialize};
use ts_rs::TS;

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LanguageSetupRequest {
    pub repository_id: String,
    pub path: String,
    pub operation_id: String,
    pub diagnostic: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LanguageSetupFile {
    pub path: String,
    pub before: Option<String>,
    pub after: String,
    pub expected_revision: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LanguageSetupCommand {
    pub executable: String,
    pub arguments: Vec<String>,
    pub directory: String,
    pub purpose: String,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LanguageSetupServer {
    pub name: String,
    pub version: String,
    pub source_url: String,
    #[ts(type = "Record<string, unknown>")]
    pub recipe: serde_json::Value,
}
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LanguageSetupPlan {
    pub id: String,
    pub repository_id: String,
    pub path: String,
    pub summary: String,
    pub prerequisites: Vec<String>,
    pub pack: Option<super::LanguagePack>,
    pub server_id: Option<String>,
    /// Filled by Rust, then checked again before applying the approved recipe.
    #[serde(default)]
    pub server: Option<LanguageSetupServer>,
    pub files: Vec<LanguageSetupFile>,
    pub commands: Vec<LanguageSetupCommand>,
}
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct LanguageSetupStatus {
    pub id: String,
    pub phase: String,
    pub message: String,
    pub completed_steps: Vec<String>,
    pub plan: Option<LanguageSetupPlan>,
    #[serde(default)]
    pub revisions: std::collections::BTreeMap<String, String>,
    #[serde(default)]
    pub in_flight_command: Option<usize>,
    #[serde(default)]
    pub log: String,
}
