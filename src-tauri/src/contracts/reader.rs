use serde::{Deserialize, Serialize};
use ts_rs::TS;

#[derive(
    Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema, TS, Default,
)]
#[serde(rename_all = "camelCase")]
pub enum ReadingLevel {
    #[serde(alias = "beginner")]
    Essential,
    #[default]
    #[serde(alias = "intermediate")]
    Explained,
    #[serde(alias = "developer")]
    Technical,
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub dependencies: Option<DocumentDependencies>,
    #[serde(default)]
    pub context_sources: Vec<String>,
    #[serde(default)]
    pub glossary: Vec<DocumentTerm>,
    #[serde(alias = "beginner")]
    pub essential: ReviewDocument,
    #[serde(alias = "intermediate")]
    pub explained: ReviewDocument,
    #[serde(alias = "developer")]
    pub technical: ReviewDocument,
}
#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DocumentDependencies {
    pub signature: String,
    pub sources: Vec<SourceDescriptor>,
}
impl LevelDocuments {
    pub fn get(&self, level: ReadingLevel) -> &ReviewDocument {
        match level {
            ReadingLevel::Essential => &self.essential,
            ReadingLevel::Explained => &self.explained,
            ReadingLevel::Technical => &self.technical,
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
#[serde(rename_all = "camelCase")]
pub struct ReviewFile {
    pub id: String,
    pub path: String,
    pub change_ids: Vec<String>,
    pub has_documents: bool,
}
#[derive(Debug, Clone, Serialize, schemars::JsonSchema, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReviewFileContent {
    pub file_id: String,
    pub documents: Option<LevelDocuments>,
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

impl<'de> Deserialize<'de> for ReviewFileContent {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
        struct Stored {
            file_id: String,
            documents: Option<LevelDocuments>,
            #[serde(default, rename = "pseudocodeSelected")]
            _selected: serde::de::IgnoredAny,
            #[serde(default, rename = "pseudocodeSkipReason")]
            _reason: serde::de::IgnoredAny,
            #[serde(default, rename = "translations")]
            _translations: serde::de::IgnoredAny,
        }
        let stored = Stored::deserialize(deserializer)?;
        Ok(Self {
            file_id: stored.file_id,
            documents: stored.documents,
        })
    }
}
