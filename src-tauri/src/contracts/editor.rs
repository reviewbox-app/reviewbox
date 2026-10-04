use serde::{Deserialize, Serialize};
use ts_rs::TS;

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct EditorEntry {
    pub path: String,
    pub directory: bool,
    pub revision: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct EditorSearchMatch {
    pub path: String,
    pub line: u32,
    /// One-based UTF-16 column, matching Monaco's coordinate system.
    pub column: u32,
    pub length: u32,
    pub preview: String,
    /// One-based UTF-16 column within the bounded preview.
    pub preview_column: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS, Default)]
#[serde(rename_all = "camelCase")]
pub struct EditorSearchResult {
    pub request_id: String,
    pub matches: Vec<EditorSearchMatch>,
    pub truncated: bool,
    pub cancelled: bool,
    pub scanned_files: u32,
    pub skipped_files: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct EditorFile {
    pub path: String,
    pub uri: String,
    pub text: String,
    pub revision: String,
    pub read_only: bool,
    pub reason: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EditorDraft {
    pub path: String,
    pub text: String,
    pub base_text: String,
    pub revision: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS, Default)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EditorRecovery {
    pub revision: u32,
    pub drafts: Vec<EditorDraft>,
    pub paths: Vec<String>,
    pub active: Option<String>,
    pub auto_save: bool,
    #[serde(default)]
    pub associations: std::collections::BTreeMap<String, String>,
    #[serde(default)]
    pub servers: std::collections::BTreeMap<String, String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum EditorMutation {
    Save {
        path: String,
        text: String,
        expected_revision: String,
    },
    Create {
        path: String,
        directory: bool,
    },
    Rename {
        path: String,
        destination: String,
        expected_revision: String,
    },
    Trash {
        path: String,
        expected_revision: String,
    },
}
