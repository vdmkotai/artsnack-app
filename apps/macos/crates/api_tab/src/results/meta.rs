//! What a row shows besides its media — the model badge, the price, the
//! failure summary — read through the web's own code: `crates/rules/js/
//! api-results.ts`, on the composer's JavaScript worker, because an Atlas
//! row's badge is its catalogue label and the catalogue lives there.
//!
//! Asked for once per value of what the labels are made from — the row as it
//! is sent ([`row_json`]), which leaves out progress and queue position — a
//! page of rows per message, one message at a time, behind the composer's
//! calls on the worker. A running row is rewritten about once a second; only a
//! change the labels can show asks again, and it keeps its last answer until
//! the next one lands, so its badge never blinks. If the worker cannot answer,
//! a row gets a plain fallback (its model id, no price) rather than being
//! asked again on every update.

use std::{collections::HashMap, future::Future, rc::Rc, sync::Arc};

use artsnack_backend::api::{
    comfy_video::RunDetails,
    generations::GenerationStatus,
    grok_generations::{ApiGeneration, ApiProvider, MediaType},
};
use gpui_kit::App;
use serde::{Deserialize, de::DeserializeOwned};
use serde_json::{Map, Value, json};

/// A row's labels, as `rowMeta` in api-results.ts returns them.
#[derive(Clone, Debug, Default, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RowMeta {
    /// "SD 4.5", an Atlas model's label, "H3 · checkpoint".
    pub badge: String,
    /// For the tile: "$0.04", "≈$0.12", "22.5 credits", "subscription".
    pub price: Option<String>,
    /// For the viewer: "Included in SuperGrok" instead of "subscription".
    pub price_tag: Option<String>,
    /// The dollar cost; an Atlas estimate re-priced by the current formula.
    pub cost_usd: Option<f64>,
    pub failure: Option<Failure>,
    /// A finished Seedance 2.5 draft: the `atlas:start` arguments that render
    /// it at 1080p (packages/shared/atlas-drafts.ts).
    #[serde(default)]
    pub draft: Option<DraftCompletion>,
    /// The clip's key when Grok can edit or extend it (an mp4 we serve).
    #[serde(default)]
    pub grok_source_key: Option<String>,
}

/// `rowMeta(...).draft`.
#[derive(Clone, Debug, Default, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DraftCompletion {
    pub model: String,
    pub prompt: String,
    pub params: Map<String, Value>,
    /// What finishing it costs, when the draft's length is known.
    pub usd: Option<f64>,
    /// After this (ms since the epoch) Atlas no longer has the draft.
    pub expires_at: f64,
}

/// `describeFailure`: the sentence buried in a vendor's error payload.
#[derive(Clone, Debug, Default, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Failure {
    /// One readable line for the tile.
    pub summary: String,
    /// The original text, for the Details popover.
    pub full: String,
    /// The popover would show more than the summary does.
    pub has_more: bool,
}

impl RowMeta {
    /// What a row shows when the worker cannot say.
    fn fallback(row: &ApiGeneration) -> Self {
        let error = row.error.as_deref().map(str::trim).unwrap_or_default();
        let error = if error.is_empty() {
            "Unknown error"
        } else {
            error
        };
        let summary: String = error.chars().take(160).collect();
        Self {
            badge: row.api_model.clone().unwrap_or_else(|| "Grok".into()),
            price: None,
            price_tag: None,
            cost_usd: row.cost_usd,
            failure: row.is_failed().then(|| Failure {
                has_more: summary.len() < error.len(),
                summary,
                full: error.to_string(),
            }),
            draft: None,
            grok_source_key: None,
        }
    }
}

/// A registry model's chip: its id and its short badge.
#[derive(Clone, Debug, PartialEq, Deserialize)]
pub(crate) struct ModelChip {
    pub id: String,
    pub badge: String,
}

/// One row's answer and what it was worked out from.
struct Known {
    /// The row value last checked against `sent`, so an unchanged row costs a
    /// pointer comparison.
    row: Arc<ApiGeneration>,
    /// The row as sent ([`row_json`]): equal JSON, equal labels.
    sent: Value,
    meta: Rc<RowMeta>,
}

/// The answers so far, by row id.
#[derive(Default)]
pub(crate) struct MetaCache {
    known: HashMap<String, Known>,
}

/// Rows to ask about: each row and the JSON sent for it.
pub(crate) type Unanswered = Vec<(Arc<ApiGeneration>, Value)>;

impl MetaCache {
    /// The latest answer for the row's id — possibly for an earlier value of
    /// the row, until the current one is answered.
    pub fn get(&self, row: &ApiGeneration) -> Option<&Rc<RowMeta>> {
        self.known.get(&row.id).map(|known| &known.meta)
    }

    /// The rows whose labels may read differently from their last answer. A
    /// row that changed only where the labels do not look (its progress) keeps
    /// its answer.
    pub fn unanswered(&mut self, rows: &[Arc<ApiGeneration>]) -> Unanswered {
        let mut unanswered = Vec::new();
        for row in rows {
            match self.known.get_mut(&row.id) {
                Some(known) if Arc::ptr_eq(&known.row, row) => {}
                Some(known) => {
                    let sent = row_json(row);
                    if sent == known.sent {
                        known.row = row.clone();
                    } else {
                        unanswered.push((row.clone(), sent));
                    }
                }
                None => unanswered.push((row.clone(), row_json(row))),
            }
        }
        unanswered
    }

    /// Stores the worker's answers for `rows`, or the fallback for each when it
    /// had none.
    pub fn store(&mut self, rows: Unanswered, answers: Option<Vec<RowMeta>>) {
        let answers = answers.filter(|answers| answers.len() == rows.len());
        let mut answers = answers.map(Vec::into_iter);
        for (row, sent) in rows {
            let meta = answers
                .as_mut()
                .and_then(Iterator::next)
                .unwrap_or_else(|| RowMeta::fallback(&row));
            self.known.insert(
                row.id.clone(),
                Known {
                    row,
                    sent,
                    meta: Rc::new(meta),
                },
            );
        }
    }

    /// Forgets rows that are no longer loaded.
    pub fn retain(&mut self, rows: &[Arc<ApiGeneration>]) {
        if self.known.len() <= rows.len() {
            return;
        }
        let present: std::collections::HashSet<&str> =
            rows.iter().map(|row| row.id.as_str()).collect();
        self.known.retain(|id, _| present.contains(id.as_str()));
    }
}

/// Calls `apiResults.<function>` on the composer's worker, behind the
/// composer's own calls: nothing here is the answer to a click.
fn call<T: DeserializeOwned + Send + 'static>(
    function: &str,
    args: Value,
    cx: &App,
) -> impl Future<Output = anyhow::Result<T>> + Send + 'static + use<T> {
    artsnack_rules::composer(cx).call_background(&format!("apiResults.{function}"), args)
}

/// Labels for rows already in their sent form ([`row_json`]), in order.
pub(crate) fn rows_meta(
    rows: Vec<Value>,
    cx: &App,
) -> impl Future<Output = anyhow::Result<Vec<RowMeta>>> + Send + 'static + use<> {
    call("rowsMeta", json!([rows]), cx)
}

/// The registry's models in the web's chip order.
pub(crate) fn model_chips(
    cx: &App,
) -> impl Future<Output = anyhow::Result<Vec<ModelChip>>> + Send + 'static + use<> {
    call("modelChips", json!([]), cx)
}

/// The details panel's sections for `row`; see `details` in api-results.ts.
pub(crate) fn details<T: DeserializeOwned + Send + 'static>(
    row: &ApiGeneration,
    pod: Option<&RunDetails>,
    cx: &App,
) -> impl Future<Output = anyhow::Result<T>> + Send + 'static + use<T> {
    let pod = pod.map(|pod| {
        json!({
            "gpuType": pod.gpu_type,
            "gpuName": pod.gpu_name,
            "gpuCount": pod.gpu_count,
            "gpuIndex": pod.gpu_index,
            "cloudType": pod.cloud_type,
            "hourlyUsd": pod.hourly_usd,
            "podId": pod.pod_id,
        })
    });
    call("details", json!([row_json(row), pod]), cx)
}

/// The row as the web's `Doc<"grokGenerations">`: the fields the shared
/// helpers read, absent ones left out (they test for `undefined`).
pub(crate) fn row_json(row: &ApiGeneration) -> Value {
    let mut map = Map::new();
    let mut put = |key: &str, value: Value| {
        if !value.is_null() {
            map.insert(key.to_string(), value);
        }
    };
    put("_id", json!(row.id));
    put("_creationTime", json!(row.creation_time));
    put("createdAt", json!(row.created_at));
    put("prompt", json!(row.prompt));
    put(
        "mediaType",
        json!(match row.media_type {
            MediaType::Image => "image",
            MediaType::Video => "video",
        }),
    );
    put(
        "status",
        json!(match row.status {
            GenerationStatus::Pending => "pending",
            GenerationStatus::Processing => "processing",
            GenerationStatus::Completed => "completed",
            GenerationStatus::Failed => "failed",
            GenerationStatus::Other => "other",
        }),
    );
    let provider = match row.provider {
        Some(ApiProvider::Grok) => Some("grok"),
        Some(ApiProvider::Fal) => Some("fal"),
        Some(ApiProvider::Higgsfield) => Some("higgsfield"),
        Some(ApiProvider::Atlas) => Some("atlas"),
        Some(ApiProvider::Comfy) => Some("comfy"),
        Some(ApiProvider::Other) | None => None,
    };
    put("provider", json!(provider));
    put("apiModel", json!(row.api_model));
    put("b2Key", json!(row.b2_key));
    put("b2Keys", json!(row.b2_keys));
    put("error", json!(row.error));
    put("errorKind", json!(row.error_kind));
    put("aspectRatio", json!(row.aspect_ratio));
    put("count", json!(row.count));
    put("quality", json!(row.quality));
    put("duration", json!(row.duration));
    put("resolution", json!(row.resolution));
    put("hasReferenceImage", json!(row.has_reference_image));
    put("referenceB2Keys", json!(row.reference_b2_keys));
    put("referenceSourceKeys", json!(row.reference_source_keys));
    put("atlasParams", json!(row.atlas_params));
    put("h3Settings", json!(row.h3_settings));
    put("ltxSettings", json!(row.ltx_settings));
    put("h3InputRoles", json!(row.h3_input_roles));
    put("comfyRun", json!(row.comfy_run));
    put("endpoint", json!(row.endpoint));
    put("videoTier", json!(row.video_tier));
    put("videoJobType", json!(row.video_job_type));
    put("videoMode", json!(row.video_mode));
    put("generateAudio", json!(row.generate_audio));
    put("completedAt", json!(row.completed_at));
    put("falRequestId", json!(row.fal_request_id));
    put("grokVideoModel", json!(row.grok_video_model));
    put("grokVideoMode", json!(row.grok_video_mode));
    put("grokFrameRoles", json!(row.grok_frame_roles));
    put("sourceVideoKey", json!(row.source_video_key));
    put("sourceVideoSeconds", json!(row.source_video_seconds));
    put("meteredUsd", json!(row.metered_usd));
    put("costUsd", json!(row.cost_usd));
    put("creditsUsed", json!(row.credits_used));
    put("costEstimated", json!(row.cost_estimated));
    Value::Object(map)
}

/// Dollars, as `formatUsd` in packages/shared/api-pricing.ts shows them: the
/// header's totals change with every filter and running row, and asking the
/// worker for each would make them trail the grid.
pub(crate) fn format_usd(value: f64) -> String {
    fn trim(text: String) -> String {
        text.trim_end_matches('0').trim_end_matches('.').to_string()
    }
    if value <= 0.0 {
        "$0".into()
    } else if value < 0.01 {
        format!("${}", trim(format!("{value:.4}")))
    } else if value < 1.0 {
        let text = format!("{value:.3}");
        format!("${}", text.strip_suffix('0').unwrap_or(&text))
    } else {
        format!("${value:.2}")
    }
}

/// Credits keeping the half (`formatCredits`): Higgsfield's rates are full
/// of 7.5s, and rounding made a batch disagree with the button that started it.
pub(crate) fn format_credits(amount: f64) -> String {
    if amount.fract() == 0.0 {
        format!("{amount:.0}")
    } else {
        format!("{amount:.1}")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row(id: &str, cost: f64) -> Arc<ApiGeneration> {
        Arc::new(
            serde_json::from_value(json!({
                "_id": id, "createdAt": 1.0, "prompt": "p", "mediaType": "image",
                "status": "failed", "error": "boom", "provider": "fal", "costUsd": cost,
            }))
            .unwrap(),
        )
    }

    #[test]
    fn formats_money_like_the_web() {
        assert_eq!(format_usd(0.0), "$0");
        assert_eq!(format_usd(0.0035), "$0.0035");
        assert_eq!(format_usd(0.005), "$0.005");
        assert_eq!(format_usd(0.04), "$0.04");
        assert_eq!(format_usd(0.125), "$0.125");
        assert_eq!(format_usd(12.5), "$12.50");
        assert_eq!(format_credits(30.0), "30");
        assert_eq!(format_credits(22.5), "22.5");
    }

    #[test]
    fn asks_once_per_labelled_value_and_keeps_the_last_answer() {
        let mut cache = MetaCache::default();
        let first = row("a", 1.0);
        let asked = cache.unanswered(std::slice::from_ref(&first));
        assert_eq!(asked.len(), 1);
        cache.store(asked, None);
        let meta = cache.get(&first).unwrap();
        assert_eq!(meta.failure.as_ref().unwrap().summary, "boom");
        assert!(cache.unanswered(std::slice::from_ref(&first)).is_empty());

        // A new value with the same labels is not asked about again.
        let same = row("a", 1.0);
        assert!(cache.unanswered(std::slice::from_ref(&same)).is_empty());

        // A new value that reads differently is; the old answer stands meanwhile.
        let second = row("a", 2.0);
        assert_eq!(cache.unanswered(std::slice::from_ref(&second)).len(), 1);
        assert_eq!(cache.get(&second).unwrap().cost_usd, Some(1.0));
        cache.retain(&[]);
        assert!(cache.get(&second).is_none());
    }

    #[test]
    fn sends_rows_the_way_the_web_stores_them() {
        let json = row_json(&row("a", 1.0));
        assert_eq!(json["_id"], "a");
        assert_eq!(json["provider"], "fal");
        assert_eq!(json["status"], "failed");
        assert!(json.get("apiModel").is_none());
    }
}
