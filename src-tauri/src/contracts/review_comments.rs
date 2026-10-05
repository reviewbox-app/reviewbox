use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// Monaco coordinates: one-based lines and UTF-16 columns, exclusive end.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReviewCommentRange {
    pub start_line: u32,
    pub start_column: u32,
    pub end_line: u32,
    pub end_column: u32,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReviewCommentAnchor {
    pub snapshot_id: String,
    pub source_id: String,
    pub path: String,
    pub content_hash: String,
    pub range: ReviewCommentRange,
    pub excerpt: String,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum ReviewCommentStatus {
    Open,
    Addressed,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReviewComment {
    pub id: String,
    pub review_id: String,
    pub anchor: ReviewCommentAnchor,
    #[serde(default)]
    pub text: String,
    pub status: ReviewCommentStatus,
    #[serde(default)]
    pub resolution: String,
    #[serde(default)]
    pub tests: String,
    pub created_at: String,
    pub updated_at: String,
}
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ReviewCommentsDocument {
    pub revision: String,
    pub comments: Vec<ReviewComment>,
    pub shared_file_present: bool,
    pub correction_prompt: String,
}
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum ReviewCommentMutation {
    Add {
        id: String,
        anchor: ReviewCommentAnchor,
        text: String,
    },
    Edit {
        id: String,
        text: String,
        status: ReviewCommentStatus,
        resolution: String,
        tests: String,
    },
    Delete {
        id: String,
    },
}
