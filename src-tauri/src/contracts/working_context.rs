use serde::{Deserialize, Serialize};
use ts_rs::TS;

#[derive(
    Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema, TS,
)]
#[serde(rename_all = "camelCase")]
pub enum WorkingContextStatus {
    #[default]
    Unverified,
    Accepted,
    Stale,
}

#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkingContextAssessment {
    pub path: String,
    pub status: WorkingContextStatus,
    pub reason: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct WorkingContextFile {
    pub path: String,
    pub hash: String,
    pub status: WorkingContextStatus,
    pub reason: String,
    pub cleanup: String,
    #[serde(default)]
    pub recovery_path: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ReviewWorkingContext {
    pub snapshot_id: String,
    pub files: Vec<WorkingContextFile>,
}
