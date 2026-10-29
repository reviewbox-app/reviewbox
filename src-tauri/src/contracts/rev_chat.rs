use super::*;
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RevChatContext {
    pub selection: DocumentSelection,
    pub term_id: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RevChatRequest {
    pub conversation_id: String,
    pub operation_id: String,
    pub repository_id: String,
    pub review_id: String,
    pub context: RevChatContext,
    pub message: String,
}
