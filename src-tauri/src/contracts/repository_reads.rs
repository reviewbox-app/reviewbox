use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// A hint, not a source revision. Missing events are covered by reconciliation.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct RepositoryReadChange {
    pub repository_id: String,
    /// Checkout-relative paths, including both sides of a rename.
    pub paths: Vec<String>,
    pub tree: bool,
    pub git: bool,
    /// Overflow, explicit mutation or uncertain watcher state.
    pub full: bool,
}
