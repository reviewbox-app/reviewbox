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
#[derive(
    Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema, TS,
)]
#[serde(rename_all = "camelCase")]
pub enum ReviewWritingStyle {
    #[default]
    Essential,
    Explained,
    Technical,
    Custom,
}
#[derive(
    Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema, TS,
)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReviewWritingProfile {
    pub style: ReviewWritingStyle,
    #[serde(default)]
    pub instructions: String,
}
#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SingleReviewDocument {
    pub version: u32,
    pub profile: ReviewWritingProfile,
    pub content: ReviewDocument,
}
impl ReviewDocument {
    fn is_empty(&self) -> bool {
        self.body.is_empty()
            && self.references.is_empty()
            && self.terms.is_empty()
            && self.term_aliases.is_empty()
            && self.reading_seconds == 0
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema, TS, Default)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LevelDocuments {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub single: Option<SingleReviewDocument>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub dependencies: Option<DocumentDependencies>,
    #[serde(default)]
    pub context_sources: Vec<String>,
    #[serde(default)]
    pub glossary: Vec<DocumentTerm>,
    #[serde(
        default,
        alias = "beginner",
        skip_serializing_if = "ReviewDocument::is_empty"
    )]
    pub essential: ReviewDocument,
    #[serde(
        default,
        alias = "intermediate",
        skip_serializing_if = "ReviewDocument::is_empty"
    )]
    pub explained: ReviewDocument,
    #[serde(
        default,
        alias = "developer",
        skip_serializing_if = "ReviewDocument::is_empty"
    )]
    pub technical: ReviewDocument,
}
#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DocumentDependencies {
    pub signature: String,
    pub sources: Vec<SourceDescriptor>,
}
impl LevelDocuments {
    pub fn documents(&self) -> Vec<&ReviewDocument> {
        if let Some(single) = &self.single {
            vec![&single.content]
        } else {
            vec![&self.essential, &self.explained, &self.technical]
        }
    }
    pub fn documents_mut(&mut self) -> Vec<&mut ReviewDocument> {
        if let Some(single) = &mut self.single {
            vec![&mut single.content]
        } else {
            vec![
                &mut self.essential,
                &mut self.explained,
                &mut self.technical,
            ]
        }
    }

    pub fn get(&self, level: ReadingLevel) -> &ReviewDocument {
        if let Some(single) = &self.single {
            return &single.content;
        }
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
