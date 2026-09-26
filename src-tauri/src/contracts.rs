use serde::{Deserialize, Serialize};
use ts_rs::TS;

#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct AppError {
    pub code: String,
    pub message: String,
    pub retryable: bool,
}
pub type AppResult<T> = Result<T, AppError>;
impl AppError {
    pub fn new(code: &str, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
            retryable: false,
        }
    }
}
impl From<std::io::Error> for AppError {
    fn from(e: std::io::Error) -> Self {
        Self::new("io", e.to_string())
    }
}
impl From<rusqlite::Error> for AppError {
    fn from(e: rusqlite::Error) -> Self {
        Self::new("storage", e.to_string())
    }
}
impl From<serde_json::Error> for AppError {
    fn from(e: serde_json::Error) -> Self {
        Self::new("invalid_document", e.to_string())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct Repository {
    pub id: String,
    pub path: String,
    pub name: String,
    pub branch: String,
    pub opened_at: String,
}
#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema, TS, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum Scope {
    Local,
    Staged,
    Unstaged,
    Commit,
    Range,
}
#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct CaptureRequest {
    pub repository_id: String,
    pub scope: Scope,
    pub base: Option<String>,
    pub target: Option<String>,
    pub include_untracked: bool,
}
#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct BlobRef {
    pub hash: String,
    pub size: u32,
    pub mode: String,
}
#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotFile {
    pub path: String,
    pub content: BlobRef,
}
#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct Passage {
    pub id: String,
    pub old_start: u32,
    pub old_lines: u32,
    pub new_start: u32,
    pub new_lines: u32,
    pub fingerprint: String,
}
#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct Change {
    pub id: String,
    pub path: String,
    pub previous_path: Option<String>,
    pub layer: String,
    pub before: Option<BlobRef>,
    pub after: Option<BlobRef>,
    pub binary: bool,
    pub passages: Vec<Passage>,
}
#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    #[serde(default)]
    pub git_refs: Vec<String>,
    #[serde(default)]
    pub head_fingerprint: String,
    pub id: String,
    pub repository_id: String,
    pub created_at: String,
    pub request: CaptureRequest,
    pub head: String,
    pub workspace_fingerprint: String,
    #[serde(default)]
    pub index_fingerprint: String,
    pub files: Vec<SnapshotFile>,
    pub changes: Vec<Change>,
}
#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct CodeAnchor {
    pub snapshot_id: String,
    pub change_id: String,
    pub passage_id: String,
}
#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct Step {
    pub id: String,
    pub title: String,
    pub explanation: String,
    pub anchors: Vec<CodeAnchor>,
}
#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct Topic {
    pub id: String,
    pub title: String,
    pub brief: String,
    pub steps: Vec<Step>,
}
#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct Annotation {
    #[serde(default)]
    pub resolved_by: Option<String>,
    #[serde(default)]
    pub resolved_at: Option<String>,
    pub id: String,
    pub anchor: CodeAnchor,
    pub body: String,
    pub question: bool,
    pub resolved: bool,
    pub author: String,
    pub created_at: String,
}
#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct Decision {
    #[serde(default = "legacy_author")]
    pub author: String,
    pub id: String,
    pub anchor: CodeAnchor,
    pub fingerprint: String,
    pub created_at: String,
}
#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema, TS, Default)]
#[serde(rename_all = "camelCase")]
pub struct ReadingPosition {
    pub change_id: Option<String>,
    pub passage_id: Option<String>,
    pub step_id: Option<String>,
    pub line: u32,
    pub scroll_top: f64,
    pub split: bool,
}
#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct Review {
    pub id: String,
    pub title: String,
    pub repository_id: String,
    pub snapshot_id: String,
    pub previous_snapshot_ids: Vec<String>,
    pub revision: u32,
    pub topics: Vec<Topic>,
    pub annotations: Vec<Annotation>,
    pub decisions: Vec<Decision>,
    #[serde(default)]
    pub examined: Vec<String>,
    #[serde(default)]
    pub position: ReadingPosition,
    pub created_at: String,
    pub updated_at: String,
}
#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct Workspace {
    pub review: Review,
    pub snapshot: Snapshot,
}
#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct FileContent {
    pub before: Option<String>,
    pub after: Option<String>,
    pub unavailable_reason: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema, TS)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ReviewAction {
    Rename {
        title: String,
    },
    SaveTopics {
        topics: Vec<Topic>,
    },
    Validate {
        anchor: CodeAnchor,
    },
    Reopen {
        anchor: CodeAnchor,
    },
    Examine {
        anchor: CodeAnchor,
    },
    AddAnnotation {
        anchor: CodeAnchor,
        body: String,
        question: bool,
    },
    KeepAgentNote {
        anchor: CodeAnchor,
        #[serde(rename = "runId")]
        run_id: String,
    },
    ResolveQuestion {
        id: String,
        resolved: bool,
    },
    DeleteAnnotation {
        id: String,
    },
    SavePosition {
        position: ReadingPosition,
    },
}
#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct Coverage {
    pub total: u32,
    pub examined: u32,
    pub validated: u32,
    pub outside: u32,
    pub questions: u32,
    pub complete: bool,
}
#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct Sense {
    pub id: String,
    pub description: String,
}
#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct GlossaryTerm {
    pub id: String,
    pub term: String,
    pub aliases: Vec<String>,
    pub senses: Vec<Sense>,
    pub archived: bool,
}
#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct ExplanationSection {
    pub id: String,
    pub title: String,
    pub body: String,
    pub start_line: u32,
    pub end_line: u32,
}
#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct TermOccurrence {
    pub id: String,
    pub section_id: String,
    pub quote: String,
    pub offset: u32,
    pub description: Option<String>,
    pub term_id: Option<String>,
    pub sense_id: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct ExplanationDocument {
    pub id: String,
    pub repository_id: String,
    pub snapshot_id: String,
    pub path: String,
    pub fingerprint: String,
    pub language: String,
    pub sections: Vec<ExplanationSection>,
    pub occurrences: Vec<TermOccurrence>,
    pub created_at: String,
}
#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct ProjectKnowledge {
    pub repository_id: String,
    pub language: String,
    pub terms: Vec<GlossaryTerm>,
    pub documents: Vec<ExplanationDocument>,
    pub revision: u32,
}
#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct ProviderStatus {
    pub provider: String,
    pub available: bool,
    pub version: Option<String>,
    pub message: String,
}
#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct PromptPreview {
    pub action: String,
    pub text: String,
    pub fingerprint: String,
    pub sources: Vec<String>,
}

pub fn legacy_author() -> String {
    "human:legacy".into()
}

#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProjectSettings {
    pub revision: u32,
    pub language: String,
    pub default_scope: Scope,
    pub include_untracked: bool,
    pub provider: Option<String>,
    pub model: Option<String>,
}
impl Default for ProjectSettings {
    fn default() -> Self {
        Self {
            revision: 0,
            language: "French".into(),
            default_scope: Scope::Local,
            include_untracked: false,
            provider: None,
            model: None,
        }
    }
}

pub fn id() -> String {
    uuid::Uuid::new_v4().to_string()
}
pub fn now() -> String {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .to_string()
}
pub fn fingerprint(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    Sha256::digest(bytes)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

pub fn typescript() -> String {
    let cfg = ts_rs::Config::default();
    let declarations = [
        AppError::decl(&cfg),
        ProjectSettings::decl(&cfg),
        Repository::decl(&cfg),
        Scope::decl(&cfg),
        CaptureRequest::decl(&cfg),
        BlobRef::decl(&cfg),
        SnapshotFile::decl(&cfg),
        Passage::decl(&cfg),
        Change::decl(&cfg),
        Snapshot::decl(&cfg),
        CodeAnchor::decl(&cfg),
        Step::decl(&cfg),
        Topic::decl(&cfg),
        Annotation::decl(&cfg),
        Decision::decl(&cfg),
        ReadingPosition::decl(&cfg),
        Review::decl(&cfg),
        Workspace::decl(&cfg),
        FileContent::decl(&cfg),
        ReviewAction::decl(&cfg),
        Coverage::decl(&cfg),
        Sense::decl(&cfg),
        GlossaryTerm::decl(&cfg),
        ExplanationSection::decl(&cfg),
        TermOccurrence::decl(&cfg),
        ExplanationDocument::decl(&cfg),
        ProjectKnowledge::decl(&cfg),
        ProviderStatus::decl(&cfg),
        PromptPreview::decl(&cfg),
        AgentRequest::decl(&cfg),
        AgentEvent::decl(&cfg),
        AgentRun::decl(&cfg),
        TestRun::decl(&cfg),
        LanguageServerConfig::decl(&cfg),
        LanguageServerSettings::decl(&cfg),
        CodeLocation::decl(&cfg),
        ProposalContent::decl(&cfg),
        Proposal::decl(&cfg),
        OnboardingStep::decl(&cfg),
        OnboardingTour::decl(&cfg),
        CurrentTourStep::decl(&cfg),
        TourImportReport::decl(&cfg),
        ProviderConfig::decl(&cfg),
        ProviderSettings::decl(&cfg),
    ];
    format!(
        "// Generated by bun run contracts:generate. Do not edit.\n{}\n",
        declarations
            .iter()
            .map(|s| format!("export {s}"))
            .collect::<Vec<_>>()
            .join("\n")
    )
}

#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct AgentRequest {
    pub id: String,
    pub review_id: String,
    pub provider: String,
    pub action: String,
    pub request: String,
    pub paths: Vec<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct AgentEvent {
    pub run_id: String,
    pub sequence: u32,
    pub kind: String,
    pub text: String,
}
#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct AgentRun {
    pub id: String,
    pub review_id: String,
    pub snapshot_id: String,
    pub provider: String,
    pub action: String,
    pub prompt: PromptPreview,
    pub paths: Vec<String>,
    pub output: String,
    pub status: String,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct TestRun {
    pub id: String,
    pub review_id: String,
    pub snapshot_id: String,
    pub command: Vec<String>,
    pub cwd: String,
    pub status: String,
    pub output: String,
    pub exit_code: Option<i32>,
    pub started_at: Option<String>,
    pub finished_at: Option<String>,
    pub before_fingerprint: Option<String>,
    pub after_fingerprint: Option<String>,
    pub snapshot_matches: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct LanguageServerConfig {
    pub id: String,
    pub name: String,
    pub extensions: Vec<String>,
    pub executable: String,
    pub arguments: Vec<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct LanguageServerSettings {
    pub servers: Vec<LanguageServerConfig>,
    pub revision: u32,
}
#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct CodeLocation {
    pub path: String,
    pub line: u32,
    pub column: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema, TS)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub enum ProposalContent {
    Topics {
        topics: Vec<Topic>,
    },
    Explanation {
        path: String,
        sections: Vec<ExplanationSection>,
    },
    Glossary {
        terms: Vec<GlossaryTerm>,
    },
}
#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct Proposal {
    pub id: String,
    pub review_id: String,
    pub snapshot_id: String,
    pub run_id: Option<String>,
    pub content: ProposalContent,
    pub status: String,
    pub revision: u32,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct OnboardingStep {
    pub id: String,
    pub title: String,
    pub explanation: String,
    pub path: String,
    pub start_line: u32,
    pub end_line: u32,
    pub quote: String,
    pub fingerprint: String,
    #[serde(default)]
    pub visited: bool,
}
#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct OnboardingTour {
    pub id: String,
    pub repository_id: String,
    pub title: String,
    pub steps: Vec<OnboardingStep>,
    pub revision: u32,
}
#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct CurrentTourStep {
    pub content: String,
    pub status: String,
    pub start_line: u32,
    pub end_line: u32,
}
#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct TourImportReport {
    pub tour: OnboardingTour,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct ProviderConfig {
    pub provider: String,
    pub executable: String,
    pub model: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct ProviderSettings {
    pub revision: u32,
    pub default_provider: String,
    pub providers: Vec<ProviderConfig>,
}
