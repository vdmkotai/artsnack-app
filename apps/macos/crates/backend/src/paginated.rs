//! Paginated live queries: the native `usePaginatedQuery`.
//!
//! Each page is its own subscription with `paginationOpts`. The state machine
//! follows Convex's React hook (convex@1.42.3 `use_paginated_query.js`):
//! `loadMore` adds a page after the last one; a page that grew too large is
//! split in two, and the original keeps showing until both halves answer; an
//! `InvalidCursor` error starts over.
//!
//! One difference: the JS client keeps each page's *journal* and resends it on
//! reconnect, which pins where the page ends. convex-rs discards journals, so a
//! page re-run after a reconnect could end somewhere else and leave a gap or an
//! overlap with the next page. Instead, once a page has a successor, it is
//! re-subscribed with `endCursor` set to its `continueCursor` — the same
//! mechanism the split path uses — so every page but the last has a fixed end.
//!
//! The main thread does little per update:
//! - each page is read, decoded and interned off the main thread
//!   ([`crate::feed`]): a row keeps its `Arc` while its value is equal, so an
//!   update that changes no row (a lease, a progress stamp) never reaches the
//!   main thread at all, and the visible list is joined from ready `Arc`s;
//! - a re-subscribed or split page is interned against the rows it replaces,
//!   and a restarted list against the rows on screen, so tiles keep identity;
//! - observers are notified only when the rows, the status or the error moved.
//!
//! A page whose function throws keeps its subscription — the next result
//! replaces the error — and the list is `Failed` while any page is;
//! [`LivePaginatedQuery::retry`] runs the failed pages again.

use std::{
    collections::{HashMap, HashSet},
    sync::Arc,
};

use gpui_kit::{App, AppContext as _, Context, Entity, SharedString, Task};
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use serde_json::{Value, json};
use tokio::sync::watch;

use crate::{
    connection::Backend,
    error::CallError,
    feed::{EncodedArgs, forward, read_subscription},
    function::{args_key, decode},
    rows::{Row, RowCache},
    snapshots::{Pool, QuerySnapshots},
};

/// A paginated query: its arguments without `paginationOpts`, and its row type.
pub struct PaginatedQuery<Args, T> {
    path: &'static str,
    _types: std::marker::PhantomData<fn(Args) -> T>,
}

impl<Args, T> PaginatedQuery<Args, T> {
    pub const fn new(path: &'static str) -> Self {
        Self {
            path,
            _types: std::marker::PhantomData,
        }
    }

    pub fn path(&self) -> &'static str {
        self.path
    }
}

impl<Args, T> Clone for PaginatedQuery<Args, T> {
    fn clone(&self) -> Self {
        *self
    }
}

impl<Args, T> Copy for PaginatedQuery<Args, T> {}

/// A page read once with [`crate::Backend::query_page`].
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Page<T> {
    pub page: Vec<T>,
    pub is_done: bool,
    pub continue_cursor: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PaginationStatus {
    LoadingFirstPage,
    CanLoadMore,
    LoadingMore,
    Exhausted,
    Failed,
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
struct PaginationOpts {
    num_items: usize,
    cursor: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    end_cursor: Option<String>,
    id: u32,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PageJson<T> {
    page: Vec<T>,
    is_done: bool,
    continue_cursor: String,
    #[serde(default)]
    split_cursor: Option<String>,
    #[serde(default)]
    page_status: Option<String>,
}

/// One page as the main thread receives it: rows already interned.
struct PageResult<T> {
    rows: Vec<Arc<T>>,
    is_done: bool,
    continue_cursor: String,
    split_cursor: Option<String>,
    split_required: bool,
    split_recommended: bool,
}

impl<T: Row> PageResult<T> {
    fn new(page: PageJson<T>, cache: &mut RowCache<T>) -> Self {
        let status = page.page_status.as_deref();
        Self {
            split_required: status == Some("SplitRequired"),
            split_recommended: status == Some("SplitRecommended"),
            rows: cache.intern(page.page),
            is_done: page.is_done,
            continue_cursor: page.continue_cursor,
            split_cursor: page.split_cursor,
        }
    }

    /// Nothing the list shows or pages by differs.
    fn same_as(&self, other: &Self) -> bool {
        self.is_done == other.is_done
            && self.split_required == other.split_required
            && self.split_recommended == other.split_recommended
            && self.continue_cursor == other.continue_cursor
            && self.split_cursor == other.split_cursor
            && self.rows.len() == other.rows.len()
            && self
                .rows
                .iter()
                .zip(&other.rows)
                .all(|(a, b)| Arc::ptr_eq(a, b))
    }
}

type PageItem<T> = Result<Arc<PageResult<T>>, CallError>;

/// The two halves of a page's subscription: the background reader and the
/// main-thread task that applies what it reads. Dropping them unsubscribes.
struct SlotTasks {
    _read: Task<()>,
    _apply: Task<()>,
}

struct Slot<T> {
    opts: PaginationOpts,
    page: Option<Arc<PageResult<T>>>,
    /// The page's latest result was an error; the subscription goes on.
    error: Option<CallError>,
    _tasks: SlotTasks,
}

pub struct LivePaginatedQuery<T: Row> {
    path: &'static str,
    /// The caller's arguments as a JSON object, without `paginationOpts`.
    base_args: Value,
    args_key: String,
    initial_num_items: usize,
    pagination_id: u32,
    next_key: u64,
    /// Visible pages, in order.
    pages: Vec<u64>,
    slots: HashMap<u64, Slot<T>>,
    /// Pages being split: original key → the two halves.
    splits: HashMap<u64, (u64, u64)>,
    rows: Arc<Vec<Arc<T>>>,
    /// True while `rows` is a remembered snapshot or the previous arguments'.
    stale: bool,
    status: PaginationStatus,
    error: Option<SharedString>,
}

/// Largest first page asked for when restoring a remembered, longer list.
const MAX_RESTORE_ITEMS: usize = 1_000;

impl<T> LivePaginatedQuery<T>
where
    T: Row + DeserializeOwned,
{
    pub fn new<Args: Serialize>(
        query: PaginatedQuery<Args, T>,
        args: &Args,
        initial_num_items: usize,
        cx: &mut App,
    ) -> Entity<Self> {
        cx.new(|cx| {
            let mut this = Self {
                path: query.path(),
                base_args: Value::Null,
                args_key: String::new(),
                initial_num_items: initial_num_items.max(1),
                pagination_id: 0,
                next_key: 0,
                pages: Vec::new(),
                slots: HashMap::new(),
                splits: HashMap::new(),
                rows: Arc::new(Vec::new()),
                stale: false,
                status: PaginationStatus::LoadingFirstPage,
                error: None,
            };
            this.restart(
                serde_json::to_value(args).unwrap_or(Value::Null),
                args_key(args),
                cx,
            );
            this
        })
    }

    /// The rows loaded so far, in order. Unchanged rows keep their `Arc`.
    pub fn rows(&self) -> &Arc<Vec<Arc<T>>> {
        &self.rows
    }

    /// True while the rows shown are a snapshot from before, not yet confirmed.
    pub fn is_stale(&self) -> bool {
        self.stale
    }

    pub fn status(&self) -> PaginationStatus {
        self.status
    }

    /// Why a page failed, while the status is [`PaginationStatus::Failed`].
    pub fn error(&self) -> Option<&SharedString> {
        self.error.as_ref()
    }

    /// Changes the arguments (a filter); the current rows stay on screen,
    /// marked stale, until the new first page arrives.
    pub fn set_args<Args: Serialize>(&mut self, args: &Args, cx: &mut Context<Self>) {
        let key = args_key(args);
        if key != self.args_key {
            self.restart(serde_json::to_value(args).unwrap_or(Value::Null), key, cx);
        }
    }

    /// Asks for `num_items` more rows. Ignored unless more can be loaded.
    pub fn load_more(&mut self, num_items: usize, cx: &mut Context<Self>) {
        if self.status != PaginationStatus::CanLoadMore {
            return;
        }
        let Some(cursor) = self
            .pages
            .last()
            .and_then(|key| self.slots.get(key))
            .and_then(|slot| slot.page.as_ref())
            .map(|page| page.continue_cursor.clone())
        else {
            return;
        };
        let key = self.add_slot(
            PaginationOpts {
                num_items: num_items.max(1),
                cursor: Some(cursor),
                end_cursor: None,
                id: self.pagination_id,
            },
            Vec::new(),
            cx,
        );
        self.pages.push(key);
        self.reconcile(cx);
    }

    /// Runs every failed page again. Each gets a fresh subscription id, so
    /// Convex executes it anew rather than answering with the cached failure.
    pub fn retry(&mut self, cx: &mut Context<Self>) {
        let failed: Vec<u64> = self
            .slots
            .iter()
            .filter(|(_, slot)| slot.error.is_some())
            .map(|(key, _)| *key)
            .collect();
        if failed.is_empty() {
            return;
        }
        for key in failed {
            let Some(slot) = self.slots.get(&key) else {
                continue;
            };
            let opts = PaginationOpts {
                id: rand::random(),
                ..slot.opts.clone()
            };
            let seed = slot
                .page
                .as_ref()
                .map(|page| page.rows.clone())
                .unwrap_or_default();
            let tasks = self.subscribe(key, &opts, seed, cx);
            if let Some(slot) = self.slots.get_mut(&key) {
                slot.opts = opts;
                slot.error = None;
                slot._tasks = tasks;
            }
        }
        self.reconcile(cx);
    }

    fn restart(&mut self, base_args: Value, args_key: String, cx: &mut Context<Self>) {
        self.base_args = base_args;
        self.args_key = args_key;
        self.pagination_id = rand::random();
        self.slots.clear();
        self.splits.clear();
        self.pages.clear();
        self.error = None;
        self.status = PaginationStatus::LoadingFirstPage;

        let remembered = QuerySnapshots::get::<Vec<Arc<T>>>(cx, self.path, &self.args_key);
        let first_page = match &remembered {
            Some(rows) => rows.len().clamp(self.initial_num_items, MAX_RESTORE_ITEMS),
            None => self.initial_num_items,
        };
        if let Some(rows) = remembered {
            self.rows = rows;
            self.stale = true;
        } else if !self.rows.is_empty() {
            self.stale = true;
        }

        // Rows on screen that come back equal keep their tiles.
        let seed = self.rows.as_ref().clone();
        let key = self.add_slot(
            PaginationOpts {
                num_items: first_page,
                cursor: None,
                end_cursor: None,
                id: self.pagination_id,
            },
            seed,
            cx,
        );
        self.pages.push(key);
        cx.notify();
    }

    fn add_slot(&mut self, opts: PaginationOpts, seed: Vec<Arc<T>>, cx: &mut Context<Self>) -> u64 {
        let key = self.next_key;
        self.next_key += 1;
        let tasks = self.subscribe(key, &opts, seed, cx);
        self.slots.insert(
            key,
            Slot {
                opts,
                page: None,
                error: None,
                _tasks: tasks,
            },
        );
        key
    }

    /// Subscribes to one page. Its rows are interned against `seed` first.
    fn subscribe(
        &self,
        key: u64,
        opts: &PaginationOpts,
        seed: Vec<Arc<T>>,
        cx: &mut Context<Self>,
    ) -> SlotTasks {
        let mut args = match &self.base_args {
            Value::Object(map) => map.clone(),
            _ => serde_json::Map::new(),
        };
        args.insert("paginationOpts".into(), json!(opts));
        let encoded: EncodedArgs = match convex::Value::try_from(Value::Object(args)) {
            Ok(convex::Value::Object(map)) => Ok(map),
            Ok(_) => Err(CallError::Encode("arguments are not an object".into())),
            Err(error) => Err(CallError::Encode(error.to_string())),
        };
        let path = self.path;
        let client = Backend::global(cx).update(cx, |backend, _| backend.authenticated_client());

        let (sender, receiver) = watch::channel::<Option<PageItem<T>>>(None);
        let read = cx.background_spawn(async move {
            let mut cache = RowCache::from_rows(&seed);
            drop(seed);
            let mut current: Option<Arc<PageResult<T>>> = None;
            // Whether the main thread holds `current`; not after an error.
            let mut delivered = false;
            let outcome = read_subscription(client, path, encoded, |result| {
                let item = match result.and_then(decode::<PageJson<T>>) {
                    Ok(page) => {
                        let page = PageResult::new(page, &mut cache);
                        if delivered && current.as_ref().is_some_and(|last| last.same_as(&page)) {
                            return;
                        }
                        let page = Arc::new(page);
                        current = Some(page.clone());
                        Ok(page)
                    }
                    Err(error) => {
                        if !error.is_invalid_cursor() {
                            tracing::warn!(path, %error, "a page of a paginated query failed");
                        }
                        Err(error)
                    }
                };
                delivered = item.is_ok();
                sender.send_replace(Some(item));
            })
            .await;
            if let Err(error) = outcome {
                tracing::warn!(path, %error, "a page of a paginated query stopped");
                sender.send_replace(Some(Err(error)));
            }
        });
        let apply = forward(receiver, cx, move |this: &mut Self, item, cx| {
            this.receive(key, item, cx)
        });
        SlotTasks {
            _read: read,
            _apply: apply,
        }
    }

    fn receive(&mut self, key: u64, item: PageItem<T>, cx: &mut Context<Self>) {
        let Some(slot) = self.slots.get_mut(&key) else {
            return;
        };
        match item {
            Ok(page) => {
                slot.page = Some(page);
                slot.error = None;
            }
            Err(error) if error.is_invalid_cursor() => {
                tracing::warn!(
                    path = self.path,
                    "pagination cursor went invalid; starting over"
                );
                let base_args = self.base_args.clone();
                let args_key = self.args_key.clone();
                self.restart(base_args, args_key, cx);
                return;
            }
            Err(error) => slot.error = Some(error),
        }
        self.reconcile(cx);
    }

    /// Recomputes the visible rows and the status after any page changed, and
    /// starts splits and end-cursor pins where a page needs one. Notifies only
    /// when what the list shows changed.
    fn reconcile(&mut self, cx: &mut Context<Self>) {
        self.complete_splits();
        self.start_splits(cx);
        self.pin_page_ends(cx);

        let mut rows = Vec::with_capacity(self.rows.len());
        let mut loaded = None;
        let mut complete = true;
        {
            let mut seen = HashSet::new();
            for key in &self.pages {
                let Some(page) = self.slots.get(key).and_then(|slot| slot.page.as_deref()) else {
                    complete = false;
                    break;
                };
                if page.split_required {
                    complete = false;
                    break;
                }
                for row in &page.rows {
                    if seen.insert(row.row_id()) {
                        rows.push(row.clone());
                    }
                }
                loaded = Some(page.is_done);
            }
        }

        let error = self.first_error();
        let status = match (&error, complete, loaded) {
            (Some(_), _, _) => PaginationStatus::Failed,
            (None, _, None) => PaginationStatus::LoadingFirstPage,
            (None, false, Some(_)) => PaginationStatus::LoadingMore,
            (None, true, Some(true)) => PaginationStatus::Exhausted,
            (None, true, Some(false)) => PaginationStatus::CanLoadMore,
        };
        let mut changed = status != self.status || error != self.error;
        self.status = status;
        self.error = error;

        // Until the first page answers, the remembered or previous rows stay.
        if loaded.is_some() {
            let rows_changed = rows.len() != self.rows.len()
                || rows
                    .iter()
                    .zip(self.rows.iter())
                    .any(|(a, b)| !Arc::ptr_eq(a, b));
            if rows_changed || self.stale {
                self.rows = Arc::new(rows);
                self.stale = false;
                changed = true;
                QuerySnapshots::put(
                    cx,
                    Pool::Lists,
                    self.path,
                    self.args_key.clone(),
                    self.rows.clone(),
                    self.rows.len(),
                );
            }
        }
        if changed {
            cx.notify();
        }
    }

    /// The first error among the visible pages and the halves being split.
    fn first_error(&self) -> Option<SharedString> {
        let halves = self.splits.values().flat_map(|(a, b)| [*a, *b]);
        self.pages
            .iter()
            .copied()
            .chain(halves)
            .find_map(|key| self.slots.get(&key)?.error.as_ref())
            .map(CallError::user_message)
    }

    fn complete_splits(&mut self) {
        let finished: Vec<(u64, (u64, u64))> = self
            .splits
            .iter()
            .filter(|(_, (a, b))| {
                [a, b]
                    .iter()
                    .all(|key| self.slots.get(key).is_some_and(|slot| slot.page.is_some()))
            })
            .map(|(original, halves)| (*original, *halves))
            .collect();
        for (original, (a, b)) in finished {
            self.splits.remove(&original);
            self.slots.remove(&original);
            if let Some(ix) = self.pages.iter().position(|key| *key == original) {
                self.pages.splice(ix..=ix, [a, b]);
            }
        }
    }

    fn start_splits(&mut self, cx: &mut Context<Self>) {
        let candidates: Vec<(u64, PaginationOpts, String, String, Vec<Arc<T>>)> = self
            .pages
            .iter()
            .filter(|key| !self.splits.contains_key(key))
            .filter_map(|key| {
                let slot = self.slots.get(key)?;
                let page = slot.page.as_ref()?;
                let split_cursor = page.split_cursor.clone()?;
                let too_big = page.split_required
                    || page.split_recommended
                    || page.rows.len() > self.initial_num_items * 2;
                too_big.then(|| {
                    (
                        *key,
                        slot.opts.clone(),
                        split_cursor,
                        page.continue_cursor.clone(),
                        page.rows.clone(),
                    )
                })
            })
            .collect();
        for (key, opts, split_cursor, continue_cursor, rows) in candidates {
            // Both halves start from the original's rows, so tiles keep identity.
            let first = self.add_slot(
                PaginationOpts {
                    end_cursor: Some(split_cursor.clone()),
                    ..opts.clone()
                },
                rows.clone(),
                cx,
            );
            let second = self.add_slot(
                PaginationOpts {
                    cursor: Some(split_cursor),
                    end_cursor: Some(opts.end_cursor.clone().unwrap_or(continue_cursor)),
                    ..opts
                },
                rows,
                cx,
            );
            self.splits.insert(key, (first, second));
        }
    }

    /// Every page with a successor gets a fixed end (see the module docs).
    fn pin_page_ends(&mut self, cx: &mut Context<Self>) {
        let last = self.pages.last().copied();
        let to_pin: Vec<(u64, PaginationOpts, Vec<Arc<T>>)> = self
            .pages
            .iter()
            .filter(|key| Some(**key) != last)
            .filter_map(|key| {
                let slot = self.slots.get(key)?;
                if slot.opts.end_cursor.is_some() {
                    return None;
                }
                let page = slot.page.as_ref()?;
                Some((
                    *key,
                    PaginationOpts {
                        end_cursor: Some(page.continue_cursor.clone()),
                        ..slot.opts.clone()
                    },
                    page.rows.clone(),
                ))
            })
            .collect();
        for (key, opts, rows) in to_pin {
            let tasks = self.subscribe(key, &opts, rows, cx);
            if let Some(slot) = self.slots.get_mut(&key) {
                // Keep the page on screen; the pinned subscription covers the
                // same range and replaces it when it answers.
                slot.opts = opts;
                slot._tasks = tasks;
            }
        }
    }
}
