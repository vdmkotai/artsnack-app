//! `packages/backend/convex/runpodBackendStore.ts`: the managed RunPod pods,
//! with every field the backend manager shows. The status button reads the
//! same `current` query through the narrower [`super::runpod_backends::BackendRow`].

use serde::{Deserialize, Serialize};

use crate::{
    NoArgs, Query,
    api::runpod_backends::{BackendState, RunpodCurrentArgs},
};

/// Where a RunPod pod runs: RunPod's own datacenters or vetted third-party hosts.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum CloudType {
    #[serde(rename = "SECURE")]
    Secure,
    #[serde(rename = "COMMUNITY")]
    Community,
}

impl CloudType {
    pub fn label(self) -> &'static str {
        match self {
            Self::Secure => "Secure",
            Self::Community => "Community",
        }
    }

    pub fn other(self) -> Self {
        match self {
            Self::Secure => Self::Community,
            Self::Community => Self::Secure,
        }
    }
}

/// The RunPod template a pod boots: which CUDA its ComfyUI image carries.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum TemplateProfile {
    #[serde(rename = "cuda13.0")]
    Cuda13_0,
    #[serde(rename = "cuda12.8")]
    Cuda12_8,
}

impl TemplateProfile {
    /// The value as stored, e.g. `cuda13.0`.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Cuda13_0 => "cuda13.0",
            Self::Cuda12_8 => "cuda12.8",
        }
    }

    pub fn cuda_version(self) -> &'static str {
        match self {
            Self::Cuda13_0 => "13.0",
            Self::Cuda12_8 => "12.8",
        }
    }
}

/// A managed RunPod pod (a `runpodBackends` row). Progress bookkeeping
/// (`progressUpdatedAt`, `updatedAt`, `lifecycleRevision`) is left out so a
/// stamp alone does not count as a change.
#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunpodBackend {
    #[serde(rename = "_id")]
    pub id: String,
    pub active: bool,
    /// Absent until RunPod has answered the create call.
    pub pod_id: Option<String>,
    pub gpu_name: String,
    pub num_gpus: f64,
    pub cloud_type: CloudType,
    pub template_profile: TemplateProfile,
    pub container_disk_gb: f64,
    pub volume_disk_gb: f64,
    pub hourly_usd: f64,
    pub public_url: String,
    /// Video pods with several GPUs: every ComfyUI that answered at ready.
    pub instance_urls: Option<Vec<String>>,
    pub state: BackendState,
    pub stage: String,
    pub message: String,
    pub progress: f64,
    pub error: Option<String>,
}

/// The active pod for a purpose (image when absent), or null.
pub const CURRENT: Query<RunpodCurrentArgs, Option<RunpodBackend>> =
    Query::new("runpodBackendStore:current");

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct ByIdArgs {
    pub id: String,
}

/// One pod by id while it is active, or null — for a panel that manages that pod.
pub const BY_ID: Query<ByIdArgs, Option<RunpodBackend>> = Query::new("runpodBackendStore:byId");

/// Every active video pod, oldest first.
pub const VIDEO_PODS: Query<NoArgs, Vec<RunpodBackend>> =
    Query::new("runpodBackendStore:videoPods");
