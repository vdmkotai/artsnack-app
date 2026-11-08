//! Which self-hosted backend is up: `runpodBackendStore.ts`,
//! `vastBackendStore.ts` and `selfHostedSelection.ts`.

use serde::{Deserialize, Serialize};

use crate::{NoArgs, Query};

/// A managed pod's lifecycle (`state` on both backend tables).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum BackendState {
    Reserving,
    Loading,
    Provisioning,
    Ready,
    Stopped,
    Offline,
    Destroying,
    Destroyed,
    Error,
}

impl BackendState {
    /// Starting up: the status button fills with progress.
    pub fn is_booting(self) -> bool {
        matches!(self, Self::Reserving | Self::Loading | Self::Provisioning)
    }

    pub fn label(self) -> &'static str {
        match self {
            Self::Reserving => "reserving",
            Self::Loading => "loading",
            Self::Provisioning => "provisioning",
            Self::Ready => "ready",
            Self::Stopped => "stopped",
            Self::Offline => "offline",
            Self::Destroying => "destroying",
            Self::Destroyed => "destroyed",
            Self::Error => "error",
        }
    }
}

/// The fields of a backend row the status button shows. Progress bookkeeping
/// (`progressUpdatedAt`, leases) is left out so it does not count as a change.
#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackendRow {
    #[serde(rename = "_id")]
    pub id: String,
    pub state: BackendState,
    pub message: String,
    pub progress: f64,
    pub public_url: String,
    pub gpu_name: String,
    /// Present on RunPod rows only.
    pub template_profile: Option<String>,
}

impl BackendRow {
    pub fn provider_label(&self) -> &'static str {
        if self.template_profile.is_some() {
            "RunPod"
        } else {
            "Vast.ai"
        }
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Purpose {
    #[default]
    Image,
    Video,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
pub struct RunpodCurrentArgs {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub purpose: Option<Purpose>,
}

/// The active RunPod pod for a purpose (image when absent), or null.
pub const RUNPOD_CURRENT: Query<RunpodCurrentArgs, Option<BackendRow>> =
    Query::new("runpodBackendStore:current");

/// The active Vast.ai instance, or null.
pub const VAST_CURRENT: Query<NoArgs, Option<BackendRow>> = Query::new("vastBackendStore:current");

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Provider {
    Vast,
    Runpod,
    Legacy,
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct Selection {
    pub provider: Provider,
}

/// Which provider new self-hosted generations use, or null (none chosen).
pub const SELECTION: Query<NoArgs, Option<Selection>> = Query::new("selfHostedSelection:current");
