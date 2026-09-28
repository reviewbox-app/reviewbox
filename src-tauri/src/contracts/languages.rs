use serde::{Deserialize, Serialize};
use ts_rs::TS;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub enum LanguageSide {
    Before,
    After,
}

/// A model belongs to immutable captured bytes, including the selected diff side.
#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct LanguageDocument {
    pub snapshot_id: String,
    pub path: String,
    pub change_id: Option<String>,
    pub side: Option<LanguageSide>,
    pub content_hash: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub enum LanguageMethod {
    SemanticTokens,
    Hover,
    Definitions,
    References,
    Symbols,
}

#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct LanguageRequest {
    pub request_id: String,
    pub document: LanguageDocument,
    pub method: LanguageMethod,
    pub line: Option<u32>,
    pub column: Option<u32>,
}

/// Positions exposed to Monaco are one-based UTF-16 positions, with exclusive ends.
#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema, TS, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LanguageRange {
    pub start_line: u32,
    pub start_column: u32,
    pub end_line: u32,
    pub end_column: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct LanguageLocation {
    pub document: LanguageDocument,
    pub range: LanguageRange,
}

#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct LanguageHover {
    pub markdown: String,
    pub range: Option<LanguageRange>,
}

#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct LanguageSymbol {
    pub name: String,
    pub detail: Option<String>,
    pub kind: u32,
    pub location: LanguageLocation,
    pub children: Vec<LanguageSymbol>,
}

#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct LanguageTokens {
    pub data: Vec<u32>,
    pub token_types: Vec<String>,
    pub token_modifiers: Vec<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, schemars::JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct LanguageCapabilities {
    pub semantic_tokens: bool,
    pub hover: bool,
    pub definitions: bool,
    pub references: bool,
    pub symbols: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct LanguageResponse {
    pub request_id: String,
    pub content_hash: String,
    pub server_id: String,
    pub capabilities: LanguageCapabilities,
    pub analysis_note: Option<String>,
    pub hover: Option<LanguageHover>,
    pub locations: Vec<LanguageLocation>,
    pub symbols: Vec<LanguageSymbol>,
    pub tokens: Option<LanguageTokens>,
}
