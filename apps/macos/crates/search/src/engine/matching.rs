//! The search itself (`searchDocuments` and friends): text matching and
//! scoring, filters, facets, sorting, and one result per asset.
//!
//! Documents are generation-sized: a four-image generation carries its prompt
//! once and expands into four results only after it matched.
//!
//! A search runs in two phases. The text phase ([`match_search_text_until`])
//! reads every prompt and counts the facets; it depends only on the queries
//! and typo tolerance, so a change of filters or sort reuses it. The rest
//! ([`finish_search_until`]) filters, sorts and expands. Both look for a
//! newer search at every phase and every few hundred items.

use std::{
    collections::{BTreeMap, HashMap},
    sync::{Arc, OnceLock},
};

use artsnack_backend::api::{
    favorites::MediaType,
    search_catalog::{SearchAsset, SearchDocument},
};

use super::{
    intent::{LoraMode, Orientation, SearchFilters, SearchIntent, SearchSort},
    query::{ParsedSearchQuery, SearchSyntaxError, SearchTerm, parse_search_query},
    text::{CollationKey, FuzzyTerm, IndexedText, compare_numbers},
};

/// The most images the reference tray holds.
pub const MAX_SEARCH_REFERENCES: usize = 30;

/// A catalogue document with its text index, built on first use.
///
/// The catalogue keeps one of these per document for as long as the document
/// is unchanged, so a prompt is normalised once per session, on whichever
/// background thread first searches it, rather than once per keystroke.
#[derive(Debug)]
pub struct CatalogDocument {
    document: Arc<SearchDocument>,
    prompt: OnceLock<IndexedText>,
    negative: OnceLock<IndexedText>,
}

impl CatalogDocument {
    pub fn new(document: Arc<SearchDocument>) -> Self {
        Self {
            document,
            prompt: OnceLock::new(),
            negative: OnceLock::new(),
        }
    }

    pub fn document(&self) -> &Arc<SearchDocument> {
        &self.document
    }

    fn prompt(&self) -> &IndexedText {
        self.prompt
            .get_or_init(|| IndexedText::new(&self.document.prompt))
    }

    fn negative(&self) -> &IndexedText {
        self.negative.get_or_init(|| {
            IndexedText::new(self.document.negative_prompt.as_deref().unwrap_or(""))
        })
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MatchKind {
    Phrase,
    Token,
    Contains,
    Fuzzy,
}

impl MatchKind {
    pub fn as_str(self) -> &'static str {
        match self {
            MatchKind::Phrase => "phrase",
            MatchKind::Token => "token",
            MatchKind::Contains => "contains",
            MatchKind::Fuzzy => "fuzzy",
        }
    }
}

/// Why a document matched one requirement.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MatchReason {
    pub term: Arc<str>,
    pub kind: MatchKind,
}

/// One asset of a matching document.
#[derive(Clone, Debug)]
pub struct SearchResult {
    pub document: Arc<SearchDocument>,
    /// Index into `document.assets`.
    pub asset_ix: usize,
    pub score: u32,
    /// Shared by every asset of the document.
    pub reasons: Arc<[MatchReason]>,
}

impl SearchResult {
    pub fn asset(&self) -> &SearchAsset {
        &self.document.assets[self.asset_ix]
    }

    /// `{document id}:{asset id}`: the result's identity across searches.
    pub fn id(&self) -> String {
        format!("{}:{}", self.document.id, self.asset().id)
    }

    pub fn has_id(&self, other: &SearchResult) -> bool {
        self.document.id == other.document.id && self.asset().id == other.asset().id
    }

    /// The same document value, asset, score and reasons: nothing about this
    /// result's tile changed.
    pub fn is_same(&self, other: &SearchResult) -> bool {
        Arc::ptr_eq(&self.document, &other.document)
            && self.asset_ix == other.asset_ix
            && self.score == other.score
            && self.reasons == other.reasons
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FacetValue {
    pub value: String,
    pub count: usize,
}

/// Value counts over the documents whose text matched, before filters, so a
/// filter never hides its own alternatives.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct SearchFacets {
    pub media_types: Vec<FacetValue>,
    pub sources: Vec<FacetValue>,
    pub providers: Vec<FacetValue>,
    pub models: Vec<FacetValue>,
    pub model_families: Vec<FacetValue>,
    pub checkpoints: Vec<FacetValue>,
    pub loras: Vec<FacetValue>,
    pub resolutions: Vec<FacetValue>,
    pub qualities: Vec<FacetValue>,
    pub samplers: Vec<FacetValue>,
    pub schedulers: Vec<FacetValue>,
    pub parameters: BTreeMap<String, Vec<FacetValue>>,
}

#[derive(Clone, Debug, Default)]
pub struct SearchOutput {
    pub results: Arc<Vec<SearchResult>>,
    /// The matching generations, in result order.
    pub documents: Vec<Arc<SearchDocument>>,
    pub facets: Arc<SearchFacets>,
    pub parsed: ParsedSearchQuery,
}

/// A parsed query with each term measured once for the typo rule, rather
/// than once per document and token.
struct PreparedQuery<'a> {
    groups: Vec<(bool, Vec<(&'a SearchTerm, FuzzyTerm<'a>)>)>,
}

impl<'a> PreparedQuery<'a> {
    fn new(parsed: &'a ParsedSearchQuery) -> Self {
        Self {
            groups: parsed
                .groups
                .iter()
                .map(|group| {
                    let terms = group
                        .alternatives
                        .iter()
                        .map(|term| (term, FuzzyTerm::new(&term.value)))
                        .collect();
                    (group.excluded, terms)
                })
                .collect(),
        }
    }

    fn is_empty(&self) -> bool {
        self.groups.is_empty()
    }
}

fn term_match(
    text: &IndexedText,
    term: &SearchTerm,
    fuzzy: &FuzzyTerm,
    allow_typos: bool,
) -> Option<(u32, MatchKind)> {
    let phrase = term.value.contains(' ');
    if term.quoted {
        if phrase && text.contains(&term.value) {
            return Some((400, MatchKind::Phrase));
        }
        if !phrase && text.has_token(&term.value) {
            return Some((300, MatchKind::Token));
        }
        return None;
    }
    if text.has_token(&term.value) {
        return Some((300, MatchKind::Token));
    }
    if text.contains(&term.value) {
        return Some((200, MatchKind::Contains));
    }
    if allow_typos && fuzzy.units() >= 5 && text.tokens().any(|token| fuzzy.is_within_one_of(token))
    {
        return Some((100, MatchKind::Fuzzy));
    }
    None
}

/// Every requirement met and no exclusion hit: the summed score of each
/// requirement's best alternative (the first, on a tie), with its reason.
fn match_parsed(
    text: &IndexedText,
    parsed: &PreparedQuery,
    allow_typos: bool,
) -> Option<(u32, Vec<MatchReason>)> {
    let mut score = 0;
    let mut reasons = Vec::new();
    for (excluded, alternatives) in &parsed.groups {
        let excluded = *excluded;
        let mut best: Option<(u32, &SearchTerm, MatchKind)> = None;
        for (term, fuzzy) in alternatives {
            let Some((term_score, kind)) = term_match(text, term, fuzzy, !excluded && allow_typos)
            else {
                continue;
            };
            if excluded {
                return None;
            }
            if best.is_none_or(|(best_score, _, _)| term_score > best_score) {
                best = Some((term_score, term, kind));
            }
        }
        if excluded {
            continue;
        }
        let (term_score, term, kind) = best?;
        score += term_score;
        reasons.push(MatchReason {
            term: term.value.clone(),
            kind,
        });
    }
    Some((score, reasons))
}

/// `Number(text)` for the parts of an `"W:H"` ratio.
fn js_parse_number(text: &str) -> f64 {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        0.0
    } else {
        trimmed.parse().unwrap_or(f64::NAN)
    }
}

/// Width ÷ height from the size, else from an `"W:H"` ratio.
pub fn document_ratio(document: &SearchDocument) -> Option<f64> {
    if let (Some(width), Some(height)) = (document.width, document.height)
        && truthy(width)
        && truthy(height)
    {
        return Some(width / height);
    }
    let ratio = document.aspect_ratio.as_deref()?;
    let mut parts = ratio.split(':').map(js_parse_number);
    let width = parts.next().unwrap_or(f64::NAN);
    let height = parts.next().unwrap_or(f64::NAN);
    (width > 0.0 && height > 0.0).then(|| width / height)
}

/// JavaScript truthiness for a number.
fn truthy(value: f64) -> bool {
    value != 0.0 && !value.is_nan()
}

fn orientation_of(document: &SearchDocument) -> Option<Orientation> {
    let ratio = document_ratio(document)?;
    Some(if ratio > 1.05 {
        Orientation::Landscape
    } else if ratio < 0.95 {
        Orientation::Portrait
    } else {
        Orientation::Square
    })
}

/// No selection, or the document's value is one of it. An empty value counts
/// as none, as `!document.model` does on the web.
fn listed(selected: &[String], value: Option<&String>) -> bool {
    selected.is_empty() || value.is_some_and(|value| !value.is_empty() && selected.contains(value))
}

/// `(value ?? -Infinity) < min` excludes; a NaN value compares false, so it
/// stays.
fn at_least(value: Option<f64>, min: Option<f64>) -> bool {
    let value = value.unwrap_or(f64::NEG_INFINITY);
    min.is_none_or(|min| value >= min || value.is_nan())
}

fn at_most(value: Option<f64>, max: Option<f64>) -> bool {
    let value = value.unwrap_or(f64::INFINITY);
    max.is_none_or(|max| value <= max || value.is_nan())
}

pub fn matches_search_filters(document: &SearchDocument, filters: &SearchFilters) -> bool {
    if !filters.media_types.is_empty() && !filters.media_types.contains(&document.media_type) {
        return false;
    }
    if !filters.sources.is_empty() && !filters.sources.contains(&document.source) {
        return false;
    }
    if !filters.providers.is_empty() && !filters.providers.contains(&document.provider) {
        return false;
    }
    if !listed(&filters.models, document.model.as_ref()) {
        return false;
    }
    if !listed(&filters.model_families, document.model_family.as_ref()) {
        return false;
    }
    if !filters.checkpoints.is_empty()
        && !filters
            .checkpoints
            .iter()
            .any(|checkpoint| document.checkpoints.contains(checkpoint))
    {
        return false;
    }
    if !filters.loras.is_empty() {
        let matches = filters
            .loras
            .iter()
            .filter(|lora| document.loras.contains(lora))
            .count();
        let fails = match filters.lora_mode {
            LoraMode::All => matches != filters.loras.len(),
            LoraMode::Any => matches == 0,
        };
        if fails {
            return false;
        }
    }
    if filters
        .created_after
        .is_some_and(|after| document.created_at < after)
    {
        return false;
    }
    if filters
        .created_before
        .is_some_and(|before| document.created_at > before)
    {
        return false;
    }
    if !filters.orientations.is_empty()
        && !orientation_of(document)
            .is_some_and(|orientation| filters.orientations.contains(&orientation))
    {
        return false;
    }
    if !listed(&filters.resolutions, document.resolution.as_ref())
        || !listed(&filters.qualities, document.quality.as_ref())
    {
        return false;
    }
    if !at_least(document.duration, filters.duration_min)
        || !at_most(document.duration, filters.duration_max)
    {
        return false;
    }
    if filters
        .has_references
        .is_some_and(|has| document.has_references != has)
    {
        return false;
    }
    if !listed(&filters.samplers, document.sampler.as_ref())
        || !listed(&filters.schedulers, document.scheduler.as_ref())
    {
        return false;
    }
    if !at_least(document.steps, filters.steps_min)
        || !at_most(document.steps, filters.steps_max)
        || !at_least(document.cfg, filters.cfg_min)
        || !at_most(document.cfg, filters.cfg_max)
    {
        return false;
    }
    if filters.seed.is_some() && document.seed != filters.seed {
        return false;
    }
    if !at_least(document.width, filters.width_min)
        || !at_most(document.width, filters.width_max)
        || !at_least(document.height, filters.height_min)
        || !at_most(document.height, filters.height_max)
    {
        return false;
    }
    for (name, selected) in &filters.parameters {
        if selected.is_empty() {
            continue;
        }
        let values = document
            .parameters
            .as_ref()
            .and_then(|parameters| parameters.get(name))
            .map(|value| value.strings())
            .unwrap_or_default();
        if !selected.iter().any(|value| values.contains(value)) {
            return false;
        }
    }
    true
}

/// Provider parameters that are free text or media, never a filter value.
/// Counting them meant one facet entry per prompt in the history; filtering by
/// them still works, since [`matches_search_filters`] reads the document.
pub const NON_FACET_SEARCH_PARAMETERS: [&str; 5] = ["prompt", "image", "images", "video", "url"];

#[derive(Default)]
struct Counts<'a>(HashMap<&'a str, usize>);

impl<'a> Counts<'a> {
    /// Empty values are not counted (`if (value)`).
    fn add(&mut self, value: Option<&'a str>) {
        if let Some(value) = value.filter(|value| !value.is_empty()) {
            *self.0.entry(value).or_default() += 1;
        }
    }

    fn sorted(self) -> Vec<FacetValue> {
        sorted_facet(
            self.0
                .into_iter()
                .map(|(value, count)| (value.to_string(), count)),
        )
    }
}

/// Most frequent first; ties in collation order.
fn sorted_facet(counts: impl Iterator<Item = (String, usize)>) -> Vec<FacetValue> {
    let mut values: Vec<FacetValue> = counts
        .map(|(value, count)| FacetValue { value, count })
        .collect();
    values.sort_by_cached_key(|facet| {
        (
            std::cmp::Reverse(facet.count),
            CollationKey::new(&facet.value),
        )
    });
    values
}

/// Every provider parameter value's count, by parameter name. A parameter
/// seen only with empty values is still listed, with no values.
pub fn collect_parameter_facets<'a>(
    documents: impl IntoIterator<Item = &'a SearchDocument>,
) -> BTreeMap<String, Vec<FacetValue>> {
    let mut counts: BTreeMap<&str, HashMap<String, usize>> = BTreeMap::new();
    for document in documents {
        let Some(parameters) = &document.parameters else {
            continue;
        };
        for (name, raw) in parameters {
            if NON_FACET_SEARCH_PARAMETERS.contains(&name.as_str()) {
                continue;
            }
            let entry = counts.entry(name.as_str()).or_default();
            for value in raw.strings() {
                if !value.is_empty() {
                    *entry.entry(value).or_default() += 1;
                }
            }
        }
    }
    counts
        .into_iter()
        .map(|(name, values)| (name.to_string(), sorted_facet(values.into_iter())))
        .collect()
}

fn media_type_name(media_type: MediaType) -> &'static str {
    match media_type {
        MediaType::Image => "image",
        MediaType::Video => "video",
    }
}

pub fn build_search_facets<'a>(
    documents: impl IntoIterator<Item = &'a SearchDocument> + Clone,
) -> SearchFacets {
    let mut media_types = Counts::default();
    let mut sources = Counts::default();
    let mut providers = Counts::default();
    let mut models = Counts::default();
    let mut model_families = Counts::default();
    let mut checkpoints = Counts::default();
    let mut loras = Counts::default();
    let mut resolutions = Counts::default();
    let mut qualities = Counts::default();
    let mut samplers = Counts::default();
    let mut schedulers = Counts::default();
    for document in documents.clone() {
        media_types.add(Some(media_type_name(document.media_type)));
        sources.add(Some(document.source.as_str()));
        providers.add(Some(document.provider.as_str()));
        models.add(document.model.as_deref());
        model_families.add(document.model_family.as_deref());
        for checkpoint in &document.checkpoints {
            checkpoints.add(Some(checkpoint.as_str()));
        }
        for lora in &document.loras {
            loras.add(Some(lora.as_str()));
        }
        resolutions.add(document.resolution.as_deref());
        qualities.add(document.quality.as_deref());
        samplers.add(document.sampler.as_deref());
        schedulers.add(document.scheduler.as_deref());
    }
    SearchFacets {
        media_types: media_types.sorted(),
        sources: sources.sorted(),
        providers: providers.sorted(),
        models: models.sorted(),
        model_families: model_families.sorted(),
        checkpoints: checkpoints.sorted(),
        loras: loras.sorted(),
        resolutions: resolutions.sorted(),
        qualities: qualities.sorted(),
        samplers: samplers.sorted(),
        schedulers: schedulers.sorted(),
        parameters: collect_parameter_facets(documents),
    }
}

/// How often a long loop looks for a newer search that replaced it.
const CANCEL_CHECK_EVERY: usize = 512;

/// The text phase of a search: every document whose prompt (and stored
/// negative prompt) matched, with its score and reasons, and the facets over
/// them. It depends on the query, the negative query and typo tolerance only.
#[derive(Debug)]
pub struct TextMatches {
    matches: Vec<(Arc<SearchDocument>, u32, Arc<[MatchReason]>)>,
    facets: Arc<SearchFacets>,
    parsed: ParsedSearchQuery,
}

/// The text phase of [`search_documents`], giving up (`None`) as soon as
/// `cancelled` says a newer search has replaced this one.
pub fn match_search_text_until(
    documents: &[Arc<CatalogDocument>],
    intent: &SearchIntent,
    cancelled: impl Fn() -> bool,
) -> Option<Result<TextMatches, SearchSyntaxError>> {
    let positive = match parse_search_query(&intent.query) {
        Ok(parsed) => parsed,
        Err(error) => return Some(Err(error)),
    };
    let negative = match parse_search_query(&intent.negative_prompt_query) {
        Ok(parsed) => parsed,
        Err(error) => return Some(Err(error)),
    };
    let prepared_positive = PreparedQuery::new(&positive);
    let prepared_negative = PreparedQuery::new(&negative);

    let none: Arc<[MatchReason]> = Arc::from(Vec::new());
    let mut matches = Vec::new();
    for (ix, catalog) in documents.iter().enumerate() {
        if ix % CANCEL_CHECK_EVERY == 0 && cancelled() {
            return None;
        }
        if catalog.document.assets.is_empty() {
            continue;
        }
        let Some((score, reasons)) =
            match_parsed(catalog.prompt(), &prepared_positive, intent.allow_typos)
        else {
            continue;
        };
        if !prepared_negative.is_empty()
            && match_parsed(catalog.negative(), &prepared_negative, false).is_none()
        {
            continue;
        }
        let reasons = if reasons.is_empty() {
            none.clone()
        } else {
            Arc::from(reasons)
        };
        matches.push((catalog.document.clone(), score, reasons));
    }
    if cancelled() {
        return None;
    }
    let facets = build_search_facets(matches.iter().map(|(document, _, _)| document.as_ref()));
    if cancelled() {
        return None;
    }
    Some(Ok(TextMatches {
        matches,
        facets: Arc::new(facets),
        parsed: positive,
    }))
}

/// The rest of [`search_documents`] over a text phase: filters, sort, and
/// one result per asset. `None` when `cancelled` cut it short.
pub fn finish_search_until(
    text: &TextMatches,
    intent: &SearchIntent,
    cancelled: impl Fn() -> bool,
) -> Option<SearchOutput> {
    let mut filtered = Vec::new();
    for (ix, entry) in text.matches.iter().enumerate() {
        if ix % CANCEL_CHECK_EVERY == 0 && cancelled() {
            return None;
        }
        if matches_search_filters(&entry.0, &intent.filters) {
            filtered.push(entry);
        }
    }
    if cancelled() {
        return None;
    }
    // Stable, as JavaScript's sort is: equal keys keep catalogue order.
    filtered.sort_by(
        |(left, left_score, _), (right, right_score, _)| match intent.sort {
            SearchSort::Oldest => compare_numbers(left.created_at, right.created_at),
            SearchSort::Newest => compare_numbers(right.created_at, left.created_at),
            SearchSort::Relevance => right_score
                .cmp(left_score)
                .then_with(|| compare_numbers(right.created_at, left.created_at)),
        },
    );
    if cancelled() {
        return None;
    }

    let mut results = Vec::with_capacity(filtered.len());
    let mut matched = Vec::with_capacity(filtered.len());
    for (ix, (document, score, reasons)) in filtered.into_iter().enumerate() {
        if ix % CANCEL_CHECK_EVERY == 0 && cancelled() {
            return None;
        }
        for asset_ix in 0..document.assets.len() {
            results.push(SearchResult {
                document: document.clone(),
                asset_ix,
                score: *score,
                reasons: reasons.clone(),
            });
        }
        matched.push(document.clone());
    }
    Some(SearchOutput {
        results: Arc::new(results),
        documents: matched,
        facets: text.facets.clone(),
        parsed: text.parsed.clone(),
    })
}

/// [`search_documents`], giving up (`None`) as soon as `cancelled` says a newer
/// search has replaced this one.
pub fn search_documents_until(
    documents: &[Arc<CatalogDocument>],
    intent: &SearchIntent,
    cancelled: impl Fn() -> bool,
) -> Option<Result<SearchOutput, SearchSyntaxError>> {
    let text = match match_search_text_until(documents, intent, &cancelled)? {
        Ok(text) => text,
        Err(error) => return Some(Err(error)),
    };
    finish_search_until(&text, intent, cancelled).map(Ok)
}

pub fn search_documents(
    documents: &[Arc<CatalogDocument>],
    intent: &SearchIntent,
) -> Result<SearchOutput, SearchSyntaxError> {
    search_documents_until(documents, intent, || false).expect("never cancelled")
}

/// How many media [`search_documents`] would return, without its facets,
/// sorting and expansion: the filter drawer's live count. A malformed query
/// counts as 0. `None` when `cancelled` cut it short.
pub fn count_search_matches_until(
    documents: &[Arc<CatalogDocument>],
    intent: &SearchIntent,
    cancelled: impl Fn() -> bool,
) -> Option<usize> {
    let (Ok(positive), Ok(negative)) = (
        parse_search_query(&intent.query),
        parse_search_query(&intent.negative_prompt_query),
    ) else {
        return Some(0);
    };
    let (positive, negative) = (PreparedQuery::new(&positive), PreparedQuery::new(&negative));
    let mut count = 0;
    for (ix, catalog) in documents.iter().enumerate() {
        if ix % CANCEL_CHECK_EVERY == 0 && cancelled() {
            return None;
        }
        let document = &catalog.document;
        if document.assets.is_empty() || !matches_search_filters(document, &intent.filters) {
            continue;
        }
        if match_parsed(catalog.prompt(), &positive, intent.allow_typos).is_none() {
            continue;
        }
        if !negative.is_empty() && match_parsed(catalog.negative(), &negative, false).is_none() {
            continue;
        }
        count += document.assets.len();
    }
    Some(count)
}

pub fn count_search_matches(documents: &[Arc<CatalogDocument>], intent: &SearchIntent) -> usize {
    count_search_matches_until(documents, intent, || false).unwrap_or(0)
}

/// The message a malformed positive or negative query reports.
pub fn search_intent_error(intent: &SearchIntent) -> Option<&'static str> {
    parse_search_query(&intent.query)
        .and_then(|_| parse_search_query(&intent.negative_prompt_query))
        .err()
        .map(|error| error.message)
}

/// The previous results when nothing about them changed, so an unchanged
/// search (a catalogue page that changed nothing visible) leaves the grid
/// alone. Only holds when the catalogue keeps document identity, which it does.
pub fn stabilize_search_results(
    previous: &Arc<Vec<SearchResult>>,
    next: Arc<Vec<SearchResult>>,
) -> Arc<Vec<SearchResult>> {
    let unchanged = previous.len() == next.len()
        && previous
            .iter()
            .zip(next.iter())
            .all(|(before, after)| before.is_same(after));
    if unchanged { previous.clone() } else { next }
}

/// What the screen shows for an intent: its output, or — while it has a
/// syntax error — the last valid output and the error.
pub struct ResolvedOutput {
    pub output: Arc<SearchOutput>,
    pub syntax_error: Option<&'static str>,
    pub last_valid: Arc<SearchOutput>,
}

pub fn resolve_search_output(
    documents: &[Arc<CatalogDocument>],
    intent: &SearchIntent,
    last_valid: Arc<SearchOutput>,
) -> ResolvedOutput {
    match search_documents(documents, intent) {
        Ok(output) => {
            let output = Arc::new(output);
            ResolvedOutput {
                output: output.clone(),
                syntax_error: None,
                last_valid: output,
            }
        }
        Err(error) => ResolvedOutput {
            output: last_valid.clone(),
            syntax_error: Some(error.message),
            last_valid,
        },
    }
}

/// Adds or removes a reference. Only images, and at most `limit`.
pub fn toggle_search_reference(
    current: &[SearchResult],
    result: &SearchResult,
    limit: usize,
) -> Vec<SearchResult> {
    if current.iter().any(|entry| entry.has_id(result)) {
        return current
            .iter()
            .filter(|entry| !entry.has_id(result))
            .cloned()
            .collect();
    }
    if result.document.media_type != MediaType::Image || current.len() >= limit {
        return current.to_vec();
    }
    let mut next = current.to_vec();
    next.push(result.clone());
    next
}

/// Moves the reference at `from` to `to`; out-of-range positions change nothing.
pub fn reorder_search_references(
    current: &[SearchResult],
    from: usize,
    to: usize,
) -> Vec<SearchResult> {
    let mut next = current.to_vec();
    if from != to && from < next.len() && to < next.len() {
        let entry = next.remove(from);
        next.insert(to, entry);
    }
    next
}
