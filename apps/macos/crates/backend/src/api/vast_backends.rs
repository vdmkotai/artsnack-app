//! `packages/backend/convex/vastBackendStore.ts` and `vastBackendActions.ts`:
//! the managed Vast.ai instance, the offer search, and renting, starting,
//! stopping and destroying an instance.
//!
//! At launch the server looks the offer up again and rejects it when the price
//! rose more than 10% over the one shown, or exceeds the safety cap.

use serde::{Deserialize, Serialize};

use crate::{Action, NoArgs, Query, api::runpod_backends::BackendState};

/// The managed Vast.ai instance (a `vastBackends` row), without its progress
/// bookkeeping.
#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VastBackend {
    #[serde(rename = "_id")]
    pub id: String,
    pub active: bool,
    /// Absent until Vast has answered, or while a launch is uncertain.
    pub instance_id: Option<f64>,
    pub gpu_name: String,
    pub num_gpus: f64,
    pub disk_gb: f64,
    pub disk_bandwidth_mbps: f64,
    pub disk_name: String,
    pub location: String,
    pub reliability: f64,
    pub hourly_usd: f64,
    /// What a stopped instance keeps costing for its disk.
    pub storage_hourly_usd: f64,
    pub public_url: String,
    pub state: BackendState,
    pub stage: String,
    pub message: String,
    pub progress: f64,
    pub error: Option<String>,
}

impl VastBackend {
    /// The create call's outcome is unknown, so the global launch lock is held
    /// until someone checks Vast for the instance.
    pub fn is_launch_uncertain(&self) -> bool {
        self.instance_id.is_none() && self.stage == "launch_uncertain"
    }
}

/// The active instance, or null.
pub const CURRENT: Query<NoArgs, Option<VastBackend>> = Query::new("vastBackendStore:current");

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum OfferSort {
    #[default]
    Price,
    Value,
    Disk,
    Download,
}

impl OfferSort {
    pub const ALL: [OfferSort; 4] = [Self::Price, Self::Value, Self::Disk, Self::Download];

    pub fn label(self) -> &'static str {
        match self {
            Self::Price => "Price",
            Self::Value => "Value",
            Self::Disk => "Disk",
            Self::Download => "Download",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OffersArgs {
    /// Absent = any GPU.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub gpu_name: Option<String>,
    pub num_gpus: u32,
    pub disk_gb: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub min_disk_bandwidth: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub min_download_mbps: Option<f64>,
    /// A fraction: 0.98 for 98%.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub min_reliability: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_hourly_usd: Option<f64>,
    pub sort: OfferSort,
}

/// One on-demand offer (`VastOffer`). `hourly_usd` includes the searched disk.
#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Offer {
    pub id: f64,
    pub gpu_name: String,
    pub num_gpus: f64,
    pub gpu_ram_mb: f64,
    pub cuda_max: f64,
    pub compatible: bool,
    pub incompatibility_reason: Option<String>,
    pub hourly_usd: f64,
    pub storage_hourly_usd: f64,
    pub disk_bandwidth_mbps: f64,
    pub disk_name: String,
    pub disk_space_gb: f64,
    pub download_mbps: f64,
    pub upload_mbps: f64,
    pub download_cost_per_tb_usd: f64,
    pub upload_cost_per_tb_usd: f64,
    /// A fraction: 0.995 for 99.5%.
    pub reliability: f64,
    pub location: String,
    pub dlperf: f64,
    pub dlperf_per_dollar: f64,
}

pub const OFFERS: Action<OffersArgs, Vec<Offer>> = Action::new("vastBackendActions:offers");

/// The bare GPU names, for when the richer catalogue is unavailable.
pub const GPU_NAMES: Action<NoArgs, Vec<String>> = Action::new("vastBackendActions:gpuNames");

/// A GPU model in Vast's catalogue (`VastGpuType`); zeros when unknown.
#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GpuType {
    pub name: String,
    pub gpu_ram_mb: f64,
    pub compute_capability: f64,
    pub cuda_cores: f64,
    pub max_power_watts: Option<f64>,
    pub architecture: String,
    pub category: String,
}

impl GpuType {
    /// A type known only by name.
    pub fn named(name: String) -> Self {
        Self {
            name,
            gpu_ram_mb: 0.0,
            compute_capability: 0.0,
            cuda_cores: 0.0,
            max_power_watts: None,
            architecture: String::new(),
            category: String::new(),
        }
    }
}

pub const GPU_TYPES: Action<NoArgs, Vec<GpuType>> = Action::new("vastBackendActions:gpuTypes");

/// The account's credit in dollars, or null when Vast does not say.
pub const ACCOUNT_CREDIT: Action<NoArgs, Option<f64>> =
    Action::new("vastBackendActions:accountCredit");

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LaunchArgs {
    pub offer_id: f64,
    pub disk_gb: f64,
    /// The price the user saw; a fresh one more than 10% higher is rejected.
    pub displayed_hourly_usd: f64,
    /// `dir|filename` of each model left unchecked; absent = the whole manifest.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub skip_models: Option<Vec<String>>,
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Launched {
    pub instance_id: f64,
}

/// Rents the offer. Never retried: a second call is a second instance.
pub const LAUNCH: Action<LaunchArgs, Launched> = Action::new("vastBackendActions:launch");

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct BackendIdArgs {
    pub id: String,
}

/// Re-reads the instance from Vast and writes what changed to its row.
pub const REFRESH: Action<BackendIdArgs, ()> = Action::new("vastBackendActions:refresh");
pub const START: Action<BackendIdArgs, ()> = Action::new("vastBackendActions:start");
pub const STOP: Action<BackendIdArgs, ()> = Action::new("vastBackendActions:stop");
/// Deletes the instance and its disk; all billing stops.
pub const DESTROY: Action<BackendIdArgs, ()> = Action::new("vastBackendActions:destroy");

#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClearedLaunch {
    /// Vast had the instance after all; the row now owns it again.
    pub found_instance: bool,
}

/// Looks for an uncertain launch's instance on Vast and releases the lock.
pub const CLEAR_UNCERTAIN_LAUNCH: Action<BackendIdArgs, ClearedLaunch> =
    Action::new("vastBackendActions:clearUncertainLaunch");
