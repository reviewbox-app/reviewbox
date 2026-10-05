use serde::{Deserialize, Serialize};
use ts_rs::TS;

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct EditorEntry {
    pub path: String,
    pub directory: bool,
    pub revision: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub ignored: Option<bool>,
    /// Excluded by a direct or inherited rule, unlike an ignored-only parent.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub excluded: Option<bool>,
    /// An ignored directory whose children are loaded when expanded.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub lazy: Option<bool>,
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

/// A stream belongs to one caller/checkout/query; old batches are discarded by identity.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct EditorSearchBatch {
    pub request_id: String,
    pub sequence: u32,
    pub matches: Vec<EditorSearchMatch>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct EditorSearchBuffer {
    pub path: String,
    pub version: u32,
    pub text: String,
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

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EditorSaveActions {
    pub format_on_save: bool,
    pub organize_imports_on_save: bool,
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
    #[serde(default)]
    #[ts(optional)]
    pub save_actions: Option<std::collections::BTreeMap<String, EditorSaveActions>>,
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

/// Private navigation for one checkout, independent of source buffers and captures.
#[derive(Debug, Clone, Serialize, Deserialize, TS, Default)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FileTreeNavigation {
    pub expanded_paths: Vec<String>,
    pub selected_path: Option<String>,
    pub scroll_top: f64,
    pub mode: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS, Default)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CheckoutNavigation {
    pub revision: u32,
    pub trees: std::collections::BTreeMap<String, FileTreeNavigation>,
}
