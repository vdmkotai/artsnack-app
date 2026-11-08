//! A live query as a GPUI entity: observe it and re-render when it changes.
//!
//! - Results are read, compared and decoded off the main thread
//!   ([`crate::feed`]); the entity only receives a changed result, as an `Arc`
//!   it swaps in. Identical queries share one pipeline.
//! - The last result for the same query and arguments is remembered
//!   ([`QuerySnapshots`]) and shown at once on the next subscription, so
//!   revisiting a screen renders from memory while the fresh subscription
//!   loads — the web's `convex-cache.ts`. That snapshot is for display only:
//!   never seed an editable form from it.
//! - Changing the arguments keeps showing the previous data until the new
//!   result arrives, so controls never unmount while a filter loads.

use std::{rc::Rc, sync::Arc};

use gpui_kit::{App, AppContext as _, Context, Entity, SharedString, Task};
use serde::{Serialize, de::DeserializeOwned};

use crate::{
    feed::{FeedItem, LiveFeed, forward},
    function::{Query, args_key, encode_args},
    snapshots::{Pool, QuerySnapshots},
};

/// The state of a live query.
pub enum QueryState<T> {
    /// No result yet, and nothing remembered from before.
    Loading,
    /// The latest result. `stale` is true while it is a remembered snapshot or a
    /// result for the previous arguments, until the subscription answers.
    Ready {
        data: Arc<T>,
        stale: bool,
    },
    Failed(SharedString),
}

pub struct LiveQuery<T> {
    path: &'static str,
    args_key: String,
    state: QueryState<T>,
    /// Keeps the shared pipeline running while this query shows it.
    _feed: Option<Rc<LiveFeed<T>>>,
    subscription: Option<Task<()>>,
}

impl<T> LiveQuery<T>
where
    T: DeserializeOwned + PartialEq + Send + Sync + 'static,
{
    /// Subscribes to `query` with `args`.
    pub fn new<Args: Serialize>(query: Query<Args, T>, args: &Args, cx: &mut App) -> Entity<Self> {
        cx.new(|cx| {
            let mut this = Self {
                path: query.path(),
                args_key: String::new(),
                state: QueryState::Loading,
                _feed: None,
                subscription: None,
            };
            this.subscribe(query, args, cx);
            this
        })
    }

    pub fn state(&self) -> &QueryState<T> {
        &self.state
    }

    /// The latest data, fresh or remembered.
    pub fn data(&self) -> Option<&Arc<T>> {
        match &self.state {
            QueryState::Ready { data, .. } => Some(data),
            _ => None,
        }
    }

    pub fn is_loading(&self) -> bool {
        matches!(self.state, QueryState::Loading)
    }

    pub fn error(&self) -> Option<&SharedString> {
        match &self.state {
            QueryState::Failed(message) => Some(message),
            _ => None,
        }
    }

    /// Re-subscribes with new arguments, unless they are the same.
    pub fn set_args<Args: Serialize>(
        &mut self,
        query: Query<Args, T>,
        args: &Args,
        cx: &mut Context<Self>,
    ) {
        if args_key(args) != self.args_key {
            self.subscribe(query, args, cx);
        }
    }

    /// Subscribes again with `args`, on a fresh pipeline: a failed
    /// subscription stays failed until then.
    pub fn retry<Args: Serialize>(
        &mut self,
        query: Query<Args, T>,
        args: &Args,
        cx: &mut Context<Self>,
    ) {
        self.subscription = None;
        // Released first, so `LiveFeed::shared` does not hand the failed one back.
        self._feed = None;
        self.subscribe(query, args, cx);
    }

    fn subscribe<Args: Serialize>(
        &mut self,
        query: Query<Args, T>,
        args: &Args,
        cx: &mut Context<Self>,
    ) {
        self.path = query.path();
        self.args_key = args_key(args);
        let remembered = QuerySnapshots::get::<T>(cx, self.path, &self.args_key);
        self.state = match (
            remembered.clone(),
            std::mem::replace(&mut self.state, QueryState::Loading),
        ) {
            (Some(data), _) => QueryState::Ready { data, stale: true },
            // Keep the previous arguments' data on screen while the new loads.
            (None, QueryState::Ready { data, .. }) => QueryState::Ready { data, stale: true },
            (None, _) => QueryState::Loading,
        };

        let feed = LiveFeed::shared(self.path, &self.args_key, encode_args(args), remembered, cx);
        let mut receiver = feed.receiver();
        // Another screen may already run this query: show its answer now.
        let current = receiver.borrow_and_update().clone();
        if let Some(item @ Ok(_)) = current {
            self.apply(item, cx);
        }
        self._feed = Some(feed);
        self.subscription = Some(forward(receiver, cx, |this, item, cx| this.apply(item, cx)));
    }

    fn apply(&mut self, item: FeedItem<T>, cx: &mut Context<Self>) {
        let answer = match item {
            Ok(answer) => answer,
            Err(error) => {
                self.state = QueryState::Failed(error.user_message());
                cx.notify();
                return;
            }
        };
        if let QueryState::Ready {
            data: current,
            stale,
        } = &mut self.state
            && Arc::ptr_eq(current, &answer.data)
        {
            if *stale {
                *stale = false;
                cx.notify();
            }
            return;
        }
        QuerySnapshots::put(
            cx,
            Pool::Queries,
            self.path,
            self.args_key.clone(),
            answer.data.clone(),
            answer.size,
        );
        self.state = QueryState::Ready {
            data: answer.data,
            stale: false,
        };
        cx.notify();
    }
}
