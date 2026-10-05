use serde::{Deserialize, Serialize};
use ts_rs::TS;

mod repository_reads;
pub use repository_reads::*;
mod source_control;
pub use source_control::*;
mod appearance;
mod creation;
pub use appearance::*;
mod catalogue;
pub use catalogue::*;
mod languages;
pub use languages::*;
mod editor;
pub use editor::*;
mod live_languages;
pub use live_languages::*;
mod language_packs;
pub use language_packs::*;
mod language_setup;
pub use language_setup::*;
mod reader;
pub use reader::*;
mod notifications;
mod preparation;
pub use notifications::*;
mod diagnostics;
pub use diagnostics::*;
mod provider_setup;
mod publication;
pub use creation::*;
pub use preparation::*;
pub use provider_setup::*;
pub use publication::*;

#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct AppError {
    pub code: String,
    pub message: String,
    pub retryable: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub details: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub diagnostic_id: Option<String>,
}
pub type AppResult<T> = Result<T, AppError>;
impl AppError {
    pub fn new(code: &str, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
            retryable: false,
            details: None,
            diagnostic_id: None,
        }
    }
    pub(crate) fn with_details(mut self, details: impl AsRef<str>) -> Self {
        self.details = Some(crate::diagnostics::redact(details.as_ref(), 16_384));
        self
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

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, TS)]
#[serde(rename_all = "camelCase")]
pub enum ReviewMenuAction {
    ViewLocalChanges,
    Refresh,
    CompleteManual,
    CompleteUpdated,
    KeepLocal,
    RetryPublication,
    Reopen,
    Details,
    Summary,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, TS)]
#[serde(rename_all = "camelCase")]
pub struct ReviewMenuEntry {
    pub action: ReviewMenuAction,
    pub enabled: bool,
}

/// Presentation state of the review currently open in the main reader.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, TS)]
#[serde(rename_all = "camelCase")]
pub struct ReviewMenuState {
    pub review_id: String,
    pub snapshot_id: String,
    pub status: PublicationStatus,
    pub update_with_rev: bool,
    pub keep_local: bool,
    pub entries: Vec<ReviewMenuEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ReviewMenuEvent {
    pub review_id: String,
    pub snapshot_id: String,
    pub action: ReviewMenuAction,
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
#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema, TS, PartialEq, Eq)]
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
    #[serde(default)]
    pub untracked: bool,
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
    pub documents: LevelDocuments,
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
pub struct Decision {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub carried_from: Option<DecisionOrigin>,
    #[serde(default = "legacy_author")]
    pub author: String,
    pub id: String,
    pub target: DecisionTarget,
    pub state: DecisionState,
    pub fingerprint: String,
    pub created_at: String,
}
#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct DecisionOrigin {
    pub review_id: String,
    pub snapshot_id: String,
    pub decision_id: String,
}
#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema, TS, Default)]
#[serde(rename_all = "camelCase")]
pub struct ReadingPosition {
    pub context: ReadingContext,
    pub file_id: Option<String>,
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub update_origin: Option<ReviewAdaptation>,
    #[serde(default)]
    pub needs_update_confirmation: bool,
    pub publication: ReviewPublication,
    #[serde(default)]
    pub glossary: Vec<DocumentTerm>,
    pub id: String,
    pub title: String,
    pub repository_id: String,
    pub snapshot_id: String,
    pub previous_snapshot_ids: Vec<String>,
    pub revision: u32,
    pub topics: Vec<Topic>,
    pub mode: ReviewMode,
    pub preparation_id: Option<String>,
    pub files: Vec<ReviewFile>,
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
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ReviewFreshness {
    pub changed: bool,
    pub stale_step_ids: Vec<String>,
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
    CompleteUpdatedReview,
    CompleteManualReview,
    ReopenReview,
    SetKeepLocal {
        #[serde(rename = "keepLocal")]
        keep_local: bool,
    },
    RetryPublication,
    Rename {
        title: String,
    },
    SaveTopics {
        topics: Vec<Topic>,
    },
    ExamineStep {
        #[serde(rename = "stepId")]
        step_id: String,
    },
    ExamineFile {
        #[serde(rename = "fileId")]
        file_id: String,
    },
    ValidateStep {
        #[serde(rename = "stepId")]
        step_id: String,
    },
    ReopenStep {
        #[serde(rename = "stepId")]
        step_id: String,
    },
    ValidateFile {
        #[serde(rename = "fileId")]
        file_id: String,
    },
    ReopenFile {
        #[serde(rename = "fileId")]
        file_id: String,
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
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub enum ProviderCompatibility {
    Compatible,
    Outdated,
    Unknown,
    Unavailable,
}
#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct ProviderStatus {
    pub authentication: ProviderAuthentication,
    pub ready: bool,
    pub installation: ProviderInstallation,
    pub login_command: Option<String>,
    pub compatibility: ProviderCompatibility,
    pub minimum_version: Option<String>,
    pub executable: String,
    pub update_command: Option<String>,
    pub update_instructions: Option<String>,
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
    #[serde(default)]
    pub default_preparation: PreparationMode,
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
            default_preparation: PreparationMode::Rev,
            include_untracked: true,
            provider: None,
            model: None,
        }
    }
}

#[derive(
    Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema, TS,
)]
#[serde(rename_all = "camelCase")]
pub enum PreparationMode {
    #[default]
    Rev,
    Manual,
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
        TerminalSession::decl(&cfg),
        TerminalEvent::decl(&cfg),
        TerminalLink::decl(&cfg),
        LanguageSetupRequest::decl(&cfg),
        LanguageSetupFile::decl(&cfg),
        LanguageSetupCommand::decl(&cfg),
        LanguageSetupServer::decl(&cfg),
        LanguageSetupPlan::decl(&cfg),
        LanguageSetupStatus::decl(&cfg),
        LanguageDefinition::decl(&cfg),
        LanguagePackArtifact::decl(&cfg),
        LanguagePackInstallation::decl(&cfg),
        LanguagePackServer::decl(&cfg),
        LanguagePack::decl(&cfg),
        LanguageRootStrategy::decl(&cfg),
        LanguageRegistry::decl(&cfg),
        LiveLanguageDocument::decl(&cfg),
        LiveLanguageChange::decl(&cfg),
        LiveLanguageSession::decl(&cfg),
        LiveLanguageProjectContext::decl(&cfg),
        LiveLanguageEvent::decl(&cfg),
        LiveLanguageProjectSettings::decl(&cfg),
        RepositoryReadChange::decl(&cfg),
        RepositoryPathChange::decl(&cfg),
        EditorEntry::decl(&cfg),
        EditorWatchStatus::decl(&cfg),
        EditorSearchMatch::decl(&cfg),
        EditorSearchResult::decl(&cfg),
        EditorSearchBatch::decl(&cfg),
        EditorSearchBuffer::decl(&cfg),
        EditorFile::decl(&cfg),
        EditorDraft::decl(&cfg),
        EditorSaveActions::decl(&cfg),
        EditorRecovery::decl(&cfg),
        EditorMutation::decl(&cfg),
        AppError::decl(&cfg),
        DiagnosticInput::decl(&cfg),
        DiagnosticEntry::decl(&cfg),
        DiagnosticLog::decl(&cfg),
        ReviewMenuAction::decl(&cfg),
        ReviewMenuEntry::decl(&cfg),
        ReviewMenuState::decl(&cfg),
        LocalFile::decl(&cfg),
        LocalFileSelection::decl(&cfg),
        GitCommitSummary::decl(&cfg),
        GitCommitFile::decl(&cfg),
        GitCommitDetail::decl(&cfg),
        GitRemoteCheck::decl(&cfg),
        LocalGitState::decl(&cfg),
        LocalFileDiff::decl(&cfg),
        GitCommitRequest::decl(&cfg),
        GitOperation::decl(&cfg),
        ReviewMenuEvent::decl(&cfg),
        ProjectSettings::decl(&cfg),
        PreparationMode::decl(&cfg),
        ReviewPreview::decl(&cfg),
        ScopePreview::decl(&cfg),
        RepositoryRef::decl(&cfg),
        CaptureProgress::decl(&cfg),
        ProviderAuthentication::decl(&cfg),
        ProviderInstallationMethod::decl(&cfg),
        ProviderInstallation::decl(&cfg),
        ProviderSetupRequest::decl(&cfg),
        ProviderUpdateCheck::decl(&cfg),
        ProviderSetupEvent::decl(&cfg),
        ProviderSetupPhase::decl(&cfg),
        AgentPreparationContext::decl(&cfg),
        ProposalDiagnostic::decl(&cfg),
        PreparationRequest::decl(&cfg),
        PreparationState::decl(&cfg),
        PreparationStep::decl(&cfg),
        PreparationStepStatus::decl(&cfg),
        ReviewAdaptation::decl(&cfg),
        PreparationBatch::decl(&cfg),
        PreparationBatchStatus::decl(&cfg),
        PreparationPhaseCount::decl(&cfg),
        PreparationStatus::decl(&cfg),
        ReviewNotificationTarget::decl(&cfg),
        PreparationPhase::decl(&cfg),
        Repository::decl(&cfg),
        Scope::decl(&cfg),
        CaptureRequest::decl(&cfg),
        BlobRef::decl(&cfg),
        SnapshotFile::decl(&cfg),
        Passage::decl(&cfg),
        Change::decl(&cfg),
        Snapshot::decl(&cfg),
        CodeAnchor::decl(&cfg),
        ReadingLevel::decl(&cfg),
        ReviewMode::decl(&cfg),
        ReadingContext::decl(&cfg),
        ReviewDocument::decl(&cfg),
        LevelDocuments::decl(&cfg),
        DocumentDependencies::decl(&cfg),
        DocumentReference::decl(&cfg),
        DocumentTerm::decl(&cfg),
        ReviewFile::decl(&cfg),
        ReviewFileContent::decl(&cfg),
        SourceDescriptor::decl(&cfg),
        FrozenSource::decl(&cfg),
        DecisionTarget::decl(&cfg),
        DecisionState::decl(&cfg),
        Step::decl(&cfg),
        Topic::decl(&cfg),
        Decision::decl(&cfg),
        DecisionOrigin::decl(&cfg),
        ReadingPosition::decl(&cfg),
        PublicationStatus::decl(&cfg),
        ReviewCompletionKind::decl(&cfg),
        ReviewCompletion::decl(&cfg),
        ReviewArchive::decl(&cfg),
        ReviewPublication::decl(&cfg),
        Review::decl(&cfg),
        Workspace::decl(&cfg),
        ReviewFreshness::decl(&cfg),
        FileContent::decl(&cfg),
        ReviewAction::decl(&cfg),
        Coverage::decl(&cfg),
        Sense::decl(&cfg),
        GlossaryTerm::decl(&cfg),
        ExplanationSection::decl(&cfg),
        TermOccurrence::decl(&cfg),
        ExplanationDocument::decl(&cfg),
        ProjectKnowledge::decl(&cfg),
        ProviderCompatibility::decl(&cfg),
        ProviderStatus::decl(&cfg),
        PromptPreview::decl(&cfg),
        AgentEvent::decl(&cfg),
        AgentProgress::decl(&cfg),
        AgentPlanStep::decl(&cfg),
        AgentPlanStatus::decl(&cfg),
        AgentActivityKind::decl(&cfg),
        AgentActivityStatus::decl(&cfg),
        AgentRun::decl(&cfg),
        LanguageServerConfig::decl(&cfg),
        CodeTheme::decl(&cfg),
        AppearancePreferences::decl(&cfg),
        EditorExtensionId::decl(&cfg),
        EditorExtensionPreferences::decl(&cfg),
        EditorPathSuggestion::decl(&cfg),
        LanguageSide::decl(&cfg),
        LanguageDocument::decl(&cfg),
        LanguageMethod::decl(&cfg),
        LanguageRequest::decl(&cfg),
        LanguageRange::decl(&cfg),
        LanguageLocation::decl(&cfg),
        LanguageHover::decl(&cfg),
        LanguageSymbol::decl(&cfg),
        LanguageTokens::decl(&cfg),
        LanguageCapabilities::decl(&cfg),
        LanguageResponse::decl(&cfg),
        LanguageServerSettings::decl(&cfg),
        LanguageServerCatalogue::decl(&cfg),
        LanguageServerCatalogueEntry::decl(&cfg),
        LanguageServerInstallOperation::decl(&cfg),
        CodeLocation::decl(&cfg),
        ProposalContent::decl(&cfg),
        Proposal::decl(&cfg),
        OnboardingStep::decl(&cfg),
        OnboardingTour::decl(&cfg),
        CurrentTourStep::decl(&cfg),
        TourImportReport::decl(&cfg),
        ProviderConfig::decl(&cfg),
        ProviderModel::decl(&cfg),
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
pub struct AgentEvent {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub batch_id: Option<String>,
    pub run_id: String,
    pub sequence: u32,
    pub kind: String,
    pub text: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub progress: Option<AgentProgress>,
}
/// Transient presentation events, never included in the provider's final output.
#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema, TS)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum AgentProgress {
    Delegation {
        id: String,
        parent: String,
        task: String,
        model: Option<String>,
        status: AgentActivityStatus,
    },
    Usage {
        id: String,
        input: u64,
        cached: u64,
        output: u64,
    },
    Draft {
        characters: u32,
        topics: Vec<String>,
    },
    Plan {
        steps: Vec<AgentPlanStep>,
    },
    Activity {
        id: String,
        category: AgentActivityKind,
        status: AgentActivityStatus,
    },
    Message {
        id: String,
        text: String,
    },
}
#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema, TS)]
pub struct AgentPlanStep {
    pub text: String,
    pub status: AgentPlanStatus,
}
#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub enum AgentPlanStatus {
    Pending,
    InProgress,
    Completed,
}
#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub enum AgentActivityKind {
    Read,
    Search,
    ListFiles,
    Command,
    Tool,
    FileChange,
    WebSearch,
    Compaction,
    Draft,
}
#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub enum AgentActivityStatus {
    InProgress,
    Completed,
    Failed,
    Interrupted,
}
#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct AgentRun {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub repository_id: Option<String>,
    /// Code Explain source context; no review is required when present.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub context_id: Option<String>,
    pub id: String,
    pub review_id: String,
    pub snapshot_id: String,
    pub provider: String,
    pub action: String,
    /// Older local runs only stored the rendered prompt.
    #[serde(default)]
    pub request: Option<String>,
    pub prompt: PromptPreview,
    pub paths: Vec<String>,
    pub output: String,
    pub status: String,
    pub created_at: String,
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
    /// Code Explain source context; no review is required when present.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub context_id: Option<String>,
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
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ProviderModel {
    pub id: String,
    pub resolved_model: Option<String>,
    pub name: String,
    pub description: String,
    pub supported_efforts: Vec<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct ProviderSettings {
    #[serde(default = "default_helper_model")]
    pub helper_model: String,
    pub revision: u32,
    #[serde(default)]
    pub model_defaults_version: u32,
    pub default_provider: String,
    pub providers: Vec<ProviderConfig>,
}

fn default_helper_model() -> String {
    "gpt-6-luna".into()
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct TerminalSession {
    pub id: String,
    pub repository_id: String,
    pub shell: String,
    pub cwd: String,
    pub exited: bool,
    pub exit_code: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum TerminalEvent {
    Data {
        id: String,
        sequence: u32,
        bytes: Vec<u8>,
    },
    Exit {
        id: String,
        code: Option<u32>,
    },
    Error {
        id: String,
        message: String,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct TerminalLink {
    pub path: String,
    pub line: u32,
    pub column: u32,
}
