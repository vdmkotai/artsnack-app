//! `packages/backend/convex/runpodBackendActions.ts`: RunPod's live GPU
//! catalogue and credit, and renting, starting, stopping and destroying a pod.
//!
//! Every lifecycle action here spends or releases money. The server re-checks
//! price and stock at launch: it rejects a price more than 10% above the one
//! shown, or above the safety cap.

use serde::{Deserialize, Serialize};

use crate::{
    Action, NoArgs,
    api::{
        runpod_backend_store::{CloudType, TemplateProfile},
        runpod_backends::Purpose,
    },
};

#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GpuCountPrice {
    pub gpu_count: f64,
    pub hourly_usd: f64,
}

/// What one cloud sells of a GPU type (`RunpodCloudAvailability`). A cloud
/// that is not selling it right now has no price and `UNKNOWN` stock.
#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudAvailability {
    /// The starting price of one GPU.
    pub hourly_usd: Option<f64>,
    pub stock_status: String,
    pub available_gpu_counts: Vec<f64>,
    pub total_hourly_usd_by_gpu_count: Vec<GpuCountPrice>,
}

/// One GPU type in RunPod's catalogue (`RunpodGpuType`).
#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GpuType {
    pub id: String,
    pub display_name: String,
    pub memory_in_gb: f64,
    pub cuda_cores: f64,
    pub secure: CloudAvailability,
    pub community: CloudAvailability,
}

impl GpuType {
    pub fn availability(&self, cloud: CloudType) -> &CloudAvailability {
        match cloud {
            CloudType::Secure => &self.secure,
            CloudType::Community => &self.community,
        }
    }
}

/// Every GPU type, including ones no host is selling right now.
pub const GPU_TYPES: Action<NoArgs, Vec<GpuType>> = Action::new("runpodBackendActions:gpuTypes");

/// The account's credit in dollars, or null when RunPod does not say.
pub const ACCOUNT_BALANCE: Action<NoArgs, Option<f64>> =
    Action::new("runpodBackendActions:accountBalance");

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LaunchArgs {
    pub gpu_type_id: String,
    pub gpu_name: String,
    pub gpu_count: u32,
    pub cloud_type: CloudType,
    /// The server forces 13.0 for a video pod whatever is sent.
    pub template_profile: TemplateProfile,
    pub container_disk_gb: f64,
    pub volume_disk_gb: f64,
    #[serde(rename = "minDiskBandwidthMBps")]
    pub min_disk_bandwidth_mbps: f64,
    pub min_download_mbps: f64,
    /// The total price the user saw; a fresh one more than 10% higher is rejected.
    pub displayed_hourly_usd: f64,
    pub max_hourly_usd: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub purpose: Option<Purpose>,
    /// `dir|filename` of each model left unchecked; absent = the whole manifest.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub skip_models: Option<Vec<String>>,
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Launched {
    pub pod_id: String,
}

/// Rents a pod. Never retried: a second call is a second pod.
pub const LAUNCH: Action<LaunchArgs, Launched> = Action::new("runpodBackendActions:launch");

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct BackendIdArgs {
    pub id: String,
}

/// RunPod's own view of the pod after a refresh. `state` is the provider's
/// (`running`, `stopped`, …), not the row's; the row is updated server-side.
#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Refreshed {
    pub state: String,
    pub provider_status: String,
}

/// Re-reads the pod from RunPod and writes what changed to its row.
pub const REFRESH: Action<BackendIdArgs, Refreshed> = Action::new("runpodBackendActions:refresh");
pub const START: Action<BackendIdArgs, ()> = Action::new("runpodBackendActions:start");
pub const STOP: Action<BackendIdArgs, ()> = Action::new("runpodBackendActions:stop");
/// Deletes the pod and its disks; all billing stops.
pub const DESTROY: Action<BackendIdArgs, ()> = Action::new("runpodBackendActions:destroy");
