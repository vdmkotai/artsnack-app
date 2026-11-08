//! The form half of `packages/shared/h3-video.ts` and `ltx-video.ts`, run
//! through the rules bridge: constants read once, functions called on a
//! change (a typed duration, a picked preset) and never while rendering. The
//! graph builders in the same files run in Convex only.

use std::collections::HashMap;

use anyhow::Context as _;
use artsnack_backend::api::comfy_video_jobs::{H3Mode, H3Settings, LtxSettings, VideoLora};
use artsnack_rules::Rules;
use gpui_kit::{App, SharedString};
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use serde_json::Value;

#[derive(Clone, Copy, Debug, PartialEq, Deserialize)]
pub(crate) struct Range {
    pub min: f64,
    pub max: f64,
}

/// `H3_LIMITS`.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct H3Limits {
    pub dimension: Range,
    pub duration_seconds: Range,
    pub steps: Range,
    pub shift: Range,
    pub lora_strength: Range,
    pub loras: usize,
    pub references: usize,
    pub sparse_tau: Range,
    pub sparse_keep_percent: Range,
    pub easy_cache_threshold: Range,
}

/// `LTX_LIMITS`.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LtxLimits {
    pub dimension: Range,
    pub duration_seconds: Range,
    pub steps: Range,
    pub image_compression: Range,
    pub cfg: Range,
    pub lora_strength: Range,
    pub loras: usize,
    pub sheet_strength: Range,
}

/// One of `H3_MODES`.
#[derive(Clone, Debug, Deserialize)]
pub(crate) struct ModeInfo {
    pub value: H3Mode,
    pub label: SharedString,
    pub hint: SharedString,
}

/// `H3_TURBO_STEPS`.
#[derive(Clone, Copy, Debug, Deserialize)]
pub(crate) struct TurboSteps {
    text: f64,
    frames: f64,
    reference: f64,
}

impl TurboSteps {
    pub fn get(&self, mode: H3Mode) -> f64 {
        match mode {
            H3Mode::Text => self.text,
            H3Mode::Frames => self.frames,
            H3Mode::Reference => self.reference,
        }
    }
}

#[derive(Clone, Debug, Deserialize)]
struct H3BaseFiles {
    fl2va: String,
    ref2va: String,
}

#[derive(Clone, Debug, Deserialize)]
struct LtxBaseFiles {
    checkpoint: String,
}

/// A community checkpoint the form knows by name (`LTX_KNOWN_CHECKPOINTS`).
#[derive(Clone, Debug, Deserialize)]
pub(crate) struct KnownCheckpoint {
    pub label: SharedString,
    pub note: SharedString,
}

/// `recommendedLtxSettings()`: what LTX's "Recommended settings" restores.
#[derive(Clone, Copy, Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LtxRecommended {
    pub steps: f64,
    pub image_strength: f64,
    pub image_compression: f64,
    pub two_pass: bool,
    pub cfg: f64,
}

#[derive(Deserialize)]
struct CompanionEntry {
    lora: VideoLora,
}

#[derive(Deserialize)]
struct Dimensions {
    width: f64,
    height: f64,
}

/// Everything constant the form reads, loaded once when the tab is built.
pub(crate) struct VideoRules {
    /// The official int8 builds: text/image → video and reference → video.
    pub h3_fl2va: String,
    pub h3_ref2va: String,
    pub h3_modes: Vec<ModeInfo>,
    pub h3_samplers: Vec<SharedString>,
    pub h3_schedulers: Vec<SharedString>,
    /// `H3_ASPECTS`, which LTX's size presets use too.
    pub aspects: Vec<SharedString>,
    pub h3_short_edges: Vec<f64>,
    pub h3_limits: H3Limits,
    pub h3_turbo_steps: TurboSteps,
    pub h3_full_steps: f64,
    pub h3_defaults: H3Settings,
    pub ltx_checkpoint: String,
    pub ltx_known: HashMap<String, KnownCheckpoint>,
    pub ltx_fps: Vec<f64>,
    pub ltx_limits: LtxLimits,
    pub ltx_defaults: LtxSettings,
    pub ltx_short_edges: Vec<f64>,
    pub ltx_recommended: LtxRecommended,
    /// Every checkpoint's companion LoRA, by name — swapped when the checkpoint is.
    pub ltx_companions: Vec<String>,
}

impl VideoRules {
    /// Reads the constants. A failure is a build bug (the bundle is embedded).
    pub fn load(cx: &App) -> anyhow::Result<Self> {
        let rules = Rules::global(cx).context("the shared TypeScript is not loaded")?;
        let h3_base: H3BaseFiles = rules.get("h3Video.H3_BASE_FILES")?;
        let ltx_base: LtxBaseFiles = rules.get("ltxVideo.LTX_BASE_FILES")?;
        let companions: Vec<CompanionEntry> = rules.get("ltxVideo.LTX_COMPANION_LORAS")?;
        let names = |path: &str| -> anyhow::Result<Vec<SharedString>> {
            Ok(rules
                .get::<Vec<String>>(path)?
                .into_iter()
                .map(SharedString::from)
                .collect())
        };
        Ok(Self {
            h3_fl2va: h3_base.fl2va,
            h3_ref2va: h3_base.ref2va,
            h3_modes: rules.get("h3Video.H3_MODES")?,
            h3_samplers: names("h3Video.H3_SAMPLERS")?,
            h3_schedulers: names("h3Video.H3_SCHEDULERS")?,
            aspects: names("h3Video.H3_ASPECTS")?,
            h3_short_edges: rules.get("h3Video.H3_SHORT_EDGES")?,
            h3_limits: rules.get("h3Video.H3_LIMITS")?,
            h3_turbo_steps: rules.get("h3Video.H3_TURBO_STEPS")?,
            h3_full_steps: rules.get("h3Video.H3_FULL_STEPS")?,
            h3_defaults: rules.get("h3Video.DEFAULT_H3_SETTINGS")?,
            ltx_checkpoint: ltx_base.checkpoint,
            ltx_known: rules.get("ltxVideo.LTX_KNOWN_CHECKPOINTS")?,
            ltx_fps: rules.get("ltxVideo.LTX_FPS_OPTIONS")?,
            ltx_limits: rules.get("ltxVideo.LTX_LIMITS")?,
            ltx_defaults: rules.get("ltxVideo.DEFAULT_LTX_SETTINGS")?,
            ltx_short_edges: rules.get("ltxVideo.LTX_SHORT_EDGES")?,
            ltx_recommended: rules.call("ltxVideo.recommendedLtxSettings", &Vec::<Value>::new())?,
            ltx_companions: companions
                .into_iter()
                .map(|entry| entry.lora.name)
                .collect(),
        })
    }

    /// `defaultCheckpointFor`: the official build for a mode.
    pub fn default_h3_checkpoint(&self, mode: H3Mode) -> &str {
        match mode {
            H3Mode::Reference => &self.h3_ref2va,
            _ => &self.h3_fl2va,
        }
    }
}

// --- Calls --------------------------------------------------------------------

fn call<A: Serialize, T: DeserializeOwned>(cx: &App, path: &str, args: &A) -> Option<T> {
    let result = Rules::global(cx)
        .context("the shared TypeScript is not loaded")
        .and_then(|rules| rules.call(path, args));
    match result {
        Ok(value) => Some(value),
        Err(error) => {
            tracing::warn!(?error, path, "a video form rule failed");
            None
        }
    }
}

/// `h3FrameCount`: frames on H3's 17k+5 grid at 24 fps.
pub(crate) fn h3_frame_count(cx: &App, seconds: f64) -> Option<u32> {
    call::<_, f64>(cx, "h3Video.h3FrameCount", &(seconds,)).map(|frames| frames as u32)
}

/// `ltxFrameCount`: LTX's 8k+1 frames.
pub(crate) fn ltx_frame_count(cx: &App, seconds: f64, fps: f64) -> Option<u32> {
    call::<_, f64>(cx, "ltxVideo.ltxFrameCount", &(seconds, fps)).map(|frames| frames as u32)
}

/// `h3Dimensions`: a short edge at an aspect, snapped to 32 and capped at 1344.
pub(crate) fn h3_dimensions(cx: &App, short_edge: f64, aspect: &str) -> Option<(f64, f64)> {
    call::<_, Dimensions>(cx, "h3Video.h3Dimensions", &(short_edge, aspect))
        .map(|size| (size.width, size.height))
}

/// `ltxDimensions`: snapped to 64 so the half-size first pass lands on 32.
pub(crate) fn ltx_dimensions(cx: &App, short_edge: f64, aspect: &str) -> Option<(f64, f64)> {
    call::<_, Dimensions>(cx, "ltxVideo.ltxDimensions", &(short_edge, aspect))
        .map(|size| (size.width, size.height))
}

/// `normalizeH3Settings` over anything (a stored form, a row's settings).
pub(crate) fn normalize_h3(cx: &App, raw: &Value) -> Option<H3Settings> {
    call(cx, "h3Video.normalizeH3Settings", &(raw,))
}

pub(crate) fn normalize_ltx(cx: &App, raw: &Value) -> Option<LtxSettings> {
    call(cx, "ltxVideo.normalizeLtxSettings", &(raw,))
}

/// `h3ReferenceTagProblem`: an `@imageN` past the attached references.
pub(crate) fn h3_tag_problem(cx: &App, prompt: &str, references: usize) -> Option<String> {
    call::<_, Option<String>>(cx, "h3Video.h3ReferenceTagProblem", &(prompt, references)).flatten()
}

/// `ltxCompanionLora`: the LoRA a checkpoint is built to run with.
pub(crate) fn ltx_companion(cx: &App, checkpoint: &str) -> Option<VideoLora> {
    call::<_, Option<VideoLora>>(cx, "ltxVideo.ltxCompanionLora", &(checkpoint,)).flatten()
}
