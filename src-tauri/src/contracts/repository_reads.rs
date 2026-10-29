use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// A hint, not a source revision. Missing events are covered by reconciliation.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct RepositoryReadChange {
    pub repository_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub generation: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional, type = "number")]
    pub sequence: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub changes: Option<Vec<RepositoryPathChange>>,
    /// Checkout-relative paths, including both sides of a rename.
    pub paths: Vec<String>,
    pub tree: bool,
    pub git: bool,
    /// Overflow, explicit mutation or uncertain watcher state.
    pub full: bool,
}

/// File operations remain distinct from Git metadata invalidations.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct RepositoryPathChange {
    pub path: String,
    /// created, changed or deleted; a rename includes both paths.
    pub kind: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct EditorWatchStatus {
    pub healthy: bool,
    pub generation: String,
    #[ts(type = "number")]
    pub sequence: u64,
}
