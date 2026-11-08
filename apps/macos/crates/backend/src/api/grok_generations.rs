//! `packages/backend/convex/grokGenerations.ts`: the API tab's jobs — Grok,
//! fal, Higgsfield and Atlas — and the self-hosted video clips (`provider:
//! "comfy"`), which share the table.

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use super::{generations::GenerationStatus, progress::ProgressFields};
use crate::{Mutation, NoArgs, PaginatedQuery, Query, Row};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MediaType {
    Image,
    Video,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ApiProvider {
    Grok,
    Fal,
    Higgsfield,
    Atlas,
    /// Self-hosted MiniMax H3 / LTX on the video pod.
    Comfy,
    #[serde(other)]
    Other,
}

/// One row of `grokGenerations:list`.
///
/// Left out on purpose: the poll lease (`atlasPollLeaseId/Until`,
/// `atlasWaitEndsAt`), `progressUpdatedAt`, `providerStatus` and the provider
/// request ids. A running job rewrites those about once a second; leaving them
/// out makes such writes no change at all (see [`crate::RowCache`]).
#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApiGeneration {
    #[serde(rename = "_id")]
    pub id: String,
    /// When Convex wrote the row, in milliseconds since the epoch.
    #[serde(rename = "_creationTime", default)]
    pub creation_time: f64,
    /// Milliseconds since the epoch.
    pub created_at: f64,
    pub prompt: String,
    pub media_type: MediaType,
    pub status: GenerationStatus,
    pub b2_key: Option<String>,
    pub b2_keys: Option<Vec<String>>,
    pub error: Option<String>,
    /// auth | billing | validation | moderation | rate_limit | server | timeout.
    pub error_kind: Option<String>,
    pub aspect_ratio: Option<String>,
    /// Outputs asked for (a batch); fewer may have come back.
    pub count: Option<f64>,
    pub quality: Option<String>,
    pub duration: Option<f64>,
    pub resolution: Option<String>,
    #[serde(default)]
    pub has_reference_image: bool,
    pub reference_b2_keys: Option<Vec<String>>,
    /// The output key each reference was made from, in slot order; `None` for
    /// an uploaded file.
    pub reference_source_keys: Option<Vec<Option<String>>>,
    pub reference_voices: Option<Vec<String>>,
    /// Absent on rows written before fal existed: Grok.
    pub provider: Option<ApiProvider>,
    /// Registry id (grok/fal/higgsfield) or the Atlas vendor slug.
    pub api_model: Option<String>,
    /// Every input of an Atlas job, by the vendor's parameter names.
    pub atlas_params: Option<Map<String, Value>>,
    /// Grok video: the model slug; absent ⇒ grok-imagine-video-1.5.
    pub grok_video_model: Option<String>,
    /// Grok video: "edit" | "extend"; absent ⇒ generate.
    pub grok_video_mode: Option<String>,
    /// Grok 1.5: each reference's role, `{ role, at? }`, in reference order.
    pub grok_frame_roles: Option<Value>,
    /// Grok Edit/Extend: the source clip's key and measured length.
    pub source_video_key: Option<String>,
    pub source_video_seconds: Option<f64>,
    /// Grok: the quota xAI reported for the finished job, in USD.
    pub metered_usd: Option<f64>,
    /// Self-hosted video: every setting, seed resolved.
    pub h3_settings: Option<Value>,
    pub ltx_settings: Option<Value>,
    pub h3_input_roles: Option<Vec<String>>,
    pub comfy_run: Option<Value>,
    pub endpoint: Option<String>,
    pub video_tier: Option<String>,
    pub video_job_type: Option<String>,
    pub video_mode: Option<String>,
    pub generate_audio: Option<bool>,
    pub bitrate_mode: Option<String>,
    pub batch_id: Option<String>,
    pub dispatched_at: Option<f64>,
    pub completed_at: Option<f64>,
    /// The vendor's job id; for Atlas its prediction id, which is also a
    /// Seedance 2.5 draft's `draft_id`.
    pub fal_request_id: Option<String>,
    pub cost_usd: Option<f64>,
    pub credits_used: Option<f64>,
    /// The cost is a pre-flight figure, not one measured from the output.
    pub cost_estimated: Option<bool>,
    pub progress_stage: Option<String>,
    pub progress_message: Option<String>,
    pub progress_current: Option<f64>,
    pub progress_total: Option<f64>,
    pub queue_position: Option<f64>,
}

impl Row for ApiGeneration {
    fn row_id(&self) -> &str {
        &self.id
    }
}

impl ApiGeneration {
    pub fn provider(&self) -> ApiProvider {
        self.provider.unwrap_or(ApiProvider::Grok)
    }

    pub fn is_video(&self) -> bool {
        self.media_type == MediaType::Video
    }

    pub fn is_running(&self) -> bool {
        matches!(
            self.status,
            GenerationStatus::Pending | GenerationStatus::Processing
        )
    }

    pub fn is_failed(&self) -> bool {
        self.status == GenerationStatus::Failed
    }

    /// The output objects, batch order; the single `b2Key` of older rows.
    pub fn outputs(&self) -> Vec<&str> {
        match (&self.b2_keys, &self.b2_key) {
            (Some(keys), _) if !keys.is_empty() => keys.iter().map(String::as_str).collect(),
            (_, Some(key)) => vec![key.as_str()],
            _ => Vec::new(),
        }
    }

    fn progress(&self) -> ProgressFields<'_> {
        ProgressFields {
            pending: self.status == GenerationStatus::Pending,
            video: self.is_video(),
            dispatched: self.dispatched_at.is_some(),
            stage: self.progress_stage.as_deref(),
            message: self.progress_message.as_deref(),
            current: self.progress_current,
            total: self.progress_total,
            queue_position: self.queue_position,
        }
    }

    pub fn progress_percent(&self) -> Option<f32> {
        self.progress().percent()
    }

    pub fn progress_label(&self) -> String {
        self.progress().label()
    }
}

/// Newest first, every provider. Hot: running rows change about once a second.
pub const LIST: PaginatedQuery<NoArgs, ApiGeneration> = PaginatedQuery::new("grokGenerations:list");

#[derive(Clone, Debug, Serialize)]
pub struct IdArgs {
    pub id: String,
}

/// One row by id, `None` when gone (or someone else's). Reproduce and the
/// viewer's details.
pub const GET: Query<IdArgs, Option<ApiGeneration>> = Query::new("grokGenerations:get");

/// A one-time Convex storage upload URL for a reference image.
pub const UPLOAD_URL: Mutation<NoArgs, String> =
    Mutation::new("grokGenerations:generateRefUploadUrl");

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StartImageArgs {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    pub prompt: String,
    pub aspect_ratio: String,
    pub count: f64,
    pub quality: String,
    pub resolution: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reference_storage_ids: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reference_source_keys: Option<Vec<Option<String>>>,
}

/// Inserts the rows (one per output of a fan-out) and schedules the jobs.
/// Returns the first row's id.
pub const START_IMAGE: Mutation<StartImageArgs, String> =
    Mutation::new("grokGenerations:startImage");

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StartVideoArgs {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    pub prompt: String,
    pub duration: f64,
    pub resolution: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub aspect_ratio: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub video_tier: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub video_job_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub video_mode: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub generate_audio: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bitrate_mode: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub count: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reference_storage_ids: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reference_source_keys: Option<Vec<Option<String>>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reference_voices: Option<Vec<String>>,
}

pub const START_VIDEO: Mutation<StartVideoArgs, String> =
    Mutation::new("grokGenerations:startVideo");

/// Takes a row off the screen at any stage. A running job is not cancelled:
/// the vendor has it, and it is still billed.
pub const REMOVE: Mutation<IdArgs, ()> = Mutation::new("grokGenerations:remove");

#[derive(Clone, Debug, Serialize)]
pub struct RemoveManyArgs {
    pub ids: Vec<String>,
}

/// At most this many ids per call (`MAX_BULK_REMOVE`).
pub const REMOVE_MANY_CHUNK: usize = 200;

/// Returns how many rows were removed.
pub const REMOVE_MANY: Mutation<RemoveManyArgs, f64> = Mutation::new("grokGenerations:removeMany");

/// Removes failed rows, except those already billed (a timeout is never
/// billed). Returns how many were removed.
pub const REMOVE_ALL_FAILED: Mutation<NoArgs, f64> =
    Mutation::new("grokGenerations:removeAllFailed");

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decodes_a_row_and_lists_its_outputs() {
        let row: ApiGeneration = serde_json::from_value(serde_json::json!({
            "_id": "k1",
            "_creationTime": 1.0,
            "userId": "u",
            "createdAt": 1_700_000_000_000.0,
            "prompt": "a cat",
            "searchablePrompt": "a cat",
            "mediaType": "image",
            "status": "completed",
            "b2Keys": ["a.png", "b.png"],
            "hasReferenceImage": false,
            "provider": "atlas",
            "apiModel": "bytedance/seedream-v4.5/text-to-image",
            "atlasParams": { "size": "2048*2048" },
            "atlasPollLeaseUntil": 5.0,
            "progressUpdatedAt": 5.0
        }))
        .unwrap();
        assert_eq!(row.outputs(), ["a.png", "b.png"]);
        assert_eq!(row.provider(), ApiProvider::Atlas);

        let legacy: ApiGeneration = serde_json::from_value(serde_json::json!({
            "_id": "k0", "createdAt": 1.0, "prompt": "", "mediaType": "video",
            "status": "processing", "b2Key": "v.mp4", "hasReferenceImage": true
        }))
        .unwrap();
        assert_eq!(legacy.provider(), ApiProvider::Grok);
        assert_eq!(legacy.outputs(), ["v.mp4"]);
        assert_eq!(legacy.progress_label(), "Generating video…");
    }
}
