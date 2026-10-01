use super::*;

#[derive(
    Debug, Clone, Default, Serialize, Deserialize, schemars::JsonSchema, TS, PartialEq, Eq,
)]
#[serde(rename_all = "camelCase")]
pub enum PublicationStatus {
    #[default]
    Draft,
    CompletedLocal,
    PublicationPending,
    Published,
    Archived,
}

#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema, TS, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ReviewCompletionKind {
    Guided,
    Manual,
}

#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema, TS, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ReviewCompletion {
    pub kind: ReviewCompletionKind,
    pub author: String,
    pub completed_at: String,
    pub scope_fingerprint: String,
    pub scope: Scope,
    pub include_untracked: bool,
    pub base_commit_id: Option<String>,
    pub target_commit_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema, TS, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ReviewArchive {
    pub commit_id: String,
    pub bundle_path: String,
    pub bundle_hash: String,
}

#[derive(
    Debug, Clone, Default, Serialize, Deserialize, schemars::JsonSchema, TS, PartialEq, Eq,
)]
#[serde(rename_all = "camelCase")]
pub struct ReviewPublication {
    pub status: PublicationStatus,
    pub keep_local: bool,
    pub completion: Option<ReviewCompletion>,
    pub origin_review_id: Option<String>,
    pub archive: Option<ReviewArchive>,
    pub matching_commit_ids: Vec<String>,
    pub publication_error: Option<String>,
    pub archive_deferred_reason: Option<String>,
    pub file_count: Option<u32>,
    pub step_count: Option<u32>,
}

impl ReviewPublication {
    pub(crate) fn is_complete(&self) -> bool {
        self.status != PublicationStatus::Draft
    }

    pub(crate) fn is_shared(&self) -> bool {
        matches!(
            self.status,
            PublicationStatus::Published | PublicationStatus::Archived
        )
    }
}
