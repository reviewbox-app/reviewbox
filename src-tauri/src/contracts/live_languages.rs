use serde::{Deserialize, Serialize};
use ts_rs::TS;

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LiveLanguageDocument {
    pub path: String,
    pub version: i32,
    pub text: String,
    pub language_id: String,
}
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct LiveLanguageSession {
    pub id: String,
    pub server_id: String,
    pub root_uri: String,
    #[ts(type = "Record<string, unknown>")]
    pub capabilities: serde_json::Value,
}
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct LiveLanguageEvent {
    pub session_id: String,
    pub method: String,
    #[ts(type = "unknown")]
    pub params: serde_json::Value,
}
