use serde::{Deserialize, Serialize};
use ts_rs::TS;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub enum ProviderAuthentication {
    Authenticated,
    SignedOut,
    Unknown,
    Unavailable,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub enum ProviderInstallationMethod {
    Native,
    Npm,
    Homebrew,
    Unsupported,
}

#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct ProviderInstallation {
    pub method: ProviderInstallationMethod,
    pub command: Option<String>,
    pub can_run: bool,
    pub is_update: bool,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProviderSetupRequest {
    pub operation_id: String,
    pub provider: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub enum ProviderSetupPhase {
    Checking,
    Downloading,
    Installing,
    Detecting,
    Complete,
    Cancelled,
    Failed,
}

#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct ProviderSetupEvent {
    pub operation_id: String,
    pub provider: String,
    pub phase: ProviderSetupPhase,
    pub message: String,
}
