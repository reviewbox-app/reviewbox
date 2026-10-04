use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use ts_rs::TS;

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticInput {
    pub source: String,
    pub operation: String,
    pub code: String,
    pub message: String,
    pub details: Option<String>,
    pub stack: Option<String>,
    #[serde(default)]
    pub context: BTreeMap<String, String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticEntry {
    pub id: String,
    pub timestamp: String,
    pub session_id: String,
    pub app_version: String,
    pub platform: String,
    pub error: DiagnosticInput,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticLog {
    pub directory: String,
    pub entries: Vec<DiagnosticEntry>,
}
