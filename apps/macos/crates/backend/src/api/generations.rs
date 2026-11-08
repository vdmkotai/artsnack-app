//! `packages/backend/convex/generations.ts`: self-hosted image generations,
//! the rows behind Gallery and History.

use serde::{Deserialize, Serialize};

use super::progress::ProgressFields;
use crate::{Mutation, NoArgs, PaginatedQuery, Row};

/// One enabled-or-not LoRA in a self-hosted form (`loraSlotValidator`).
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct LoraSlot {
    pub enabled: bool,
    pub lora_name: String,
    pub strength_model: f64,
    pub strength_clip: f64,
}

/// The self-hosted form a generation ran with (`formStateValidator`). Numbers
/// stay `f64`, as Convex stores them, so the form round-trips unchanged into
/// Reproduce and Enhance.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct FormState {
    pub prompt: String,
    pub negative_prompt: String,
    pub checkpoint: String,
    pub width: f64,
    pub height: f64,
    pub seed: f64,
    pub steps: f64,
    pub cfg: f64,
    pub sampler: String,
    pub scheduler: String,
    pub denoise: f64,
    pub batch_size: f64,
    pub loras: Vec<LoraSlot>,
}

impl FormState {
    /// The form as the JSON object the web app stores and hands to Generate.
    pub fn to_value(&self) -> serde_json::Value {
        serde_json::to_value(self).unwrap_or_default()
    }

    /// Width ÷ height of the output; square when either is missing (the web's
    /// `(Number(width) || 1) / (Number(height) || 1)`).
    pub fn aspect(&self) -> f32 {
        let side = |value: f64| {
            if value.is_finite() && value > 0.0 {
                value
            } else {
                1.0
            }
        };
        (side(self.width) / side(self.height)) as f32
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum GenerationStatus {
    Pending,
    Processing,
    Completed,
    Failed,
    /// A status this build does not know; shown like a finished row.
    #[serde(other)]
    Other,
}

/// One row of `generations:listPaginated`. Rows written by the old `save`
/// path carry no status at all and are finished.
///
/// Left out on purpose: `progressUpdatedAt`, `providerStatus`, `promptId`,
/// `comfyClientId` and the other bookkeeping fields, so writes that touch only
/// them do not count as a change (see [`crate::RowCache`]).
#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Generation {
    #[serde(rename = "_id")]
    pub id: String,
    /// Insert time, milliseconds since the epoch.
    pub timestamp: f64,
    pub form_state: FormState,
    /// Output objects. Empty while running, after a failure, and on old rows
    /// whose images were never moved to B2.
    #[serde(default)]
    pub b2_keys: Vec<String>,
    pub status: Option<GenerationStatus>,
    pub error: Option<String>,
    pub progress_stage: Option<String>,
    pub progress_message: Option<String>,
    pub progress_current: Option<f64>,
    pub progress_total: Option<f64>,
    pub queue_position: Option<f64>,
}

impl Row for Generation {
    fn row_id(&self) -> &str {
        &self.id
    }
}

/// Newest first; one page per subscription. Takes no arguments besides
/// `paginationOpts`.
pub const LIST_PAGINATED: PaginatedQuery<NoArgs, Generation> =
    PaginatedQuery::new("generations:listPaginated");

#[derive(Clone, Debug, Serialize)]
pub struct RemoveArgs {
    pub id: String,
}

/// Deletes a generation and every favourite of its images.
pub const REMOVE: Mutation<RemoveArgs, ()> = Mutation::new("generations:remove");

/// One image of a generation, for [`REMOVE_IMAGES`].
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageRef {
    pub generation_id: String,
    pub b2_key: String,
}

#[derive(Clone, Debug, Serialize)]
pub struct RemoveImagesArgs {
    pub images: Vec<ImageRef>,
}

/// Removes single images from their generations (a generation left with none
/// is deleted) and their favourites. Returns how many were removed.
pub const REMOVE_IMAGES: Mutation<RemoveImagesArgs, f64> =
    Mutation::new("generations:removeImages");

/// Deletes every failed generation of the user and their favourites. Returns
/// how many.
pub const REMOVE_ALL_FAILED: Mutation<NoArgs, f64> = Mutation::new("generations:removeAllFailed");

impl Generation {
    /// Queued or running: no output yet, but some may come.
    pub fn is_running(&self) -> bool {
        matches!(
            self.status,
            Some(GenerationStatus::Pending | GenerationStatus::Processing)
        )
    }

    pub fn is_failed(&self) -> bool {
        self.status == Some(GenerationStatus::Failed)
    }

    fn progress(&self) -> ProgressFields<'_> {
        ProgressFields {
            pending: self.status == Some(GenerationStatus::Pending),
            video: false,
            dispatched: false,
            stage: self.progress_stage.as_deref(),
            message: self.progress_message.as_deref(),
            current: self.progress_current,
            total: self.progress_total,
            queue_position: self.queue_position,
        }
    }

    /// 0–100 when the backend reports steps, else `None` (indeterminate).
    pub fn progress_percent(&self) -> Option<f32> {
        self.progress().percent()
    }

    /// What the job is doing (see [`ProgressFields::label`]).
    pub fn progress_label(&self) -> String {
        self.progress().label()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decodes_a_row_and_ignores_bookkeeping() {
        let row: Generation = serde_json::from_value(serde_json::json!({
            "_id": "g1",
            "_creationTime": 1.0,
            "userId": "u",
            "timestamp": 1_700_000_000_000.0,
            "formState": {
                "prompt": "a cat", "negativePrompt": "", "checkpoint": "sdxl/a.safetensors",
                "width": 832.0, "height": 1216.0, "seed": 42.0, "steps": 30.0, "cfg": 6.5,
                "sampler": "euler", "scheduler": "normal", "denoise": 1.0, "batchSize": 2.0,
                "loras": [{"enabled": true, "loraName": "x.safetensors", "strengthModel": 0.8, "strengthClip": 1.0}]
            },
            "imageUrls": [],
            "b2Keys": ["a.png", "b.png"],
            "status": "completed",
            "progressUpdatedAt": 5.0
        }))
        .unwrap();
        assert_eq!(row.b2_keys, ["a.png", "b.png"]);
        assert_eq!(row.status, Some(GenerationStatus::Completed));
        assert!((row.form_state.aspect() - 832.0 / 1216.0).abs() < 1e-6);
        assert_eq!(row.form_state.to_value()["batchSize"], 2.0);

        let unknown: GenerationStatus = serde_json::from_value("archived".into()).unwrap();
        assert_eq!(unknown, GenerationStatus::Other);
    }

    #[test]
    fn removal_arguments_serialize_like_the_web() {
        let args = RemoveImagesArgs {
            images: vec![ImageRef {
                generation_id: "g1".into(),
                b2_key: "a.png".into(),
            }],
        };
        assert_eq!(
            serde_json::to_string(&args).unwrap(),
            r#"{"images":[{"generationId":"g1","b2Key":"a.png"}]}"#
        );
    }
}
