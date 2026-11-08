//! Which generation a reference image came from, found the way the web's
//! `findReferenceGeneration` finds it: reading the history a page at a time
//! until a row lists the key. Shared by the composer's reference preview and
//! the results viewer's nested reference viewer.
//!
//! The reading is the last resort. An API output is first looked for in the
//! rows the results grid has loaded, and every answer — found or missing — is
//! kept for the session ([`SourceCache`]), so opening the same reference again,
//! or walking back up a trail of them, reads nothing.

use std::{
    collections::{HashMap, HashSet},
    sync::Arc,
};

use artsnack_backend::{
    Backend, CallError, NoArgs, Page, PaginatedQuery,
    api::{
        enhancements::{self, Enhancement},
        favorites::ToggleArgs,
        generations::{self, Generation},
        grok_generations::{self, ApiGeneration},
    },
};
use artsnack_library::{MediaCommand, ReproduceSource};
use artsnack_media::Media;
use artsnack_rules::Rules;
use gpui_kit::{App, AsyncApp, Global, SharedString};

/// Rows read per page while looking.
const PAGE: usize = 100;

/// The object key of `url` when it can be one of the app's outputs — the
/// web's `referenceOutputKey`. An upload (`grok-references/…`) or a foreign
/// URL has no generation to look for.
pub(crate) fn output_key(url: &str, cx: &App) -> Option<String> {
    let key = url
        .strip_prefix("/api/images/")
        .or_else(|| Media::urls(cx).key_of(url))?;
    let key = key.split(['?', '#']).next().unwrap_or_default();
    is_output_key(key, cx).then(|| key.to_string())
}

/// Whether `key` is under a prefix the app writes results to
/// (`OUTPUT_PREFIXES` in packages/shared/image-key.ts, or `generations/`).
pub(crate) fn is_output_key(key: &str, cx: &App) -> bool {
    if key.starts_with("generations/") {
        return true;
    }
    let prefixes: std::collections::HashMap<String, String> = Rules::global(cx)
        .and_then(|rules| rules.get("imageKey.OUTPUT_PREFIXES").ok())
        .unwrap_or_default();
    prefixes.values().any(|prefix| {
        key.strip_prefix(prefix.as_str())
            .is_some_and(|rest| rest.starts_with('/'))
    })
}

/// The generation a reference came from.
#[derive(Clone)]
pub(crate) enum Source {
    SelfHosted(Arc<Generation>),
    Enhancement(Arc<Enhancement>),
    Api(Arc<ApiGeneration>),
}

/// Where the lookup stands.
pub(crate) enum Lookup {
    /// Not one of the app's outputs (an uploaded file).
    NotOurs,
    Finding,
    Failed(SharedString),
    Missing,
    Found(Source),
}

impl Lookup {
    pub(crate) fn source(&self) -> Option<&Source> {
        match self {
            Lookup::Found(source) => Some(source),
            _ => None,
        }
    }
}

/// What Reproduce does with a source.
pub(crate) enum Reproduce {
    /// The API tab's own composer restores it.
    Api(Arc<ApiGeneration>),
    /// Another screen (Generate's self-hosted form, Enhance).
    Elsewhere(MediaCommand),
}

impl Source {
    /// The favourite toggle for the image `key`, naming the row it belongs to.
    pub(crate) fn toggle_args(&self, key: &str) -> ToggleArgs {
        let b2_key = key.to_string();
        match self {
            Source::Api(row) => ToggleArgs {
                api_generation_id: Some(row.id.clone()),
                b2_key,
                ..ToggleArgs::default()
            },
            Source::Enhancement(row) => ToggleArgs {
                enhancement_id: Some(row.id.clone()),
                b2_key,
                ..ToggleArgs::default()
            },
            Source::SelfHosted(row) => ToggleArgs {
                generation_id: Some(row.id.clone()),
                b2_key,
                ..ToggleArgs::default()
            },
        }
    }

    pub(crate) fn reproduce(&self) -> Reproduce {
        match self {
            Source::Api(row) => Reproduce::Api(row.clone()),
            Source::SelfHosted(row) => {
                Reproduce::Elsewhere(MediaCommand::Reproduce(ReproduceSource::SelfHosted {
                    form_state: row.form_state.to_value(),
                }))
            }
            Source::Enhancement(row) => {
                Reproduce::Elsewhere(MediaCommand::Reproduce(ReproduceSource::Enhancement {
                    enhancement_id: row.id.clone(),
                }))
            }
        }
    }
}

/// This session's answers, and the API rows the results grid has loaded.
#[derive(Default)]
struct SourceCache {
    found: HashMap<String, Source>,
    missing: HashSet<String>,
    loaded: Option<Arc<Vec<Arc<ApiGeneration>>>>,
}

impl Global for SourceCache {}

impl SourceCache {
    /// The answer without reading anything, when there is one.
    fn lookup(&self, key: &str) -> Option<Option<Source>> {
        // Loaded rows first: they are live, so a deleted row is not offered.
        if !key.starts_with("generations/")
            && let Some(row) = self.loaded.as_ref().and_then(|rows| {
                rows.iter()
                    .find(|row| !row.is_video() && row.outputs().contains(&key))
            })
        {
            return Some(Some(Source::Api(row.clone())));
        }
        if let Some(source) = self.found.get(key) {
            return Some(Some(source.clone()));
        }
        self.missing.contains(key).then_some(None)
    }
}

/// The API tab's loaded rows, for lookups to try before reading the history.
pub(crate) fn remember_loaded(rows: &Arc<Vec<Arc<ApiGeneration>>>, cx: &mut App) {
    cx.default_global::<SourceCache>().loaded = Some(rows.clone());
}

/// Forgets what was found for `key` (its generation was just deleted).
pub(crate) fn forget(key: &str, cx: &mut App) {
    if let Some(cache) = cx.try_global::<SourceCache>()
        && (cache.found.contains_key(key) || cache.missing.contains(key))
    {
        let cache = cx.global_mut::<SourceCache>();
        cache.found.remove(key);
        cache.missing.remove(key);
    }
}

/// The generation `key` came from: from what this session already knows, or
/// by reading the history that can hold it, page by page, until a row has it.
pub(crate) async fn find_source(key: &str, cx: &mut AsyncApp) -> Result<Option<Source>, CallError> {
    if let Some(known) = cx.update(|cx| {
        cx.try_global::<SourceCache>()
            .and_then(|cache| cache.lookup(key))
    }) {
        return Ok(known);
    }
    let found = read_source(key, cx).await?;
    cx.update(|cx| {
        let cache = cx.default_global::<SourceCache>();
        match &found {
            Some(source) => {
                cache.found.insert(key.to_string(), source.clone());
            }
            None => {
                cache.missing.insert(key.to_string());
            }
        }
    });
    Ok(found)
}

async fn read_source(key: &str, cx: &mut AsyncApp) -> Result<Option<Source>, CallError> {
    if key.starts_with("generations/") {
        let found = scan(generations::LIST_PAGINATED, cx, |row: &Generation| {
            row.b2_keys.iter().any(|candidate| candidate == key)
        })
        .await?;
        if let Some(row) = found {
            return Ok(Some(Source::SelfHosted(Arc::new(row))));
        }
        let found = scan(enhancements::LIST_PAGINATED, cx, |row: &Enhancement| {
            row.result_b2_key == key
        })
        .await?;
        return Ok(found.map(|row| Source::Enhancement(Arc::new(row))));
    }
    let found = scan(grok_generations::LIST, cx, |row: &ApiGeneration| {
        !row.is_video() && row.outputs().contains(&key)
    })
    .await?;
    Ok(found.map(|row| Source::Api(Arc::new(row))))
}

async fn scan<T: serde::de::DeserializeOwned + Send + 'static>(
    query: PaginatedQuery<NoArgs, T>,
    cx: &mut AsyncApp,
    matches: impl Fn(&T) -> bool,
) -> Result<Option<T>, CallError> {
    let mut cursor = None;
    loop {
        let page: Page<T> = cx
            .update(|cx| {
                Backend::global(cx).update(cx, |backend, cx| {
                    backend.query_page(query, &NoArgs {}, PAGE, cursor.take(), cx)
                })
            })
            .await?;
        let is_done = page.is_done;
        let next = page.continue_cursor;
        if let Some(found) = page.page.into_iter().find(|row| matches(row)) {
            return Ok(Some(found));
        }
        if is_done {
            return Ok(None);
        }
        cursor = Some(next);
    }
}
