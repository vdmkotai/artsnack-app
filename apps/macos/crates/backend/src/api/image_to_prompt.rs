//! `packages/backend/convex/imageToPrompt.ts`: a picture in, a prompt that
//! would draw it out.

use serde::{Deserialize, Serialize};

use crate::{Action, NoArgs};

#[derive(Clone, Debug, Serialize)]
pub struct DescribeArgs {
    /// `data:image/jpeg;base64,…`. The server takes JPEG, PNG or WebP up to
    /// `MAX_DESCRIBE_IMAGE_CHARS` (3 000 000) characters; the client sends the
    /// `describe` reference profile (≤ 1536 px, ≤ 1.5 MB), ~2 MB as base64.
    pub image: String,
    /// A `DescribePresetId`: `"natural"` or `"sd-tags"`.
    pub preset: String,
    /// At most `MAX_DESCRIBE_INSTRUCTIONS` (1000) characters once trimmed.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub instructions: Option<String>,
    /// A [`DescribeModelOption`] id, e.g. `"grok:grok-4.6"` or
    /// `"atlas:qwen/qwen3.8-max"`; absent runs on the default (subscription
    /// Grok 4.6). The server checks its shape only — the lists are live.
    #[serde(rename = "modelId", skip_serializing_if = "Option::is_none")]
    pub model_id: Option<String>,
}

/// The model that answered (`EnhanceModel` in prompt-enhance.ts).
#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct DescribeModel {
    pub id: String,
    /// `"grok"` (the SuperGrok subscription) or `"atlas"` (the paid fallback).
    pub provider: String,
    pub label: String,
}

/// One model the picker offers (`DescribeModel` in image-to-prompt.ts).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct DescribeModelOption {
    /// `"grok:<xAI slug>"` or `"atlas:<Atlas slug>"`.
    pub id: String,
    /// `"grok"` or `"atlas"`.
    pub provider: String,
    /// The vendor's slug, e.g. `qwen/qwen3.8-max`.
    pub model: String,
    pub label: String,
    /// `"subscription"`, or the Atlas price: `"Atlas · $2 / $6 per 1M"`.
    pub note: String,
    /// The vendor lists image input. Atlas under-reports it, so a model
    /// without it stays pickable and is only marked.
    pub vision: bool,
}

/// `DescribeModelCatalog`: the subscription's models, then Atlas's text
/// models. A list that could not be read is replaced by its built-in Grok
/// models, and its error says why.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DescribeModelCatalog {
    pub models: Vec<DescribeModelOption>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub grok_error: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub atlas_error: Option<String>,
    /// Set on the client (`withPreviousModels`): the subscription's part is
    /// the list from last time, kept because the live read failed.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub grok_from_before: bool,
    /// Set on the client: Atlas's part is the list from last time.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub atlas_from_before: bool,
}

/// `ChatCompletionResult` in chatCompletion.ts.
#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Described {
    pub text: String,
    /// Absent on the subscription, which bills no dollars.
    pub cost_usd: Option<f64>,
    pub model: DescribeModel,
    /// The subscription did not answer and Atlas did.
    pub fell_back: bool,
    /// Why the subscription did not answer, when it fell back.
    pub reason: Option<String>,
}

/// One vision completion on the chosen model. A subscription model falls
/// back to the same model on Atlas when the subscription cannot answer.
pub const DESCRIBE: Action<DescribeArgs, Described> = Action::new("imageToPrompt:describe");

/// The models Image → Prompt can run on, read live from xAI (with the user's
/// subscription token) and Atlas on every call — about 2.5 s.
pub const MODELS: Action<NoArgs, DescribeModelCatalog> = Action::new("imageToPrompt:models");

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn arguments_and_result_match_the_action() {
        let args = DescribeArgs {
            image: "data:image/jpeg;base64,AAAA".into(),
            preset: "sd-tags".into(),
            instructions: None,
            model_id: None,
        };
        assert_eq!(
            serde_json::to_string(&args).unwrap(),
            r#"{"image":"data:image/jpeg;base64,AAAA","preset":"sd-tags"}"#
        );
        let args = DescribeArgs {
            model_id: Some("atlas:qwen/qwen3.8-max".into()),
            ..args
        };
        assert_eq!(
            serde_json::to_string(&args).unwrap(),
            r#"{"image":"data:image/jpeg;base64,AAAA","preset":"sd-tags","modelId":"atlas:qwen/qwen3.8-max"}"#
        );

        let described: Described = serde_json::from_value(serde_json::json!({
            "text": "lighthouse, sunset",
            "costUsd": 0.0018,
            "model": {
                "id": "atlas:x-ai/grok-4.6", "provider": "atlas", "model": "x-ai/grok-4.6",
                "label": "Grok 4.6", "note": ""
            },
            "fellBack": true,
            "reason": "rate limited"
        }))
        .unwrap();
        assert_eq!(described.model.provider, "atlas");
        assert_eq!(described.cost_usd, Some(0.0018));
        assert!(described.fell_back);
    }

    #[test]
    fn catalog_matches_the_action() {
        let catalog: DescribeModelCatalog = serde_json::from_value(serde_json::json!({
            "models": [
                {
                    "id": "grok:grok-4.6", "provider": "grok", "model": "grok-4.6",
                    "label": "Grok 4.6", "note": "subscription", "vision": true
                },
                {
                    "id": "atlas:deepseek-ai/deepseek-v4-flash", "provider": "atlas",
                    "model": "deepseek-ai/deepseek-v4-flash", "label": "DeepSeek V4 Flash",
                    "note": "Atlas · $0.14 / $0.28 per 1M", "vision": false
                }
            ],
            "atlasError": "Atlas answered HTTP 502"
        }))
        .unwrap();
        assert_eq!(catalog.models.len(), 2);
        assert!(!catalog.models[1].vision);
        assert_eq!(catalog.grok_error, None);
        assert_eq!(
            catalog.atlas_error.as_deref(),
            Some("Atlas answered HTTP 502")
        );
    }
}
