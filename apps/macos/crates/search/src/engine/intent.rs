//! What the user asked for — query, negative-prompt query, typo tolerance,
//! sort and filters — and its URL form, which saved searches store and the
//! web and iOS apps read.

use std::collections::BTreeMap;

use artsnack_backend::api::{favorites::MediaType, search_catalog::SearchSource};
use serde::{Serialize, Serializer};
use serde_json::Value;
use url::form_urlencoded;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum SearchSort {
    #[default]
    Relevance,
    Newest,
    Oldest,
}

impl SearchSort {
    pub const ALL: [SearchSort; 3] = [
        SearchSort::Relevance,
        SearchSort::Newest,
        SearchSort::Oldest,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            SearchSort::Relevance => "relevance",
            SearchSort::Newest => "newest",
            SearchSort::Oldest => "oldest",
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            SearchSort::Relevance => "Relevance",
            SearchSort::Newest => "Newest",
            SearchSort::Oldest => "Oldest",
        }
    }
}

/// Whether a document must carry any or all of the selected LoRAs.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum LoraMode {
    #[default]
    Any,
    All,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Orientation {
    Portrait,
    Square,
    Landscape,
}

impl Orientation {
    pub const ALL: [Orientation; 3] = [
        Orientation::Portrait,
        Orientation::Square,
        Orientation::Landscape,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            Orientation::Portrait => "portrait",
            Orientation::Square => "square",
            Orientation::Landscape => "landscape",
        }
    }
}

/// The providers a filter may name (`normalizeSearchFilters`).
pub const SEARCH_PROVIDERS: [&str; 6] =
    ["self-hosted", "grok", "fal", "higgsfield", "atlas", "comfy"];

/// `SearchFilters`. Field order is the shared type's, which is also the key
/// order of the JSON this serialises to.
#[derive(Clone, Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchFilters {
    pub media_types: Vec<MediaType>,
    pub sources: Vec<SearchSource>,
    pub providers: Vec<String>,
    pub models: Vec<String>,
    pub model_families: Vec<String>,
    pub checkpoints: Vec<String>,
    pub loras: Vec<String>,
    pub lora_mode: LoraMode,
    #[serde(skip_serializing_if = "Option::is_none", serialize_with = "js_number")]
    pub created_after: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none", serialize_with = "js_number")]
    pub created_before: Option<f64>,
    pub orientations: Vec<Orientation>,
    pub resolutions: Vec<String>,
    pub qualities: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none", serialize_with = "js_number")]
    pub duration_min: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none", serialize_with = "js_number")]
    pub duration_max: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub has_references: Option<bool>,
    pub samplers: Vec<String>,
    pub schedulers: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none", serialize_with = "js_number")]
    pub steps_min: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none", serialize_with = "js_number")]
    pub steps_max: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none", serialize_with = "js_number")]
    pub cfg_min: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none", serialize_with = "js_number")]
    pub cfg_max: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none", serialize_with = "js_number")]
    pub seed: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none", serialize_with = "js_number")]
    pub width_min: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none", serialize_with = "js_number")]
    pub width_max: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none", serialize_with = "js_number")]
    pub height_min: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none", serialize_with = "js_number")]
    pub height_max: Option<f64>,
    /// Atlas and future provider-specific parameter values, by vendor name.
    pub parameters: BTreeMap<String, Vec<String>>,
}

/// Writes whole numbers without a fraction, as `JSON.stringify` does, so a
/// saved search reads the same in every client.
fn js_number<S: Serializer>(value: &Option<f64>, serializer: S) -> Result<S::Ok, S::Error> {
    match value {
        Some(number) if number.fract() == 0.0 && number.abs() < 9_007_199_254_740_992.0 => {
            serializer.serialize_i64(*number as i64)
        }
        Some(number) => serializer.serialize_f64(*number),
        None => serializer.serialize_none(),
    }
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct SearchIntent {
    pub query: String,
    pub negative_prompt_query: String,
    pub allow_typos: bool,
    pub sort: SearchSort,
    pub filters: SearchFilters,
}

/// How many filters are on, a group counting once (`countActiveSearchFilters`):
/// each non-empty list, any parameter selection, each bound, the reference
/// choice, and "require all LoRAs".
pub fn count_active_search_filters(filters: &SearchFilters) -> usize {
    let lists = [
        filters.media_types.is_empty(),
        filters.sources.is_empty(),
        filters.providers.is_empty(),
        filters.models.is_empty(),
        filters.model_families.is_empty(),
        filters.checkpoints.is_empty(),
        filters.loras.is_empty(),
        filters.orientations.is_empty(),
        filters.resolutions.is_empty(),
        filters.qualities.is_empty(),
        filters.samplers.is_empty(),
        filters.schedulers.is_empty(),
    ];
    let bounds = [
        filters.created_after,
        filters.created_before,
        filters.duration_min,
        filters.duration_max,
        filters.steps_min,
        filters.steps_max,
        filters.cfg_min,
        filters.cfg_max,
        filters.seed,
        filters.width_min,
        filters.width_max,
        filters.height_min,
        filters.height_max,
    ];
    lists.iter().filter(|empty| !**empty).count()
        + bounds.iter().filter(|bound| bound.is_some()).count()
        + usize::from(filters.lora_mode == LoraMode::All)
        + usize::from(filters.has_references.is_some())
        + usize::from(filters.parameters.values().any(|values| !values.is_empty()))
}

/// `q=…&negative=…&typos=1&sort=…&filters=<JSON>`, leaving out defaults.
pub fn serialize_search_intent(intent: &SearchIntent) -> String {
    let mut params = form_urlencoded::Serializer::new(String::new());
    if !intent.query.is_empty() {
        params.append_pair("q", &intent.query);
    }
    if !intent.negative_prompt_query.is_empty() {
        params.append_pair("negative", &intent.negative_prompt_query);
    }
    if intent.allow_typos {
        params.append_pair("typos", "1");
    }
    if intent.sort != SearchSort::Relevance {
        params.append_pair("sort", intent.sort.as_str());
    }
    if count_active_search_filters(&intent.filters) > 0
        && let Ok(json) = serde_json::to_string(&intent.filters)
    {
        params.append_pair("filters", &json);
    }
    params.finish()
}

/// Reads a URL form back. A hand-edited or stale one opens with safe
/// defaults for whatever does not parse, rather than failing.
pub fn deserialize_search_intent(value: &str) -> SearchIntent {
    let value = value.strip_prefix('?').unwrap_or(value);
    let mut first: BTreeMap<String, String> = BTreeMap::new();
    for (key, value) in form_urlencoded::parse(value.as_bytes()) {
        first
            .entry(key.into_owned())
            .or_insert_with(|| value.into_owned());
    }
    let filters = first
        .get("filters")
        .filter(|encoded| !encoded.is_empty())
        .and_then(|encoded| serde_json::from_str::<Value>(encoded).ok())
        .map(|raw| normalize_search_filters(&raw))
        .unwrap_or_default();
    let sort = match first.get("sort").map(String::as_str) {
        Some("newest") => SearchSort::Newest,
        Some("oldest") => SearchSort::Oldest,
        _ => SearchSort::Relevance,
    };
    SearchIntent {
        query: first.get("q").cloned().unwrap_or_default(),
        negative_prompt_query: first.get("negative").cloned().unwrap_or_default(),
        allow_typos: first.get("typos").map(String::as_str) == Some("1"),
        sort,
        filters,
    }
}

/// `normalizeSearchFilters`: keeps only well-formed values, and only the
/// known ones for closed sets.
fn normalize_search_filters(raw: &Value) -> SearchFilters {
    let empty = serde_json::Map::new();
    let raw = raw.as_object().unwrap_or(&empty);
    let strings = |key: &str| -> Vec<String> {
        raw.get(key)
            .and_then(Value::as_array)
            .map(|values| {
                values
                    .iter()
                    .filter_map(|value| value.as_str().map(str::to_string))
                    .collect()
            })
            .unwrap_or_default()
    };
    let number = |key: &str| -> Option<f64> {
        raw.get(key)
            .filter(|value| value.is_number())
            .and_then(Value::as_f64)
            .filter(|value| value.is_finite())
    };

    let media_types = strings("mediaTypes")
        .iter()
        .filter_map(|value| match value.as_str() {
            "image" => Some(MediaType::Image),
            "video" => Some(MediaType::Video),
            _ => None,
        })
        .collect();
    let sources = strings("sources")
        .iter()
        .filter_map(|value| {
            SearchSource::ALL
                .into_iter()
                .find(|source| source.as_str() == value)
        })
        .collect();
    let providers = strings("providers")
        .into_iter()
        .filter(|value| SEARCH_PROVIDERS.contains(&value.as_str()))
        .collect();
    let orientations = strings("orientations")
        .iter()
        .filter_map(|value| {
            Orientation::ALL
                .into_iter()
                .find(|orientation| orientation.as_str() == value)
        })
        .collect();
    let mut parameters = BTreeMap::new();
    if let Some(selected) = raw.get("parameters").and_then(Value::as_object) {
        for (name, values) in selected {
            let values: Vec<String> = values
                .as_array()
                .map(|values| {
                    values
                        .iter()
                        .filter_map(|value| value.as_str().map(str::to_string))
                        .collect()
                })
                .unwrap_or_default();
            if !values.is_empty() {
                parameters.insert(name.clone(), values);
            }
        }
    }

    SearchFilters {
        media_types,
        sources,
        providers,
        models: strings("models"),
        model_families: strings("modelFamilies"),
        checkpoints: strings("checkpoints"),
        loras: strings("loras"),
        lora_mode: if raw.get("loraMode").and_then(Value::as_str) == Some("all") {
            LoraMode::All
        } else {
            LoraMode::Any
        },
        created_after: number("createdAfter"),
        created_before: number("createdBefore"),
        orientations,
        resolutions: strings("resolutions"),
        qualities: strings("qualities"),
        duration_min: number("durationMin"),
        duration_max: number("durationMax"),
        has_references: raw.get("hasReferences").and_then(Value::as_bool),
        samplers: strings("samplers"),
        schedulers: strings("schedulers"),
        steps_min: number("stepsMin"),
        steps_max: number("stepsMax"),
        cfg_min: number("cfgMin"),
        cfg_max: number("cfgMax"),
        seed: number("seed"),
        width_min: number("widthMin"),
        width_max: number("widthMax"),
        height_min: number("heightMin"),
        height_max: number("heightMax"),
        parameters,
    }
}

/// The same search, whatever order its parts were written in.
pub fn same_search_intent(left: &SearchIntent, right: &SearchIntent) -> bool {
    serialize_search_intent(left) == serialize_search_intent(right)
}

/// How many raw queries the device remembers.
pub const SEARCH_HISTORY_LIMIT: usize = 20;

/// The device's query history from its stored JSON; anything but a list of
/// strings reads as no history.
pub fn parse_search_history(raw: Option<&str>, limit: usize) -> Vec<String> {
    raw.and_then(|raw| serde_json::from_str::<Value>(raw).ok())
        .map(|value| search_history_from_value(&value, limit))
        .unwrap_or_default()
}

pub fn search_history_from_value(value: &Value, limit: usize) -> Vec<String> {
    value
        .as_array()
        .map(|entries| {
            entries
                .iter()
                .filter_map(|entry| entry.as_str().map(str::to_string))
                .take(limit)
                .collect()
        })
        .unwrap_or_default()
}

/// `query` first, without its earlier copy, at most `limit` entries.
pub fn add_search_history(previous: &[String], query: &str, limit: usize) -> Vec<String> {
    std::iter::once(query.to_string())
        .chain(
            previous
                .iter()
                .filter(|entry| entry.as_str() != query)
                .cloned(),
        )
        .take(limit)
        .collect()
}
