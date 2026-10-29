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

#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct PreparationRequest {
    pub review_id: String,
    pub provider: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema, TS, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum PreparationStatus {
    Running,
    Ready,
    Failed,
    Cancelled,
    Interrupted,
}

#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema, TS, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum PreparationPhase {
    Context,
    Outline,
    #[serde(alias = "pseudocode")]
    Documents,
    Files,
    Checking,
}

#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct PreparationState {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub adaptation: Option<ReviewAdaptation>,
    #[serde(default)]
    pub active_batches: Vec<PreparationBatch>,
    #[serde(default)]
    pub phases: Vec<PreparationPhaseCount>,
    pub id: String,
    pub review_id: String,
    pub snapshot_id: String,
    pub provider: String,
    pub status: PreparationStatus,
    pub phase: PreparationPhase,
    pub completed_batches: u32,
    pub total_batches: u32,
    #[serde(default)]
    pub steps: Vec<PreparationStep>,
    pub events: Vec<super::AgentEvent>,
    pub error: Option<super::AppError>,
    pub started_at: String,
    pub updated_at: String,
    pub can_resume: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct ReviewAdaptation {
    pub operation_id: String,
    pub provider: String,
    pub source_review_id: String,
    pub source_revision: u32,
    pub snapshot_id: String,
    pub candidate_review_id: String,
    pub destination_review_id: String,
    #[serde(default)]
    pub retained_steps: u32,
    #[serde(default)]
    pub rewritten_steps: u32,
    #[serde(default)]
    pub added_steps: u32,
    #[serde(default)]
    pub removed_steps: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct PreparationBatch {
    pub id: String,
    pub label: String,
    pub phase: PreparationPhase,
    pub model: Option<String>,
    pub started_at: String,
    #[serde(default)]
    pub status: PreparationBatchStatus,
}
#[derive(Debug, Clone, Default, Serialize, Deserialize, schemars::JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub enum PreparationBatchStatus {
    #[default]
    Running,
    WaitingForProvider,
}
#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct PreparationPhaseCount {
    pub phase: PreparationPhase,
    pub total: u32,
    pub completed: u32,
}

/// Preparation progress, separate from human review decisions.
#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct PreparationStep {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub decision: Option<String>,
    pub id: String,
    pub title: String,
    pub status: PreparationStepStatus,
}
#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema, TS, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum PreparationStepStatus {
    Removed,
    Queued,
    Writing,
    Checking,
    Ready,
    Failed,
    Interrupted,
}
