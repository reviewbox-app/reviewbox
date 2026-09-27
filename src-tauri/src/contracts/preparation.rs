use serde::{Deserialize, Serialize};
use ts_rs::TS;

#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct AgentPreparationContext {
    pub snapshot_id: String,
    pub project_path: String,
    pub changed_files: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct ProposalDiagnostic {
    pub topic_index: u32,
    pub step_index: u32,
    pub anchor_index: Option<u32>,
    pub message: String,
}
