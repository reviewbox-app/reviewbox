use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use ts_rs::TS;

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ProjectSkillPreferences {
    pub revision: u32,
    pub enabled: bool,
    #[serde(default)]
    pub projects: BTreeMap<String, bool>,
}
impl Default for ProjectSkillPreferences {
    fn default() -> Self {
        Self {
            revision: 0,
            enabled: true,
            projects: BTreeMap::new(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ProjectSkillImport {
    pub repository_id: String,
    pub enabled: bool,
    pub created: Vec<String>,
    pub preserved: Vec<String>,
    pub error: Option<super::AppError>,
}
