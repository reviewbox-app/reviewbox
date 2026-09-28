use serde::{Deserialize, Serialize};
use ts_rs::TS;

#[derive(
    Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema, TS, Default,
)]
#[serde(rename_all = "camelCase")]
pub enum ReadingLevel {
    Beginner,
    #[default]
    Intermediate,
    Developer,
}
#[derive(
    Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema, TS, Default,
)]
#[serde(rename_all = "camelCase")]
pub enum ReviewMode {
    Guided,
    #[default]
    Manual,
}
#[derive(
    Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema, TS, Default,
)]
#[serde(rename_all = "camelCase")]
pub enum ReadingContext {
    #[default]
    Guided,
    Files,
}
#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema, TS, Default)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReviewDocument {
    #[serde(default)]
    pub term_aliases: std::collections::BTreeMap<String, String>,
    pub body: String,
    pub references: Vec<DocumentReference>,
    pub terms: Vec<DocumentTerm>,
    pub reading_seconds: u32,
}
#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema, TS, Default)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LevelDocuments {
    #[serde(default)]
    pub glossary: Vec<DocumentTerm>,
    pub beginner: ReviewDocument,
    pub intermediate: ReviewDocument,
    pub developer: ReviewDocument,
}
impl LevelDocuments {
    pub fn get(&self, level: ReadingLevel) -> &ReviewDocument {
        match level {
            ReadingLevel::Beginner => &self.beginner,
            ReadingLevel::Intermediate => &self.intermediate,
            ReadingLevel::Developer => &self.developer,
        }
    }
}
#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DocumentReference {
    pub id: String,
    pub label: String,
    pub explanation: String,
    pub source_id: String,
    pub start_line: u32,
    pub end_line: u32,
}
#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DocumentTerm {
    pub id: String,
    pub term: String,
    pub definition: String,
    pub context: String,
}
#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PseudoBlock {
    pub start_line: u32,
    pub end_line: u32,
    pub text: String,
}
#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PseudoTranslation {
    pub source_id: String,
    pub source_hash: String,
    pub blocks: Vec<PseudoBlock>,
    pub unavailable_reason: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct PseudoTranslationInfo {
    pub source_id: String,
    pub source_hash: String,
    pub available: bool,
    pub unavailable_reason: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct ReviewFile {
    #[serde(default)]
    #[ts(optional)]
    pub pseudocode_selected: Option<bool>,
    #[serde(default)]
    pub pseudocode_skip_reason: Option<String>,
    pub id: String,
    pub path: String,
    pub change_ids: Vec<String>,
    pub has_documents: bool,
    pub translations: Vec<PseudoTranslationInfo>,
}
#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReviewFileContent {
    #[serde(default)]
    #[ts(optional)]
    pub pseudocode_selected: Option<bool>,
    #[serde(default)]
    pub pseudocode_skip_reason: Option<String>,
    pub file_id: String,
    pub documents: Option<LevelDocuments>,
    pub translations: Vec<PseudoTranslation>,
}
#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct SourceDescriptor {
    pub source_id: String,
    pub path: String,
    pub hash: String,
    pub size: u32,
}
#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct FrozenSource {
    pub source_id: String,
    pub path: String,
    pub hash: String,
    pub text: Option<String>,
    pub unavailable_reason: Option<String>,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema, TS)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum DecisionTarget {
    Step {
        #[serde(rename = "stepId")]
        step_id: String,
    },
    File {
        #[serde(rename = "fileId")]
        file_id: String,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub enum DecisionState {
    Examined,
    Validated,
}
