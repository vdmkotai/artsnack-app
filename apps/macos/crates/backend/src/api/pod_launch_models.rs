//! `packages/backend/convex/podLaunchModels.ts`: the models a new pod may be
//! launched without, as the launch dialog lists them. The contract is
//! `packages/shared/pod-model-selection.ts`.

use serde::{Deserialize, Serialize};

use crate::{Action, api::pod_downloads::PodProfile};

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct ListArgs {
    pub profile: PodProfile,
}

/// One optional manifest line (`PodModelOption`).
#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct PodModelOption {
    /// `dir|filename`: what provision.sh dedupes and skips on.
    pub key: String,
    pub dir: String,
    pub filename: String,
    pub label: String,
    pub group: String,
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct PodModelGroup {
    pub title: String,
    pub models: Vec<PodModelOption>,
}

/// Read from the gist a new pod will run (falling back to its cached copy),
/// plus the profile's `podModels` rows. Fails when neither can be read.
pub const LIST: Action<ListArgs, Vec<PodModelGroup>> = Action::new("podLaunchModels:list");
