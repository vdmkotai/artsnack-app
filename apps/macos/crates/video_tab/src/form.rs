//! The tab's two forms, how they persist, and the small client rules the web
//! keeps inside its components rather than in `packages/shared` — what
//! "recommended" means, the advice under each control, how a mode change
//! carries the checkpoint along, and why a form cannot run yet. Each is ported
//! from the component named in its doc comment; change both together.

use artsnack_backend::api::{
    comfy_video_jobs::{H3Mode, H3Settings, LtxMode, LtxSettings, SparseAttention, VideoLora},
    pod_catalog::LtxCatalog,
};
use artsnack_settings::{Preference, Preferences};
use gpui_kit::{App, SharedString};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::rules::{self, VideoRules};

/// Which family the tab shows (`artsnack-video-family` on the web). Read when
/// the tab is built, so a hand-off that builds it configures the right one.
pub(crate) const FAMILY: Preference<Family> = Preference::new("video.family", || Family::H3);
/// The H3 form plus `revision` (`artsnack-h3-video-form`).
const H3_FORM: Preference<Option<Value>> = Preference::new("video.h3Form", || None);
/// The LTX form (`artsnack-ltx-video-form`).
const LTX_FORM: Preference<Option<Value>> = Preference::new("video.ltxForm", || None);

/// Bumped when the recommended settings change: a form saved under an older
/// revision keeps its prompt, size and models but takes the new settings
/// (`FORM_REVISION` in video-panel.tsx).
const H3_FORM_REVISION: f64 = 2.0;
/// The size preset of a form whose width and height were typed by hand.
pub(crate) const CUSTOM: &str = "custom";
/// Clips per click (`COMFY_MAX_COUNT` in comfyVideo.ts).
pub(crate) const MAX_CLIPS: u32 = 4;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum Family {
    #[default]
    H3,
    Ltx,
}

/// Every H3 setting plus the size preset it was picked from.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct H3Form {
    pub settings: H3Settings,
    /// An `H3_ASPECTS` entry, or [`CUSTOM`].
    pub aspect: SharedString,
    pub short_edge: f64,
    pub count: u32,
}

/// Every LTX setting plus the size preset it was picked from.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct LtxForm {
    pub settings: LtxSettings,
    pub aspect: SharedString,
    pub short_edge: f64,
    pub count: u32,
}

impl H3Form {
    pub fn new(rules: &VideoRules) -> Self {
        Self {
            settings: rules.h3_defaults.clone(),
            aspect: "16:9".into(),
            short_edge: 768.0,
            count: 1,
        }
    }

    /// The saved form, normalised; an older revision takes the new
    /// recommended settings (`loadForm`).
    pub fn load(cx: &App, rules: &VideoRules) -> Self {
        let fallback = Self::new(rules);
        let Some(stored) = Preferences::get(cx, &H3_FORM).filter(Value::is_object) else {
            return fallback;
        };
        let mut raw = serde_json::to_value(&rules.h3_defaults).unwrap_or_default();
        merge(&mut raw, &stored);
        let Some(mut settings) = rules::normalize_h3(cx, &raw) else {
            return fallback;
        };
        if stored.get("revision").and_then(Value::as_f64) != Some(H3_FORM_REVISION) {
            apply_h3_recommended(&mut settings, rules);
        }
        Self {
            settings,
            aspect: stored_aspect(&stored).unwrap_or(fallback.aspect),
            short_edge: stored_short_edge(&stored).unwrap_or(fallback.short_edge),
            count: stored_count(&stored),
        }
    }

    pub fn save(&self, cx: &mut App) {
        let mut json = serde_json::to_value(&self.settings).unwrap_or_default();
        if let Value::Object(map) = &mut json {
            map.insert("aspect".into(), self.aspect.to_string().into());
            map.insert("shortEdge".into(), self.short_edge.into());
            map.insert("count".into(), self.count.into());
            map.insert("revision".into(), H3_FORM_REVISION.into());
        }
        Preferences::set(cx, &H3_FORM, Some(json));
    }
}

impl LtxForm {
    pub fn new(rules: &VideoRules) -> Self {
        Self {
            settings: rules.ltx_defaults.clone(),
            aspect: "9:16".into(),
            short_edge: 768.0,
            count: 1,
        }
    }

    /// The saved form, normalised (`loadLtxForm`).
    pub fn load(cx: &App, rules: &VideoRules) -> Self {
        let fallback = Self::new(rules);
        let Some(stored) = Preferences::get(cx, &LTX_FORM).filter(Value::is_object) else {
            return fallback;
        };
        let mut raw = serde_json::to_value(&rules.ltx_defaults).unwrap_or_default();
        merge(&mut raw, &stored);
        let Some(settings) = rules::normalize_ltx(cx, &raw) else {
            return fallback;
        };
        Self {
            settings,
            aspect: stored_aspect(&stored).unwrap_or(fallback.aspect),
            short_edge: stored_short_edge(&stored).unwrap_or(fallback.short_edge),
            count: stored_count(&stored),
        }
    }

    pub fn save(&self, cx: &mut App) {
        let mut json = serde_json::to_value(&self.settings).unwrap_or_default();
        if let Value::Object(map) = &mut json {
            map.insert("aspect".into(), self.aspect.to_string().into());
            map.insert("shortEdge".into(), self.short_edge.into());
            map.insert("count".into(), self.count.into());
        }
        Preferences::set(cx, &LTX_FORM, Some(json));
    }
}

/// `{ ...defaults, ...stored }`.
fn merge(base: &mut Value, over: &Value) {
    if let (Value::Object(base), Value::Object(over)) = (base, over) {
        for (key, value) in over {
            base.insert(key.clone(), value.clone());
        }
    }
}

fn stored_aspect(stored: &Value) -> Option<SharedString> {
    stored
        .get("aspect")
        .and_then(Value::as_str)
        .map(|aspect| SharedString::from(aspect.to_string()))
}

fn stored_short_edge(stored: &Value) -> Option<f64> {
    stored
        .get("shortEdge")
        .and_then(Value::as_f64)
        .filter(|edge| edge.is_finite())
}

/// 1–4, 1 when absent.
fn stored_count(stored: &Value) -> u32 {
    let count = stored.get("count").and_then(Value::as_f64).unwrap_or(1.0);
    clamp_count(count)
}

pub(crate) fn clamp_count(count: f64) -> u32 {
    if count.is_finite() {
        count.round().clamp(1.0, MAX_CLIPS as f64) as u32
    } else {
        1
    }
}

// --- H3: recommended settings and advice (video-panel.tsx) --------------------

/// `recommendedFor(mode)`: what "Recommended settings" restores for the
/// official model. Measured 2026-10-12 on an RTX PRO 6000: Turbo plus fast
/// attention is the fastest setting with no visible loss; sparse attention
/// and EasyCache trade detail for speed, so they stay a choice.
pub(crate) fn apply_h3_recommended(settings: &mut H3Settings, rules: &VideoRules) {
    settings.turbo = true;
    settings.steps = rules.h3_turbo_steps.get(settings.mode);
    settings.sampler = rules.h3_defaults.sampler.clone();
    settings.scheduler = rules.h3_defaults.scheduler.clone();
    settings.shift_enabled = false;
    settings.fast_attention = true;
    settings.sparse_attention = SparseAttention::Off;
    settings.easy_cache = false;
}

/// Which settings carry the green "recommended" mark. A custom checkpoint has
/// its own recipe on its model page, so only the official model gets marks.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) struct H3Marks {
    pub turbo: bool,
    pub steps: bool,
    pub sampler: bool,
    pub scheduler: bool,
    pub shift: bool,
    pub fast_attention: bool,
    pub sparse: bool,
    pub easy_cache: bool,
    /// Everything is as recommended: the reset button has nothing to do.
    pub all: bool,
}

pub(crate) fn h3_marks(settings: &H3Settings, rules: &VideoRules) -> H3Marks {
    if is_custom_h3(&settings.checkpoint) {
        return H3Marks::default();
    }
    let mut recommended = settings.clone();
    apply_h3_recommended(&mut recommended, rules);
    let marks = H3Marks {
        turbo: settings.turbo == recommended.turbo,
        steps: settings.steps == recommended.steps,
        sampler: settings.sampler == recommended.sampler,
        scheduler: settings.scheduler == recommended.scheduler,
        shift: settings.shift_enabled == recommended.shift_enabled,
        fast_attention: settings.fast_attention == recommended.fast_attention,
        sparse: settings.sparse_attention == recommended.sparse_attention,
        easy_cache: settings.easy_cache == recommended.easy_cache,
        all: false,
    };
    H3Marks {
        all: marks.turbo
            && marks.steps
            && marks.sampler
            && marks.scheduler
            && marks.shift
            && marks.fast_attention
            && marks.sparse
            && marks.easy_cache,
        ..marks
    }
}

/// The official builds in either precision, `(reference, fp8)`: the same
/// recipe, so the marks apply to both.
fn official_h3(name: &str) -> Option<(bool, bool)> {
    let rest = name.strip_prefix("minimax_h3_")?;
    let (reference, rest) = if let Some(rest) = rest.strip_prefix("fl2va_pruned_") {
        (false, rest)
    } else {
        (true, rest.strip_prefix("ref2va_pruned_")?)
    };
    match rest {
        "int8_convrot.safetensors" => Some((reference, false)),
        "fp8_scaled.safetensors" => Some((reference, true)),
        _ => None,
    }
}

pub(crate) fn is_custom_h3(checkpoint: &str) -> bool {
    official_h3(checkpoint).is_none()
}

/// The line under a checkpoint in the picker.
pub(crate) fn h3_checkpoint_note(name: &str, rules: &VideoRules) -> &'static str {
    if name == rules.h3_fl2va {
        "Official H3 · text and image to video"
    } else if name == rules.h3_ref2va {
        "Official H3 · reference to video"
    } else if name.starts_with("minimax_h3_fl2va_pruned_fp8") {
        "Official H3 · fp8 · text/image to video — fastest on B300"
    } else if name.starts_with("minimax_h3_ref2va_pruned_fp8") {
        "Official H3 · fp8 · reference to video — fastest on B300"
    } else {
        "Custom checkpoint"
    }
}

/// `withMode`: switches the mode, moving an official checkpoint to the
/// mode's official file (int8 or fp8 kept) and resetting Turbo's steps. A
/// custom checkpoint is a deliberate choice and stays.
pub(crate) fn h3_with_mode(settings: &mut H3Settings, mode: H3Mode, rules: &VideoRules) {
    let checkpoint = &settings.checkpoint;
    let next = if *checkpoint == rules.h3_fl2va || *checkpoint == rules.h3_ref2va {
        Some(rules.default_h3_checkpoint(mode).to_string())
    } else if matches!(official_h3(checkpoint), Some((_, true))) {
        let variant = if mode == H3Mode::Reference {
            "ref2va"
        } else {
            "fl2va"
        };
        Some(format!(
            "minimax_h3_{variant}_pruned_fp8_scaled.safetensors"
        ))
    } else {
        None
    };
    if let Some(next) = next {
        settings.checkpoint = next;
    }
    settings.mode = mode;
    if settings.turbo {
        settings.steps = rules.h3_turbo_steps.get(mode);
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum AdviceKind {
    /// Will likely hurt the clip.
    Warn,
    /// Would make it faster or better.
    Tip,
}

/// A setting worth a second look, shown under its control.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct Advice {
    pub kind: AdviceKind,
    pub text: SharedString,
}

impl Advice {
    pub fn warn(text: impl Into<SharedString>) -> Self {
        Self {
            kind: AdviceKind::Warn,
            text: text.into(),
        }
    }

    pub fn tip(text: impl Into<SharedString>) -> Self {
        Self {
            kind: AdviceKind::Tip,
            text: text.into(),
        }
    }
}

/// The advice map of video-panel.tsx.
#[derive(Clone, Debug, Default)]
pub(crate) struct H3Advice {
    pub checkpoint: Option<Advice>,
    pub turbo: Option<Advice>,
    pub steps: Option<Advice>,
    pub shift: Option<Advice>,
    pub fast_attention: Option<Advice>,
    pub sparse: Option<Advice>,
    pub easy_cache: Option<Advice>,
}

/// `weak_int8`: a pod the clip may land on is a B300 (Blackwell Ultra),
/// which has almost no INT8 throughput — int8 checkpoints and the INT8
/// attention ran ~4× slower there than fp8 (measured 2026-10-12).
pub(crate) fn h3_advice(settings: &H3Settings, weak_int8: bool, rules: &VideoRules) -> H3Advice {
    let custom = is_custom_h3(&settings.checkpoint);
    let name = settings.checkpoint.to_lowercase();
    let looks_turbo_merge = custom
        && ["turbo", "distill", "lightning", "fast"]
            .iter()
            .any(|word| name.contains(word));
    let looks_vsa_trained = name.contains("fasth3") || name.contains("vsa");
    let turbo_steps = rules.h3_turbo_steps.get(settings.mode);
    H3Advice {
        checkpoint: (weak_int8 && name.contains("int8")).then(|| {
            Advice::warn(
                "int8 models run ~4× slower on B300 — pick the _fp8_scaled one (207 s → 54 s measured).",
            )
        }),
        turbo: (settings.turbo && looks_turbo_merge).then(|| {
            Advice::warn(
                "This checkpoint looks like a turbo merge already — Turbo on top over-sharpens. Switch it off.",
            )
        }),
        steps: if !settings.turbo && !looks_turbo_merge && settings.steps < 15.0 {
            Some(Advice::warn(format!(
                "Without Turbo the model needs 20–25 steps; {} will look unfinished.",
                plain(settings.steps)
            )))
        } else if settings.turbo && settings.steps > turbo_steps + 4.0 {
            Some(Advice::tip(format!(
                "Turbo is tuned for {} steps — more mostly costs time.",
                plain(turbo_steps)
            )))
        } else {
            None
        },
        shift: if settings.shift_enabled && !custom {
            Some(Advice::tip(
                "The official model already has its own schedule; shift is for checkpoints that ask for it.",
            ))
        } else if custom && !settings.shift_enabled {
            Some(Advice::tip(
                "Community checkpoints usually list a shift (often 10/3) on their model page.",
            ))
        } else {
            None
        },
        fast_attention: match (weak_int8, settings.fast_attention) {
            (true, true) => Some(Advice::warn(
                "Turn it off on B300: this INT8 attention runs ~2× slower there than the default one.",
            )),
            (false, false) => Some(Advice::tip("Turn it on: about 27% faster, no visible loss.")),
            _ => None,
        },
        sparse: if settings.sparse_attention == SparseAttention::Vsa && !looks_vsa_trained {
            Some(Advice::warn(
                "VSA only works with VSA-trained weights (FastH3). Use SOL for this checkpoint.",
            ))
        } else if settings.sparse_attention == SparseAttention::Off
            && settings.duration_seconds >= 10.0
        {
            Some(Advice::tip(
                "For clips of 10 s and more, SOL is 1.5–2× faster at a small cost in fine detail.",
            ))
        } else {
            None
        },
        easy_cache: settings.easy_cache.then(|| {
            Advice::tip("Fine for drafts; turn off for the final render if motion looks soft.")
        }),
    }
}

/// Why the H3 form cannot run, first problem first.
pub(crate) fn h3_problems(
    settings: &H3Settings,
    pod_ready: bool,
    inputs: &InputCounts,
    tag_problem: Option<&str>,
) -> Vec<SharedString> {
    let mut problems = Vec::new();
    if !pod_ready {
        problems.push("Start the video pod first".into());
    }
    if settings.prompt.trim().is_empty() {
        problems.push("Write a prompt".into());
    }
    if settings.mode == H3Mode::Frames && !inputs.first && !inputs.last {
        problems.push("Add a first or last frame".into());
    }
    if settings.mode == H3Mode::Reference {
        if inputs.references == 0 {
            problems.push("Add a reference image".into());
        }
        if let Some(problem) = tag_problem {
            problems.push(problem.to_string().into());
        }
    }
    problems
}

/// What is attached, as the problem lists read it.
#[derive(Clone, Copy, Debug, Default)]
pub(crate) struct InputCounts {
    pub first: bool,
    pub last: bool,
    pub references: usize,
}

// --- LTX (ltx-composer.tsx) -------------------------------------------------------

/// The two-part prompt the Ingredients LoRA was trained on (its model card).
const SHEET_PROMPT_TEMPLATE: &str = "Reference sheet: <who or what each panel shows — the character from several angles, their outfit, any props>\n\nGenerated video: <the scene — where they are, what happens second by second, camera, sound>";

/// What Enhance is told to write for a reference sheet.
pub(crate) const SHEET_ENHANCE_TARGET: &str = "LTX 2.3 with a reference-sheet IC-LoRA. Keep the prompt in exactly two parts: \"Reference sheet: …\" describing what the sheet shows, then \"Generated video: …\" describing the scene";

/// The prompt already has its "Reference sheet:" part.
pub(crate) fn has_sheet_part(prompt: &str) -> bool {
    prompt
        .trim_start()
        .to_lowercase()
        .starts_with("reference sheet:")
}

/// The template, with what was typed as its scene.
pub(crate) fn two_part_prompt(prompt: &str) -> String {
    let typed = prompt.trim();
    let scene = SHEET_PROMPT_TEMPLATE.find("<the scene").and_then(|start| {
        SHEET_PROMPT_TEMPLATE[start..]
            .find('>')
            .map(|end| (start, start + end + 1))
    });
    match scene {
        Some((start, end)) if !typed.is_empty() => format!(
            "{}{typed}{}",
            &SHEET_PROMPT_TEMPLATE[..start],
            &SHEET_PROMPT_TEMPLATE[end..]
        ),
        _ => SHEET_PROMPT_TEMPLATE.to_string(),
    }
}

/// Which LTX settings carry the "recommended" mark.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) struct LtxMarks {
    pub steps: bool,
    pub image_strength: bool,
    pub image_compression: bool,
    pub two_pass: bool,
    pub cfg: bool,
    pub all: bool,
}

pub(crate) fn ltx_marks(settings: &LtxSettings, rules: &VideoRules) -> LtxMarks {
    let recommended = rules.ltx_recommended;
    let marks = LtxMarks {
        steps: settings.steps == recommended.steps,
        image_strength: settings.image_strength == recommended.image_strength,
        image_compression: settings.image_compression == recommended.image_compression,
        two_pass: settings.two_pass == recommended.two_pass,
        cfg: settings.cfg == recommended.cfg,
        all: false,
    };
    LtxMarks {
        all: marks.steps
            && marks.image_strength
            && marks.image_compression
            && marks.two_pass
            && marks.cfg,
        ..marks
    }
}

pub(crate) fn apply_ltx_recommended(settings: &mut LtxSettings, rules: &VideoRules) {
    let recommended = rules.ltx_recommended;
    settings.steps = recommended.steps;
    settings.image_strength = recommended.image_strength;
    settings.image_compression = recommended.image_compression;
    settings.two_pass = recommended.two_pass;
    settings.cfg = recommended.cfg;
}

/// `checkpointAdvice`: what each model's author asks for.
pub(crate) fn ltx_checkpoint_advice(
    settings: &LtxSettings,
    companion: Option<&VideoLora>,
    available: &[String],
) -> Option<Advice> {
    if let Some(companion) = companion
        && !settings
            .loras
            .iter()
            .any(|lora| lora.name == companion.name)
    {
        let short = companion
            .name
            .strip_suffix(".safetensors")
            .unwrap_or(&companion.name);
        let strength = plain(companion.strength);
        return Some(Advice::warn(if available.contains(&companion.name) {
            format!(
                "This checkpoint is built to run with the LoRA \u{201c}{short}\u{201d} at {strength} — add it below (picking the checkpoint again adds it for you)."
            )
        } else {
            format!(
                "This checkpoint needs the LoRA \u{201c}{short}\u{201d} at {strength}, which is not on the pod yet."
            )
        }));
    }
    None
}

/// A picked checkpoint brings its companion LoRA along and drops the previous
/// checkpoint's, so the recommended pairing is one click. With every slot
/// taken the advice line says so rather than send a LoRA the server rejects.
pub(crate) fn ltx_loras_for(
    current: &[VideoLora],
    companion: Option<VideoLora>,
    rules: &VideoRules,
    available: &[String],
) -> Vec<VideoLora> {
    let keep = companion.as_ref().map(|lora| lora.name.as_str());
    let mut loras: Vec<VideoLora> = current
        .iter()
        .filter(|lora| {
            Some(lora.name.as_str()) == keep || !rules.ltx_companions.contains(&lora.name)
        })
        .cloned()
        .collect();
    if let Some(companion) = companion
        && available.contains(&companion.name)
        && !loras.iter().any(|lora| lora.name == companion.name)
        && loras.len() < rules.ltx_limits.loras
    {
        loras.insert(0, companion);
    }
    loras
}

/// `ltxProblems`: why the LTX form cannot run, first problem first.
pub(crate) fn ltx_problems(
    settings: &LtxSettings,
    pod_ready: bool,
    catalog: Option<&LtxCatalog>,
    inputs: &InputCounts,
    has_sheet: bool,
    rules: &VideoRules,
) -> Vec<SharedString> {
    let mut problems: Vec<SharedString> = Vec::new();
    if !pod_ready {
        problems.push("Start the video pod first".into());
    }
    if let Some(catalog) = catalog {
        if pod_ready && !catalog.ready {
            problems.push("LTX base models are still downloading to the pod".into());
        }
        if catalog.ready && !catalog.checkpoints.contains(&settings.checkpoint) {
            problems.push(if settings.checkpoint == rules.ltx_checkpoint {
                "The official LTX checkpoint is not on this pod — pick another one".into()
            } else {
                "That checkpoint is not on the pod".into()
            });
        }
    }
    if settings.prompt.trim().is_empty() {
        problems.push("Write a prompt".into());
    }
    if settings.mode == LtxMode::Frames && !inputs.first && !inputs.last {
        problems.push("Add a first or last frame".into());
    }
    if settings.mode == LtxMode::Sheet {
        if !has_sheet {
            problems.push("Add a reference sheet".into());
        }
        if catalog.is_some_and(|catalog| catalog.ready && !catalog.sheet) {
            problems.push("The Ingredients LoRA is not on this pod".into());
        }
    }
    problems
}

/// A number the way JavaScript prints it in these messages: `8`, `0.9`.
pub(crate) fn plain(value: f64) -> String {
    if value.fract() == 0.0 {
        format!("{}", value as i64)
    } else {
        let text = format!("{value:.2}");
        text.trim_end_matches('0').trim_end_matches('.').to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tells_official_builds_from_custom_ones() {
        assert_eq!(
            official_h3("minimax_h3_ref2va_pruned_fp8_scaled.safetensors"),
            Some((true, true))
        );
        assert_eq!(
            official_h3("minimax_h3_fl2va_pruned_int8_convrot.safetensors"),
            Some((false, false))
        );
        assert!(is_custom_h3("minimax_h3_fl2va_pruned_bf16.safetensors"));
        assert!(is_custom_h3("fastH3_turbo.safetensors"));
    }

    #[test]
    fn wraps_a_typed_scene_in_the_two_part_template() {
        let prompt = two_part_prompt("  she walks in  ");
        assert!(prompt.starts_with("Reference sheet: <who"));
        assert!(prompt.ends_with("Generated video: she walks in"));
        assert!(has_sheet_part(&prompt));
        assert_eq!(two_part_prompt(" "), SHEET_PROMPT_TEMPLATE);
    }

    #[test]
    fn prints_numbers_like_javascript() {
        assert_eq!(plain(8.0), "8");
        assert_eq!(plain(0.9), "0.9");
        assert_eq!(clamp_count(7.0), 4);
        assert_eq!(clamp_count(0.2), 1);
    }
}
