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
pub struct CodeCommentAnchor {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub local: Option<LocalCommentSource>,
    pub snapshot_id: String,
    pub source_id: String,
    pub path: String,
    pub content_hash: String,
    pub range: ReviewCommentRange,
    pub excerpt: String,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(untagged)]
pub enum ReviewCommentAnchor {
    Document(DocumentCommentAnchor),
    Code(CodeCommentAnchor),
}
impl ReviewCommentAnchor {
    pub fn excerpt(&self) -> &str {
        match self {
            Self::Document(a) => &a.excerpt,
            Self::Code(a) => &a.excerpt,
        }
    }
}
impl From<CodeCommentAnchor> for ReviewCommentAnchor {
    fn from(value: CodeCommentAnchor) -> Self {
        Self::Code(value)
    }
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DocumentCommentAnchor {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub title: Option<String>,
    pub document: DocumentSelection,
    pub excerpt: String,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DocumentSelection {
    pub snapshot_id: String,
    pub step_id: String,
    pub level: super::ReadingLevel,
    pub content_hash: String,
    pub ranges: Vec<DocumentTextRange>,
}
/// Zero-based UTF-16 source offsets, exclusive end, in the exact Markdown body.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DocumentTextRange {
    pub start: u32,
    pub end: u32,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LocalCommentSource {
    pub path: String,
    pub layer: String,
    pub side: String,
    pub version: String,
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
    #[serde(default)]
    pub outdated_comment_ids: Vec<String>,
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
