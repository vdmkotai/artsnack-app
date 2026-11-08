//! `packages/backend/convex/podCatalog.ts`: what the image pod can run.

use serde::Deserialize;

use crate::{Action, NoArgs};

/// Everything the self-hosted composer needs, in one round trip (`PodCatalog`).
#[derive(Clone, Debug, Default, PartialEq, Deserialize)]
pub struct PodCatalog {
    pub checkpoints: Vec<String>,
    pub loras: Vec<String>,
    pub unets: Vec<String>,
    pub samplers: Vec<String>,
    pub schedulers: Vec<String>,
    /// Set when the pod could not be read, or has no checkpoints yet.
    pub error: Option<String>,
}

pub const CATALOG: Action<NoArgs, PodCatalog> = Action::new("podCatalog:catalog");

#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct Health {
    pub online: bool,
    pub detail: Option<String>,
}

/// Whether the image pod answers `/system_stats`.
pub const HEALTH: Action<NoArgs, Health> = Action::new("podCatalog:health");

// --- The video pods (MiniMax H3 and LTX 2.3) --------------------------------

/// Which video pod to read; none merges every ready one (the form's "Auto").
#[derive(Clone, Debug, Default, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VideoCatalogArgs {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub backend_id: Option<String>,
}

/// The community add-ons a video pod has on disk.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Deserialize)]
pub struct VideoExtras {
    pub rife: bool,
    pub upscaler: bool,
}

/// The LTX 2.3 side of a video pod.
#[derive(Clone, Debug, Default, PartialEq, Deserialize)]
pub struct LtxCatalog {
    /// Every LTX base file is on the pod (they follow the H3 set after boot).
    pub ready: bool,
    pub checkpoints: Vec<String>,
    pub loras: Vec<String>,
    /// The gated Ingredients IC-LoRA is there: Reference sheet mode can run.
    #[serde(default)]
    pub sheet: bool,
}

/// `VideoPodCatalog`: H3's lists at the top level, LTX's under `ltx`.
#[derive(Clone, Debug, Default, PartialEq, Deserialize)]
pub struct VideoPodCatalog {
    pub checkpoints: Vec<String>,
    pub loras: Vec<String>,
    #[serde(default)]
    pub samplers: Vec<String>,
    #[serde(default)]
    pub schedulers: Vec<String>,
    pub extras: Option<VideoExtras>,
    pub ltx: Option<LtxCatalog>,
    /// Set when no pod is running or none could be reached.
    pub error: Option<String>,
}

pub const VIDEO_CATALOG: Action<VideoCatalogArgs, VideoPodCatalog> =
    Action::new("podCatalog:videoCatalog");
