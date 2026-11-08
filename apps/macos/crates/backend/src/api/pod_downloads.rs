//! `packages/backend/convex/podDownloads.ts`: what a running pod is
//! downloading (custom checkpoints and LoRAs from the provisioning manifest)
//! and how much disk it has left.

use serde::{Deserialize, Serialize};

use crate::Action;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PodProfile {
    Image,
    Video,
}

impl PodProfile {
    pub fn label(self) -> &'static str {
        match self {
            Self::Image => "Image pod",
            Self::Video => "Video pod",
        }
    }
}

/// `PodDownloadJob`: the pod node's own JSON (snake_case).
#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct DownloadJob {
    pub filename: String,
    pub dir: String,
    /// "downloading", "done" or "error".
    pub status: String,
    pub bytes: f64,
    pub expected_bytes: Option<f64>,
    pub error: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct Disk {
    pub free_gb: f64,
    pub total_gb: f64,
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct DownloadsStatus {
    pub jobs: Vec<DownloadJob>,
    pub disk: Option<Disk>,
}

/// `podDownloads:status`'s arguments, narrowed to one pod for the video tab's
/// per-pod cards.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PodStatusArgs {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub profile: Option<PodProfile>,
    /// A `runpodBackends` id: that video pod's downloads, when several run.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub backend_id: Option<String>,
}

/// `podDownloads:status` for one pod.
pub const POD_STATUS: Action<PodStatusArgs, DownloadsStatus> = Action::new("podDownloads:status");
