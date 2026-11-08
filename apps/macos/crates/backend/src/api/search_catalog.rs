//! `packages/backend/convex/searchCatalog.ts`: the compact catalogue the
//! Search screen searches on the device — one document per finished
//! generation of either table (`SearchDocument` in `packages/shared/search.ts`).
//!
//! The documents are computed by the server, so their shape is the shared
//! type's, not a table's: `id` rather than `_id`, and no bookkeeping fields at
//! all — a progress write on a running job changes no document.

use std::collections::BTreeMap;

use serde::{Deserialize, Deserializer, Serialize};
use serde_json::Value;

use crate::{NoArgs, PaginatedQuery, Row, api::favorites::MediaType};

/// Which table a document came from.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum SearchSource {
    /// `generations`: the self-hosted image tab.
    #[serde(rename = "self-hosted")]
    SelfHosted,
    /// `grokGenerations`: every provider of the API tab, and self-hosted video.
    #[serde(rename = "api")]
    Api,
}

impl SearchSource {
    pub const ALL: [SearchSource; 2] = [SearchSource::SelfHosted, SearchSource::Api];

    /// The wire value, which is also what filters and facets use.
    pub fn as_str(self) -> &'static str {
        match self {
            SearchSource::SelfHosted => "self-hosted",
            SearchSource::Api => "api",
        }
    }
}

/// One output of a generation.
#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchAsset {
    /// The output's position, as a string (`"0"`, `"1"`, …).
    pub id: String,
    pub key: String,
    pub thumbnail_key: Option<String>,
}

/// A provider parameter (`string | number | boolean | string[]`).
#[derive(Clone, Debug, PartialEq)]
pub enum ParameterValue {
    Text(String),
    Number(f64),
    Flag(bool),
    List(Vec<String>),
}

impl ParameterValue {
    /// The value as the strings a filter compares against, as JavaScript's
    /// `String(value)` writes them (`raw.map(String)` for a list).
    pub fn strings(&self) -> Vec<String> {
        match self {
            ParameterValue::Text(text) => vec![text.clone()],
            ParameterValue::Number(number) => vec![js_number(*number)],
            ParameterValue::Flag(flag) => vec![flag.to_string()],
            ParameterValue::List(values) => values.clone(),
        }
    }
}

impl<'de> Deserialize<'de> for ParameterValue {
    /// Read loosely: the declared union is what the server writes today, but
    /// one odd value must not fail the decoding of a whole page of history.
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        Ok(match Value::deserialize(deserializer)? {
            Value::String(text) => ParameterValue::Text(text),
            Value::Number(number) => ParameterValue::Number(number.as_f64().unwrap_or(f64::NAN)),
            Value::Bool(flag) => ParameterValue::Flag(flag),
            Value::Array(values) => ParameterValue::List(values.iter().map(js_string).collect()),
            other => ParameterValue::Text(js_string(&other)),
        })
    }
}

/// JavaScript's `String(value)` for a JSON value.
fn js_string(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        Value::Number(number) => js_number(number.as_f64().unwrap_or(f64::NAN)),
        Value::Bool(flag) => flag.to_string(),
        Value::Null => "null".into(),
        Value::Array(values) => values.iter().map(js_string).collect::<Vec<_>>().join(","),
        Value::Object(_) => "[object Object]".into(),
    }
}

/// JavaScript's `String(number)`: integers without a fraction, exponents
/// from 1e21 up and below 1e-6.
pub fn js_number(number: f64) -> String {
    if number.is_nan() {
        return "NaN".into();
    }
    if number.is_infinite() {
        return if number > 0.0 {
            "Infinity"
        } else {
            "-Infinity"
        }
        .into();
    }
    if number == 0.0 {
        // Covers -0, which JavaScript also writes as "0".
        return "0".into();
    }
    let magnitude = number.abs();
    if (1e-6..1e21).contains(&magnitude) {
        // Rust's shortest round-trip form is JavaScript's in this range.
        return format!("{number}");
    }
    let exponent = format!("{number:e}");
    match exponent.split_once('e') {
        Some((mantissa, power)) if !power.starts_with('-') => format!("{mantissa}e+{power}"),
        _ => exponent,
    }
}

/// One generation, as `localSearchDocument` / `hostedSearchDocument` build it.
#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchDocument {
    /// The row's id in its table.
    pub id: String,
    pub source: SearchSource,
    /// `self-hosted`, `grok`, `fal`, `higgsfield`, `atlas` or `comfy`. Kept as
    /// a string so a provider added later decodes instead of failing the page.
    pub provider: String,
    pub media_type: MediaType,
    /// Milliseconds since the epoch.
    pub created_at: f64,
    pub prompt: String,
    pub negative_prompt: Option<String>,
    pub assets: Vec<SearchAsset>,
    pub model: Option<String>,
    pub model_label: Option<String>,
    pub model_family: Option<String>,
    #[serde(default)]
    pub checkpoints: Vec<String>,
    #[serde(default)]
    pub loras: Vec<String>,
    pub width: Option<f64>,
    pub height: Option<f64>,
    /// `"W:H"`, for API rows that record a ratio rather than a size.
    pub aspect_ratio: Option<String>,
    pub resolution: Option<String>,
    pub quality: Option<String>,
    /// Seconds, for clips.
    pub duration: Option<f64>,
    #[serde(default)]
    pub has_references: bool,
    pub sampler: Option<String>,
    pub scheduler: Option<String>,
    pub steps: Option<f64>,
    pub cfg: Option<f64>,
    pub seed: Option<f64>,
    /// Atlas and other provider-specific parameters, by vendor name.
    pub parameters: Option<BTreeMap<String, ParameterValue>>,
    /// The self-hosted form the image ran with (`formStateValidator`), kept as
    /// the server sent it so Reproduce hands it on unchanged.
    pub local_settings: Option<Value>,
}

impl Row for SearchDocument {
    fn row_id(&self) -> &str {
        &self.id
    }
}

/// Self-hosted image generations, newest first; failed and output-less rows
/// are left out by the server, so a page can hold fewer than it asked for.
pub const LOCAL: PaginatedQuery<NoArgs, SearchDocument> =
    PaginatedQuery::new("searchCatalog:local");

/// API-tab generations (every provider, and self-hosted video), newest first.
pub const HOSTED: PaginatedQuery<NoArgs, SearchDocument> =
    PaginatedQuery::new("searchCatalog:hosted");

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn writes_numbers_like_javascript() {
        assert_eq!(js_number(0.0), "0");
        assert_eq!(js_number(-0.0), "0");
        assert_eq!(js_number(42.0), "42");
        assert_eq!(js_number(7.5), "7.5");
        assert_eq!(js_number(0.1), "0.1");
        assert_eq!(js_number(1e21), "1e+21");
        assert_eq!(js_number(1e-7), "1e-7");
        assert_eq!(js_number(123_456_789_012.0), "123456789012");
    }

    #[test]
    fn decodes_a_hosted_document_and_its_parameters() {
        let document: SearchDocument = serde_json::from_value(serde_json::json!({
            "id": "k1",
            "source": "api",
            "provider": "atlas",
            "mediaType": "video",
            "createdAt": 1_700_000_000_000.0,
            "prompt": "girl walking on beach",
            "assets": [{ "id": "0", "key": "a.mp4" }],
            "model": "wan",
            "checkpoints": [],
            "loras": [],
            "duration": 10,
            "hasReferences": true,
            "parameters": { "motion": "high", "camera": ["pan", "zoom"], "audio": true, "steps": 0 }
        }))
        .unwrap();
        assert_eq!(document.source, SearchSource::Api);
        assert_eq!(document.media_type, MediaType::Video);
        let parameters = document.parameters.unwrap();
        assert_eq!(parameters["camera"].strings(), ["pan", "zoom"]);
        assert_eq!(parameters["audio"].strings(), ["true"]);
        assert_eq!(parameters["steps"].strings(), ["0"]);
        assert_eq!(document.negative_prompt, None);
    }
}
