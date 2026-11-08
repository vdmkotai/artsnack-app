//! `packages/backend/convex/comfyVideo.ts`: the self-hosted video pod's side
//! of a `grokGenerations` row.

use serde::Deserialize;

use super::grok_generations::{ApiGeneration, IdArgs};
use crate::{NoArgs, PaginatedQuery, Query};

/// The self-hosted video tab's results: the user's `grokGenerations` rows with
/// `provider: "comfy"`, newest first. Hot like `grokGenerations:list`.
pub const LIST: PaginatedQuery<NoArgs, ApiGeneration> = PaginatedQuery::new("comfyVideo:list");

/// What a self-hosted clip ran on, for the viewer's details panel.
#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunDetails {
    /// RunPod's GPU type id, e.g. "NVIDIA RTX PRO 6000 Blackwell".
    pub gpu_type: String,
    pub gpu_name: Option<String>,
    pub gpu_count: f64,
    /// Which of the pod's GPUs rendered it, zero-based; absent on older rows.
    pub gpu_index: Option<f64>,
    /// "SECURE" or "COMMUNITY".
    pub cloud_type: String,
    /// The whole pod's price, every GPU included.
    pub hourly_usd: f64,
    pub pod_id: Option<String>,
}

/// `None` for an API row, a row that is gone, or a pod that was deleted.
pub const RUN_DETAILS: Query<IdArgs, Option<RunDetails>> = Query::new("comfyVideo:runDetails");

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decodes_run_details() {
        let details: Option<RunDetails> = serde_json::from_value(serde_json::json!({
            "gpuType": "NVIDIA B300",
            "gpuName": "B300",
            "gpuCount": 2.0,
            "gpuIndex": 1.0,
            "cloudType": "SECURE",
            "hourlyUsd": 9.98,
            "podId": "abc"
        }))
        .unwrap();
        let details = details.unwrap();
        assert_eq!(details.gpu_index, Some(1.0));
        assert_eq!(details.cloud_type, "SECURE");
        assert_eq!(
            serde_json::from_value::<Option<RunDetails>>(serde_json::Value::Null).unwrap(),
            None
        );
    }
}
