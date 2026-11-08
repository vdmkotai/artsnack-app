//! The self-hosted image form: defaults, persistence, and restoring a saved
//! form (Reproduce).
//!
//! The shape is `FormState`, the same object the server stores on every
//! generation and favourite, so a reproduced form round-trips exactly.

use artsnack_backend::api::pod_submit::{FormState, LoraSlot};
use artsnack_settings::Preference;
use serde_json::Value;

/// The web keeps ten LoRA slots, enabled or not; disabled ones remember their
/// last LoRA so switching a slot back on restores it.
pub const LORA_SLOTS: usize = 10;
pub const BATCH_SIZES: [u32; 5] = [1, 2, 4, 8, 12];
/// A random seed is drawn from 0 … 1e9, as on the web.
pub const MAX_RANDOM_SEED: u64 = 1_000_000_000;

pub const SAVED_FORM: Preference<FormState> =
    Preference::new("generate.selfHosted.form", default_form);
/// Enhance's Img2Img fields, kept apart from the Generate form as on the web.
pub const SAVED_IMG2IMG_FORM: Preference<FormState> =
    Preference::new("enhance.img2img.form", default_img2img_form);

pub fn default_form() -> FormState {
    FormState {
        prompt: String::new(),
        negative_prompt: String::new(),
        checkpoint: String::new(),
        width: 1024.0,
        height: 1024.0,
        seed: -1.0,
        steps: 20.0,
        cfg: 7.0,
        sampler: String::new(),
        scheduler: String::new(),
        denoise: 1.0,
        batch_size: 1.0,
        loras: Vec::new(),
    }
}

pub fn default_img2img_form() -> FormState {
    FormState {
        denoise: 0.6,
        ..default_form()
    }
}

/// The ten slots, padded from the form's saved ones.
pub fn lora_slots(form: &FormState) -> Vec<LoraSlot> {
    let mut slots = form.loras.clone();
    slots.truncate(LORA_SLOTS);
    while slots.len() < LORA_SLOTS {
        slots.push(LoraSlot {
            enabled: false,
            lora_name: String::new(),
            strength_model: 1.0,
            strength_clip: 1.0,
        });
    }
    slots
}

/// What is sent: only enabled slots with a LoRA chosen.
pub fn submitted(form: &FormState) -> FormState {
    FormState {
        loras: form
            .loras
            .iter()
            .filter(|slot| slot.enabled && !slot.lora_name.is_empty())
            .cloned()
            .collect(),
        ..form.clone()
    }
}

/// Merges a saved form (from History, Gallery, Favorites) over the current one.
/// Partial imports — an old row missing fields — keep what they do not
/// mention, like the web's `reproduce_state` merge.
pub fn merge_saved(current: &FormState, saved: &Value) -> FormState {
    let mut merged = serde_json::to_value(current).unwrap_or(Value::Null);
    if let (Value::Object(target), Value::Object(source)) = (&mut merged, saved) {
        for (key, value) in source {
            if !value.is_null() {
                target.insert(key.clone(), value.clone());
            }
        }
    }
    serde_json::from_value(merged).unwrap_or_else(|_| current.clone())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn pads_and_filters_lora_slots() {
        let mut form = default_form();
        form.loras = vec![
            LoraSlot {
                enabled: true,
                lora_name: "a.safetensors".into(),
                strength_model: 0.8,
                strength_clip: 1.0,
            },
            LoraSlot {
                enabled: false,
                lora_name: "b.safetensors".into(),
                strength_model: 1.0,
                strength_clip: 1.0,
            },
        ];
        assert_eq!(lora_slots(&form).len(), LORA_SLOTS);
        assert_eq!(submitted(&form).loras.len(), 1);
    }

    #[test]
    fn merging_a_partial_form_keeps_the_rest() {
        let mut current = default_form();
        current.checkpoint = "keep.safetensors".into();
        let merged = merge_saved(&current, &json!({ "prompt": "a cat", "steps": 30 }));
        assert_eq!(merged.prompt, "a cat");
        assert_eq!(merged.steps, 30.0);
        assert_eq!(merged.checkpoint, "keep.safetensors");
    }

    #[test]
    fn a_malformed_saved_form_changes_nothing() {
        let current = default_form();
        assert_eq!(merge_saved(&current, &json!({ "steps": "many" })), current);
    }
}
