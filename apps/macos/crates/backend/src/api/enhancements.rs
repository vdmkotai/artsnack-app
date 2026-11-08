//! `packages/backend/convex/enhancements.ts` and `enhanceProcessor.ts`:
//! Img2Img, Upscale, Refine and Face Fix on the self-hosted pod.

use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::{Action, Mutation, NoArgs, PaginatedQuery, Query, Row, api::pod_submit::LoraSlot};

/// The action blocks until the result is in B2 (the web route allowed 300 s).
pub const ENHANCE_DEADLINE: Duration = Duration::from_secs(300);

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum EnhanceMode {
    #[default]
    Img2img,
    Upscale,
    Refine,
    Facefix,
}

impl EnhanceMode {
    pub const ALL: [Self; 4] = [Self::Img2img, Self::Upscale, Self::Refine, Self::Facefix];

    pub fn label(self) -> &'static str {
        match self {
            Self::Img2img => "Img2Img",
            Self::Upscale => "Upscale",
            Self::Refine => "Refine",
            Self::Facefix => "Face Fix",
        }
    }

    pub fn parse(mode: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|candidate| {
            serde_json::to_value(candidate)
                .ok()
                .and_then(|value| value.as_str().map(|value| value == mode))
                .unwrap_or(false)
        })
    }
}

/// One saved enhancement.
#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Enhancement {
    #[serde(rename = "_id")]
    pub id: String,
    pub timestamp: f64,
    pub mode: String,
    pub source_image_url: String,
    pub source_b2_key: Option<String>,
    pub source_generation_id: Option<String>,
    pub result_b2_key: String,
    /// The mode's settings snapshot (prompt, denoise, scale…).
    pub params: Option<Value>,
    pub warning: Option<String>,
}

impl Enhancement {
    /// The prompt, for Img2Img runs only: the other modes carry whatever the
    /// form held at the time, which did not make this image.
    pub fn prompt(&self) -> Option<&str> {
        if self.mode != "img2img" {
            return None;
        }
        self.params
            .as_ref()?
            .get("prompt")?
            .as_str()
            .filter(|prompt| !prompt.trim().is_empty())
    }
}

impl Row for Enhancement {
    fn row_id(&self) -> &str {
        &self.id
    }
}

/// Newest first, at most 100.
pub const LIST: Query<NoArgs, Vec<Enhancement>> = Query::new("enhancements:list");

/// Every enhancement, newest first, a page at a time.
pub const LIST_PAGINATED: PaginatedQuery<NoArgs, Enhancement> =
    PaginatedQuery::new("enhancements:listPaginated");

#[derive(Clone, Debug, Serialize)]
pub struct ByIdArgs {
    pub id: String,
}

pub const GET_BY_ID: Query<ByIdArgs, Option<Enhancement>> = Query::new("enhancements:getById");

#[derive(Clone, Debug, Serialize)]
pub struct RemoveArgs {
    pub id: String,
}

/// Deletes the enhancement and its favourite.
pub const REMOVE: Mutation<RemoveArgs, ()> = Mutation::new("enhancements:remove");

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum FaceDetail {
    Standard,
    High,
    Max,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum FaceDetector {
    Accurate,
    Fast,
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EnhanceArgs {
    pub mode: EnhanceMode,
    pub source_storage_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_b2_key: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_generation_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub prompt: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub negative_prompt: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub checkpoint: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sampler: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub scheduler: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub steps: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cfg: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub seed: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub denoise: Option<f64>,
    /// "2" or "4".
    #[serde(skip_serializing_if = "Option::is_none")]
    pub scale: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub loras: Option<Vec<LoraSlot>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub face_detail: Option<FaceDetail>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub face_detector: Option<FaceDetector>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub refine_eyes: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub eye_denoise: Option<f64>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Enhanced {
    pub b2_keys: Vec<String>,
    /// Not a failure: e.g. Face Fix found no faces.
    pub warning: Option<String>,
}

/// Runs the enhancement and saves it; resolves when the result exists.
pub const ENHANCE: Action<EnhanceArgs, Enhanced> = Action::new("enhanceProcessor:enhance");

/// A one-time Convex storage upload URL (`grokGenerations.generateRefUploadUrl`),
/// for references and Enhance sources.
pub const UPLOAD_URL: Mutation<NoArgs, String> =
    Mutation::new("grokGenerations:generateRefUploadUrl");
