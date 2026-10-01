use super::*;

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct LocalFile {
    pub path: String,
    pub previous_path: Option<String>,
    pub staged_status: Option<String>,
    pub unstaged_status: Option<String>,
    pub conflicted: bool,
    /// Digest of HEAD, index entries and worktree bytes/modes for this file.
    pub version: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct GitCommitSummary {
    pub oid: String,
    pub subject: String,
    pub author: String,
    pub date: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct GitCommitFile {
    pub path: String,
    pub previous_path: Option<String>,
    pub additions: Option<u32>,
    pub deletions: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct GitCommitDetail {
    pub commit: GitCommitSummary,
    pub message: String,
    pub files: Vec<GitCommitFile>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, TS)]
#[serde(rename_all = "camelCase")]
pub struct GitRemoteCheck {
    pub checked_at: Option<String>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct LocalGitState {
    pub repository_id: String,
    pub branch: Option<String>,
    pub head: Option<String>,
    pub upstream: Option<String>,
    pub remotes: Vec<String>,
    pub files: Vec<LocalFile>,
    pub index_version: String,
    pub ahead: u32,
    pub behind: u32,
    pub local_commits: Vec<GitCommitSummary>,
    pub remote_commits: Vec<GitCommitSummary>,
    pub blocked_reason: Option<String>,
    pub remote_check: GitRemoteCheck,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct LocalFileDiff {
    pub version: String,
    pub change: Change,
    pub content: FileContent,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct GitCommitRequest {
    pub operation_id: String,
    pub repository_id: String,
    pub index_version: String,
    /// None asks the project's harness to choose batches and messages.
    pub message: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct GitOperation {
    pub id: String,
    pub repository_id: String,
    pub status: String,
    pub message: String,
    pub commits: Vec<GitCommitSummary>,
    pub error: Option<String>,
}
