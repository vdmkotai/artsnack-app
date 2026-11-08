//! The search catalogue: the user's whole history in memory (the web's
//! `components/search-catalog.tsx` and `lib/search-catalog.ts`).
//!
//! - Two paginated subscriptions, `searchCatalog.local` and
//!   `searchCatalog.hosted`, 256 rows a page, paged to the end as fast as they
//!   answer. Every page stays live.
//! - What they delivered is kept as a snapshot when they are released, so the
//!   next visit shows the full history at once and refreshes it ("refreshing…").
//!   A re-subscription pages in from the top: until it has read a table to the
//!   end, the snapshot fills in the older part it has not reached yet.
//! - A document keeps its [`CatalogDocument`] — and so its text index — for as
//!   long as its content is unchanged, even across a re-subscription.
//! - While pages are still arriving the documents are published at most every
//!   500 ms; the page that completes the catalogue, and every live change
//!   after it, at once. Merging runs on the background executor, one merge at
//!   a time; feeds that arrive during a merge wait for it and then for the
//!   same 500 ms, not merge straight after it.
//!
//! Whether to subscribe is the screen's call ([`SearchCatalog::warm`],
//! [`SearchCatalog::cool`]); a failed subscription stays released until
//! [`SearchCatalog::retry`].

use std::{
    collections::{HashMap, HashSet},
    sync::Arc,
    time::{Duration, Instant},
};

use artsnack_backend::{
    LivePaginatedQuery, NoArgs, PaginationStatus,
    api::search_catalog::{self, SearchDocument},
};
use gpui_kit::{AppContext as _, Context, Entity, SharedString, Subscription, Task};

use crate::engine::CatalogDocument;

/// Rows per page, as the web loads them.
const PAGE_SIZE: usize = 256;
/// How often a catalogue that is still paging in may be re-published.
const THROTTLE: Duration = Duration::from_millis(500);

pub type Documents = Arc<Vec<Arc<CatalogDocument>>>;

/// One table's subscription, as it stood when the catalogue last looked.
#[derive(Clone)]
struct Feed {
    /// `None` until the subscription has answered for itself (the rows it
    /// shows before that are a remembered copy).
    rows: Option<Arc<Vec<Arc<SearchDocument>>>>,
    /// Read to the end.
    done: bool,
}

impl Feed {
    fn of(query: &LivePaginatedQuery<SearchDocument>) -> Self {
        let status = query.status();
        let answered = !query.is_stale() && status != PaginationStatus::LoadingFirstPage;
        Self {
            rows: answered.then(|| query.rows().clone()),
            done: status == PaginationStatus::Exhausted,
        }
    }
}

/// Both tables' merged documents, and the index of who is who.
#[derive(Clone, Default)]
struct Snapshot {
    local: Documents,
    hosted: Documents,
    documents: Documents,
    known: Arc<HashMap<String, Arc<CatalogDocument>>>,
}

struct Live {
    local: Entity<LivePaginatedQuery<SearchDocument>>,
    hosted: Entity<LivePaginatedQuery<SearchDocument>>,
    _subscriptions: [Subscription; 2],
}

pub struct SearchCatalog {
    /// The screen wants the subscriptions (it is in use, or was recently).
    warm: bool,
    live: Option<Live>,
    snapshot: Snapshot,
    /// Bumped whenever `documents` changes.
    revision: u64,
    loading: bool,
    refreshing: bool,
    error: Option<SharedString>,
    /// The current subscription started over a non-empty snapshot.
    resumed: bool,
    /// The latest feeds not yet merged.
    pending: Option<(Option<Feed>, Option<Feed>)>,
    last_flush: Option<Instant>,
    flush_timer: Option<Task<()>>,
    merging: Option<Task<()>>,
}

impl SearchCatalog {
    pub fn new() -> Self {
        Self {
            warm: false,
            live: None,
            snapshot: Snapshot::default(),
            revision: 0,
            loading: true,
            refreshing: false,
            error: None,
            resumed: false,
            pending: None,
            last_flush: None,
            flush_timer: None,
            merging: None,
        }
    }

    pub fn documents(&self) -> &Documents {
        &self.snapshot.documents
    }

    pub fn revision(&self) -> u64 {
        self.revision
    }

    /// A subscription is paging in and has not read both tables yet.
    pub fn is_loading(&self) -> bool {
        self.loading
    }

    /// Loading, and part of what is shown is a snapshot from before.
    pub fn is_refreshing(&self) -> bool {
        self.refreshing
    }

    pub fn error(&self) -> Option<&SharedString> {
        self.error.as_ref()
    }

    pub fn is_warm(&self) -> bool {
        self.warm
    }

    /// Subscribes, unless already subscribed or released after a failure.
    pub fn warm(&mut self, cx: &mut Context<Self>) {
        if !self.warm {
            self.warm = true;
            self.connect(cx);
        }
    }

    /// Releases the subscriptions; what they delivered stays.
    pub fn cool(&mut self, cx: &mut Context<Self>) {
        if self.warm {
            self.warm = false;
            self.disconnect(cx);
        }
    }

    /// Subscribes afresh after a failure.
    pub fn retry(&mut self, cx: &mut Context<Self>) {
        self.disconnect(cx);
        self.warm = true;
        self.connect(cx);
    }

    fn connect(&mut self, cx: &mut Context<Self>) {
        let local = LivePaginatedQuery::new(search_catalog::LOCAL, &NoArgs {}, PAGE_SIZE, cx);
        let hosted = LivePaginatedQuery::new(search_catalog::HOSTED, &NoArgs {}, PAGE_SIZE, cx);
        let subscriptions = [
            cx.observe(&local, |this, _, cx| this.feeds_changed(cx)),
            cx.observe(&hosted, |this, _, cx| this.feeds_changed(cx)),
        ];
        self.live = Some(Live {
            local,
            hosted,
            _subscriptions: subscriptions,
        });
        self.last_flush = None;
        self.resumed = !self.snapshot.documents.is_empty();
        self.loading = true;
        self.refreshing = self.resumed;
        self.error = None;
        cx.notify();
        self.feeds_changed(cx);
    }

    /// Drops the subscriptions after taking what they hold, so nothing they
    /// delivered is lost from the snapshot.
    fn disconnect(&mut self, cx: &mut Context<Self>) {
        let Some(live) = self.live.take() else {
            return;
        };
        let feeds = (
            Some(Feed::of(live.local.read(cx))),
            Some(Feed::of(live.hosted.read(cx))),
        );
        drop(live);
        self.loading = false;
        self.refreshing = false;
        self.push(feeds, cx);
        cx.notify();
    }

    fn feeds_changed(&mut self, cx: &mut Context<Self>) {
        let Some(live) = &self.live else {
            return;
        };
        let (local, hosted) = (live.local.clone(), live.hosted.clone());
        let failure = [&local, &hosted].into_iter().find_map(|query| {
            let query = query.read(cx);
            (query.status() == PaginationStatus::Failed)
                .then(|| query.error().cloned().unwrap_or_default())
        });
        if let Some(message) = failure {
            self.disconnect(cx);
            self.error = Some(message);
            cx.notify();
            return;
        }
        // Full-history search: page both tables to the end.
        for query in [&local, &hosted] {
            if query.read(cx).status() == PaginationStatus::CanLoadMore {
                query.update(cx, |query, cx| query.load_more(PAGE_SIZE, cx));
            }
        }
        let feeds = (
            Some(Feed::of(local.read(cx))),
            Some(Feed::of(hosted.read(cx))),
        );
        self.push(feeds, cx);
    }

    fn push(&mut self, feeds: (Option<Feed>, Option<Feed>), cx: &mut Context<Self>) {
        // A new subscription that has not answered yet must not discard what a
        // released one handed over while a merge was still running.
        let feeds = match self.pending.take() {
            Some((local, hosted)) => (newest_rows(local, feeds.0), newest_rows(hosted, feeds.1)),
            None => feeds,
        };
        self.pending = Some(feeds);
        self.schedule_flush(cx);
    }

    /// Merges the pending feeds now if they complete the catalogue, if the
    /// subscriptions are gone, or if the last merge started 500 ms ago or
    /// more; otherwise once that time is up.
    fn schedule_flush(&mut self, cx: &mut Context<Self>) {
        let Some((local, hosted)) = &self.pending else {
            return;
        };
        let complete = [local, hosted]
            .into_iter()
            .all(|feed| feed.as_ref().is_some_and(|feed| feed.done));
        let wait = self
            .last_flush
            .map(|at| THROTTLE.saturating_sub(at.elapsed()))
            .unwrap_or_default();
        if complete || wait.is_zero() || self.live.is_none() {
            self.flush(cx);
        } else if self.flush_timer.is_none() {
            self.flush_timer = Some(cx.spawn(async move |this, cx| {
                cx.background_executor().timer(wait).await;
                let _ = this.update(cx, |this, cx| {
                    this.flush_timer = None;
                    this.flush(cx);
                });
            }));
        }
    }

    /// Merges the pending feeds off the main thread. One merge at a time, each
    /// on top of the last one's result; feeds that arrive meanwhile wait.
    fn flush(&mut self, cx: &mut Context<Self>) {
        if self.merging.is_some() {
            return;
        }
        let Some((local, hosted)) = self.pending.take() else {
            return;
        };
        self.flush_timer = None;
        self.last_flush = Some(Instant::now());
        let complete = [&local, &hosted]
            .into_iter()
            .all(|feed| feed.as_ref().is_some_and(|feed| feed.done));
        let snapshot = self.snapshot.clone();
        let merged = cx.background_spawn(async move { merge(&snapshot, local, hosted) });
        self.merging = Some(cx.spawn(async move |this, cx| {
            let merged = merged.await;
            let _ = this.update(cx, |this, cx| {
                this.merging = None;
                this.apply(merged, complete, cx);
                // Feeds that arrived meanwhile keep to the throttle.
                this.schedule_flush(cx);
            });
        }));
    }

    fn apply(&mut self, merged: Snapshot, complete: bool, cx: &mut Context<Self>) {
        let changed = !Arc::ptr_eq(&merged.documents, &self.snapshot.documents);
        self.snapshot = merged;
        let loading = self.live.is_some() && !complete;
        let refreshing = loading && self.resumed;
        if changed {
            self.revision += 1;
        }
        if changed || loading != self.loading || refreshing != self.refreshing {
            self.loading = loading;
            self.refreshing = refreshing;
            cx.notify();
        }
    }
}

/// `next`, unless it holds no rows and `previous` does.
fn newest_rows(previous: Option<Feed>, next: Option<Feed>) -> Option<Feed> {
    let next_answered = next.as_ref().is_some_and(|feed| feed.rows.is_some());
    let previous_answered = previous.as_ref().is_some_and(|feed| feed.rows.is_some());
    if !next_answered && previous_answered {
        previous
    } else {
        next
    }
}

/// The next snapshot: each table's fresh pages over what was retained.
fn merge(snapshot: &Snapshot, local: Option<Feed>, hosted: Option<Feed>) -> Snapshot {
    let local = merge_table(&snapshot.local, local, &snapshot.known);
    let hosted = merge_table(&snapshot.hosted, hosted, &snapshot.known);
    if Arc::ptr_eq(&local, &snapshot.local) && Arc::ptr_eq(&hosted, &snapshot.hosted) {
        return snapshot.clone();
    }
    let documents: Vec<_> = local.iter().chain(hosted.iter()).cloned().collect();
    let known = documents
        .iter()
        .map(|document| (document.document().id.clone(), document.clone()))
        .collect();
    Snapshot {
        local,
        hosted,
        documents: Arc::new(documents),
        known: Arc::new(known),
    }
}

fn merge_table(
    retained: &Documents,
    feed: Option<Feed>,
    known: &HashMap<String, Arc<CatalogDocument>>,
) -> Documents {
    let Some(Feed {
        rows: Some(rows),
        done,
    }) = feed
    else {
        return retained.clone();
    };
    let fresh: Vec<Arc<CatalogDocument>> =
        rows.iter().map(|row| stable_document(row, known)).collect();
    let merged = merge_catalog_feed(
        &fresh,
        done,
        retained,
        |document| &document.document().id,
        |document| document.document().created_at,
    );
    let unchanged = merged.len() == retained.len()
        && merged
            .iter()
            .zip(retained.iter())
            .all(|(new, old)| Arc::ptr_eq(new, old));
    if unchanged {
        retained.clone()
    } else {
        Arc::new(merged)
    }
}

/// The known document for `row` when its content is unchanged — the same row
/// value, or an equal one (a re-sent page, a re-subscription) — else a new one.
fn stable_document(
    row: &Arc<SearchDocument>,
    known: &HashMap<String, Arc<CatalogDocument>>,
) -> Arc<CatalogDocument> {
    match known.get(&row.id) {
        Some(existing)
            if Arc::ptr_eq(existing.document(), row) || **existing.document() == **row =>
        {
            existing.clone()
        }
        _ => Arc::new(CatalogDocument::new(row.clone())),
    }
}

/// Fresh pages first, then the retained documents older than anything fresh —
/// the part of the history a re-subscription has not paged back to yet
/// (`mergeCatalogFeed`).
///
/// Both tables are read newest first, so "older than the oldest fresh
/// document" is exactly the region the fresh pages cannot speak for. A
/// retained document inside the fresh region that is no longer in it was
/// deleted or failed, and is dropped. Once the feed is done the fresh pages
/// are the whole truth.
fn merge_catalog_feed<T: Clone>(
    fresh: &[T],
    done: bool,
    retained: &[T],
    id: impl Fn(&T) -> &str,
    created_at: impl Fn(&T) -> f64,
) -> Vec<T> {
    if done || retained.is_empty() {
        return fresh.to_vec();
    }
    if fresh.is_empty() {
        return retained.to_vec();
    }
    let oldest = fresh.iter().map(&created_at).fold(f64::INFINITY, f64::min);
    let ids: HashSet<&str> = fresh.iter().map(&id).collect();
    let mut merged = fresh.to_vec();
    merged.extend(
        retained
            .iter()
            .filter(|document| created_at(document) < oldest && !ids.contains(id(document)))
            .cloned(),
    );
    merged
}

#[cfg(test)]
mod tests {
    use artsnack_backend::api::{
        favorites::MediaType,
        search_catalog::{SearchAsset, SearchSource},
    };

    use super::*;

    fn doc(id: &str, created_at: f64) -> Arc<SearchDocument> {
        Arc::new(SearchDocument {
            id: id.into(),
            source: SearchSource::SelfHosted,
            provider: "self-hosted".into(),
            media_type: MediaType::Image,
            created_at,
            prompt: format!("prompt {id}"),
            negative_prompt: None,
            assets: vec![SearchAsset {
                id: "0".into(),
                key: format!("{id}.webp"),
                thumbnail_key: None,
            }],
            model: None,
            model_label: None,
            model_family: None,
            checkpoints: Vec::new(),
            loras: Vec::new(),
            width: None,
            height: None,
            aspect_ratio: None,
            resolution: None,
            quality: None,
            duration: None,
            has_references: false,
            sampler: None,
            scheduler: None,
            steps: None,
            cfg: None,
            seed: None,
            parameters: None,
            local_settings: None,
        })
    }

    fn ids(documents: &[Arc<SearchDocument>]) -> Vec<&str> {
        documents
            .iter()
            .map(|document| document.id.as_str())
            .collect()
    }

    fn merged(fresh: &[Arc<SearchDocument>], done: bool) -> Vec<Arc<SearchDocument>> {
        let retained = [doc("c", 30.0), doc("b", 20.0), doc("a", 10.0)];
        merge_catalog_feed(
            fresh,
            done,
            &retained,
            |document| &document.id,
            |document| document.created_at,
        )
    }

    #[test]
    fn a_finished_feed_is_the_whole_truth() {
        assert_eq!(ids(&merged(&[doc("c", 30.0)], true)), ["c"]);
    }

    #[test]
    fn an_empty_still_loading_feed_keeps_the_snapshot() {
        assert_eq!(ids(&merged(&[], false)), ["c", "b", "a"]);
    }

    #[test]
    fn fresh_pages_replace_their_region_and_the_snapshot_fills_in_the_older_rest() {
        // c sits inside the fresh region but is no longer in it: deleted, so dropped.
        assert_eq!(
            ids(&merged(&[doc("d", 40.0), doc("b", 20.0)], false)),
            ["d", "b", "a"]
        );
    }

    fn feed(rows: &[Arc<SearchDocument>], done: bool) -> Option<Feed> {
        Some(Feed {
            rows: Some(Arc::new(rows.to_vec())),
            done,
        })
    }

    #[test]
    fn reuses_unchanged_documents_and_the_previous_list() {
        let first = merge(
            &Snapshot::default(),
            feed(&[doc("a", 1.0), doc("b", 2.0)], true),
            None,
        );
        // Equal values from a re-sent page keep their indexed documents.
        let same = merge(&first, feed(&[doc("a", 1.0), doc("b", 2.0)], true), None);
        assert!(Arc::ptr_eq(&same.documents, &first.documents));

        let mut edited = (*doc("b", 2.0)).clone();
        edited.prompt = "edited".into();
        let changed = merge(&first, feed(&[doc("a", 1.0), Arc::new(edited)], true), None);
        assert!(!Arc::ptr_eq(&changed.documents, &first.documents));
        assert!(Arc::ptr_eq(&changed.documents[0], &first.documents[0]));
        assert!(!Arc::ptr_eq(&changed.documents[1], &first.documents[1]));
        assert_eq!(changed.known["b"].document().prompt, "edited");
    }

    #[test]
    fn a_feed_that_has_not_answered_keeps_the_snapshot() {
        let first = merge(&Snapshot::default(), feed(&[doc("a", 1.0)], true), None);
        let waiting = Some(Feed {
            rows: None,
            done: false,
        });
        let next = merge(&first, waiting, None);
        assert!(Arc::ptr_eq(&next.documents, &first.documents));
    }
}
