//! `packages/backend/convex/podSubmit.ts`: start a self-hosted image job.

use serde::{Deserialize, Serialize};

use crate::Action;

/// The form is the one every generation row stores, so Reproduce restores it.
pub use super::generations::{FormState, LoraSlot};

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GenerateArgs {
    pub form_state: FormState,
    /// Always `"comfyui"` today; the internal key of the self-hosted backend.
    pub backend: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Started {
    pub generation_id: String,
    pub prompt_id: String,
}

/// Builds the ComfyUI graph server-side, queues it on the pod, inserts the
/// pending row. The client never talks to the pod.
pub const GENERATE: Action<GenerateArgs, Started> = Action::new("podSubmit:generate");
