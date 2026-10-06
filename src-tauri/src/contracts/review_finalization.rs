use super::*;

#[derive(Debug, Clone, Serialize, Deserialize, TS, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum FinalizationStatus {
    Running,
    Completed,
    Failed,
    Interrupted,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum FinalizationStepStatus {
    Queued,
    Running,
    Completed,
    Skipped,
    Failed,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ReviewFinalizationStep {
    pub id: String,
    pub title: String,
    pub status: FinalizationStepStatus,
    pub started_at: Option<String>,
    pub finished_at: Option<String>,
    pub error: Option<AppError>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ReviewFinalization {
    pub id: String,
    pub repository_id: String,
    pub review_id: String,
    pub sequence: u32,
    pub action: ReviewAction,
    pub status: FinalizationStatus,
    pub steps: Vec<ReviewFinalizationStep>,
    pub error: Option<AppError>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ReviewCommitOperation {
    pub review_id: String,
    pub sequence: u32,
    pub phase: String,
    pub operation: GitOperation,
}
