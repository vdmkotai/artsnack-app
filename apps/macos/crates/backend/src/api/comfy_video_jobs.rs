//! `packages/backend/convex/comfyVideo.ts`, the write side: queueing MiniMax H3
//! and LTX 2.3 clips on the video pods.
//!
//! The settings mirror `h3Validators.ts`. Their bounds, defaults and
//! normalisation are the shared TypeScript's (`h3-video.ts`, `ltx-video.ts`),
//! which the form runs through `artsnack-rules`; the server normalises again
//! and refuses a checkpoint or LoRA name normalisation would change.

use serde::{Deserialize, Serialize};

use crate::Mutation;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum H3Mode {
    #[default]
    Text,
    /// A first frame, a last frame, or both.
    Frames,
    /// Up to nine references, tagged `@imageN` in the prompt.
    Reference,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum LtxMode {
    #[default]
    Text,
    Frames,
    /// One character or product sheet (the Ingredients IC-LoRA).
    Sheet,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub enum SparseAttention {
    #[default]
    #[serde(rename = "off")]
    Off,
    /// Training-free; `sparseValue` is its tau.
    #[serde(rename = "sol-attn")]
    Sol,
    /// FastH3-trained weights only; `sparseValue` is the keep percent.
    #[serde(rename = "vsa")]
    Vsa,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ReferenceSize {
    #[default]
    Match,
    Max,
}

/// One LoRA of a clip: H3 and LTX both load them model-only, one strength each.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct VideoLora {
    pub name: String,
    pub strength: f64,
}

/// `h3SettingsValidator`: every setting of an H3 clip.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct H3Settings {
    pub mode: H3Mode,
    pub prompt: String,
    /// A file in the pod's `models/diffusion_models`.
    pub checkpoint: String,
    pub loras: Vec<VideoLora>,
    pub turbo: bool,
    pub width: f64,
    pub height: f64,
    pub duration_seconds: f64,
    pub steps: f64,
    pub sampler: String,
    pub scheduler: String,
    pub shift_enabled: bool,
    pub shift_video: f64,
    pub shift_audio: f64,
    pub fast_attention: bool,
    pub sparse_attention: SparseAttention,
    pub sparse_value: f64,
    pub easy_cache: bool,
    pub easy_cache_threshold: f64,
    /// -1 = random; the server resolves it and stores the one it used.
    pub seed: f64,
    pub audio: bool,
    pub reference_size: ReferenceSize,
    // Optional in the validator: rows written before the add-ons existed.
    #[serde(default)]
    pub interpolate: bool,
    #[serde(default)]
    pub upscale: bool,
}

/// `ltxSettingsValidator`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LtxSettings {
    pub mode: LtxMode,
    pub prompt: String,
    /// Only read when `cfg` is above 1.
    pub negative_prompt: String,
    pub checkpoint: String,
    pub loras: Vec<VideoLora>,
    pub width: f64,
    pub height: f64,
    pub duration_seconds: f64,
    /// 24 or 30.
    pub fps: f64,
    pub steps: f64,
    pub image_strength: f64,
    pub image_compression: f64,
    pub two_pass: bool,
    pub cfg: f64,
    pub seed: f64,
    pub audio: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sheet_strength: Option<f64>,
}

/// What an uploaded input image is to the clip (`h3InputRoleValidator`).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum InputRole {
    First,
    Last,
    Reference,
}

/// An input image already in Convex storage.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VideoInput {
    pub storage_id: String,
    pub role: InputRole,
    /// The output key the image was picked from, for Reproduce; else null.
    pub source_key: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StartArgs<Settings> {
    pub settings: Settings,
    pub inputs: Vec<VideoInput>,
    /// Clips for this click, 1–4; each gets its own seed.
    pub count: f64,
    /// A pod picked in the form; absent lets the server pick the least busy
    /// ready pod that has every model the clip needs.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub backend_id: Option<String>,
}

/// Queues `count` H3 clips; returns the first row's id.
pub const START: Mutation<StartArgs<H3Settings>, String> = Mutation::new("comfyVideo:start");

/// Queues `count` LTX 2.3 clips on the same pods; returns the first row's id.
pub const START_LTX: Mutation<StartArgs<LtxSettings>, String> =
    Mutation::new("comfyVideo:startLtx");

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn spells_the_enums_as_the_validators_do() {
        assert_eq!(
            serde_json::to_value(SparseAttention::Sol).unwrap(),
            serde_json::json!("sol-attn")
        );
        assert_eq!(
            serde_json::to_value(InputRole::Reference).unwrap(),
            serde_json::json!("reference")
        );
        let settings: LtxSettings = serde_json::from_value(serde_json::json!({
            "mode": "sheet", "prompt": "p", "negativePrompt": "", "checkpoint": "c",
            "loras": [], "width": 768, "height": 1344, "durationSeconds": 5, "fps": 24,
            "steps": 8, "imageStrength": 0.7, "imageCompression": 33, "twoPass": true,
            "cfg": 1, "seed": -1, "audio": true
        }))
        .unwrap();
        assert_eq!(settings.mode, LtxMode::Sheet);
        assert!(
            serde_json::to_value(&settings)
                .unwrap()
                .get("sheetStrength")
                .is_none()
        );
    }
}
