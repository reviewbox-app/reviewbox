use super::*;

#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct ScopePreview {
    #[serde(default)]
    pub details_ready: bool,
    pub scope: Scope,
    pub files: u32,
    pub additions: u32,
    pub deletions: u32,
    pub binary_files: u32,
    pub partially_staged_files: u32,
    pub commit_count: Option<u32>,
    pub base: Option<String>,
    pub target: Option<String>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct ReviewPreview {
    #[serde(default)]
    pub revision: String,
    pub scopes: Vec<ScopePreview>,
    pub untracked_files: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct RepositoryRef {
    pub name: String,
    pub oid: String,
    /// branch, tag, or commit
    pub kind: String,
    pub summary: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct CaptureProgress {
    pub operation_id: String,
    /// preparing, copying_head, copying_index, copying_worktree, copying_base,
    /// copying_target, comparing, verifying, publishing, or completed.
    pub phase: String,
    pub completed: u32,
    pub total: Option<u32>,
    pub path: Option<String>,
}
