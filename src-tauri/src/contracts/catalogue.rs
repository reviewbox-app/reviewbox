use serde::{Deserialize, Serialize};
use ts_rs::TS;

#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct LanguageServerCatalogue {
    pub entries: Vec<LanguageServerCatalogueEntry>,
    pub operations: Vec<LanguageServerInstallOperation>,
}

#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct LanguageServerCatalogueEntry {
    pub id: String,
    pub name: String,
    pub description: String,
    pub languages: Vec<String>,
    pub extensions: Vec<String>,
    pub version: String,
    pub installed_version: Option<String>,
    pub status: String,
    pub enabled: bool,
    pub supported: bool,
    pub setup_required: Option<String>,
    pub source_url: String,
    pub runtime: Option<String>,
    pub prerequisites: Vec<String>,
    pub error: Option<String>,
    pub preview: bool,
    pub capabilities: Option<super::LanguageCapabilities>,
}

#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct LanguageServerInstallOperation {
    pub id: String,
    pub server_id: String,
    pub status: String,
    pub phase: String,
    pub message: String,
    pub downloaded_bytes: u64,
    pub total_bytes: Option<u64>,
}
