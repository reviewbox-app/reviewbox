use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// A navigation destination, not a human validation of the review.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, TS)]
#[serde(rename_all = "camelCase")]
pub struct ReviewNotificationTarget {
    pub operation_id: String,
    pub repository_id: String,
    pub review_id: String,
}
