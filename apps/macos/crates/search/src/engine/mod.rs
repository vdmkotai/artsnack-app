//! The search engine, ported from `packages/shared/search.ts`.
//!
//! The web, Convex and iOS run that file; this is a faithful Rust port rather
//! than a QuickJS call, because it walks the whole history on every keystroke
//! and QuickJS is several times too slow for that. The cases of
//! `packages/shared/search.test.ts` are ported in `tests.rs` and pin the two
//! together: change one, change both.
//!
//! Nothing here touches GPUI: the screen runs it on the background executor.

mod intent;
mod matching;
mod query;
mod text;

#[cfg(test)]
mod tests;

pub use intent::{
    LoraMode, Orientation, SEARCH_HISTORY_LIMIT, SEARCH_PROVIDERS, SearchFilters, SearchIntent,
    SearchSort, add_search_history, count_active_search_filters, deserialize_search_intent,
    parse_search_history, same_search_intent, search_history_from_value, serialize_search_intent,
};
pub use matching::{
    CatalogDocument, FacetValue, MAX_SEARCH_REFERENCES, MatchKind, MatchReason,
    NON_FACET_SEARCH_PARAMETERS, ResolvedOutput, SearchFacets, SearchOutput, SearchResult,
    TextMatches, build_search_facets, collect_parameter_facets, count_search_matches,
    count_search_matches_until, document_ratio, finish_search_until, match_search_text_until,
    matches_search_filters, reorder_search_references, resolve_search_output, search_documents,
    search_documents_until, search_intent_error, stabilize_search_results, toggle_search_reference,
};
pub use query::{
    ParsedSearchQuery, SearchGroup, SearchSyntaxError, SearchTerm, parse_search_query,
};
pub(crate) use text::is_js_space;
pub use text::{normalize_search_text, tokenize_search_text};
