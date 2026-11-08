//! Reading Convex subscriptions off the main thread.
//!
//! convex-rs hands every subscription the whole query set again on each
//! transition and clones each query's result even when it did not change. That
//! clone, the comparison with the previous result, the export to JSON and the
//! decoding all run on GPUI's background executor. The main thread receives only
//! changed, decoded values, through a `watch` channel that keeps just the newest
//! one, so a burst of transitions costs it at most one update.
//!
//! [`LiveFeed`] is one query's pipeline, shared by every [`crate::LiveQuery`]
//! with the same function, arguments and result type: the second screen that
//! shows the pod selection decodes nothing.

use std::{
    any::{Any, TypeId},
    collections::{BTreeMap, HashMap},
    future::Future,
    rc::{Rc, Weak},
    sync::Arc,
};

use convex::ConvexClient;
use futures::StreamExt as _;
use gpui_kit::{App, AppContext as _, Context, Global, Task};
use serde::de::DeserializeOwned;
use tokio::sync::watch;

use crate::{connection::Backend, error::CallError, function::decode};

/// Arguments in the form a subscription takes.
pub(crate) type EncodedArgs = Result<BTreeMap<String, convex::Value>, CallError>;

/// Subscribes to `path` and calls `on_result` with every result that differs
/// from the one before, exported to JSON. Runs until the subscription ends; an
/// error result does not end it, the next result replaces it.
pub(crate) async fn read_subscription(
    client: impl Future<Output = Result<ConvexClient, CallError>>,
    path: &'static str,
    args: EncodedArgs,
    mut on_result: impl FnMut(Result<serde_json::Value, CallError>),
) -> Result<(), CallError> {
    let args = args?;
    let mut client = client.await?;
    let mut stream = client
        .subscribe(path, args)
        .await
        .map_err(|error| CallError::Disconnected(error.to_string()))?;
    let mut last: Option<convex::FunctionResult> = None;
    while let Some(result) = stream.next().await {
        // A transition anywhere in the query set repeats this result as it was.
        // An error counts as a result here, so the same value after an error
        // is delivered again.
        if last.as_ref() == Some(&result) {
            continue;
        }
        last = Some(result.clone());
        on_result(CallError::from_result(result));
    }
    Err(CallError::Disconnected("the subscription ended".into()))
}

/// Hands each new value of `receiver` to `deliver` on the main thread, until
/// the entity or the sending side goes away.
pub(crate) fn forward<E: 'static, V: Clone + 'static>(
    mut receiver: watch::Receiver<Option<V>>,
    cx: &mut Context<E>,
    mut deliver: impl FnMut(&mut E, V, &mut Context<E>) + 'static,
) -> Task<()> {
    cx.spawn(async move |this, cx| {
        loop {
            let value = receiver.borrow_and_update().clone();
            if let Some(value) = value
                && this
                    .update(cx, |this, cx| deliver(this, value, cx))
                    .is_err()
            {
                break;
            }
            if receiver.changed().await.is_err() {
                break;
            }
        }
    })
}

/// A decoded query result and roughly how much memory its JSON took, which
/// the snapshot cache budgets by.
pub(crate) struct Answer<T> {
    pub data: Arc<T>,
    pub size: usize,
}

impl<T> Clone for Answer<T> {
    fn clone(&self) -> Self {
        Self {
            data: self.data.clone(),
            size: self.size,
        }
    }
}

pub(crate) type FeedItem<T> = Result<Answer<T>, CallError>;

/// One live query's pipeline: a background task and the newest value it
/// produced. It runs while anyone holds it.
pub(crate) struct LiveFeed<T> {
    receiver: watch::Receiver<Option<FeedItem<T>>>,
    _task: Task<()>,
}

/// The feeds running now, by function, arguments and result type.
#[derive(Default)]
struct LiveFeeds {
    feeds: HashMap<(&'static str, String, TypeId), Weak<dyn Any>>,
}

impl Global for LiveFeeds {}

impl<T> LiveFeed<T>
where
    T: DeserializeOwned + PartialEq + Send + Sync + 'static,
{
    /// The feed for `path` with arguments `key`, started if nobody runs it yet.
    /// `seed` is a remembered result: when the first answer equals it, the
    /// feed answers with the same `Arc`, so nothing re-renders.
    pub(crate) fn shared(
        path: &'static str,
        key: &str,
        args: EncodedArgs,
        seed: Option<Arc<T>>,
        cx: &mut App,
    ) -> Rc<Self> {
        let id = (path, key.to_string(), TypeId::of::<T>());
        let running = cx
            .try_global::<LiveFeeds>()
            .and_then(|feeds| feeds.feeds.get(&id))
            .and_then(Weak::upgrade)
            .and_then(|feed| feed.downcast::<Self>().ok());
        if let Some(feed) = running {
            return feed;
        }
        let feed = Rc::new(Self::start(path, args, seed, cx));
        let weak: Weak<dyn Any> = Rc::downgrade(&feed) as Weak<dyn Any>;
        let feeds = &mut cx.default_global::<LiveFeeds>().feeds;
        feeds.retain(|_, feed| feed.strong_count() > 0);
        feeds.insert(id, weak);
        feed
    }

    fn start(path: &'static str, args: EncodedArgs, seed: Option<Arc<T>>, cx: &mut App) -> Self {
        let (sender, receiver) = watch::channel(None);
        let client = Backend::global(cx).update(cx, |backend, _| backend.authenticated_client());
        let task = cx.background_spawn(async move {
            let mut current = seed;
            // Whether the main thread shows `current`; after an error it does
            // not, so an equal answer must be sent again.
            let mut delivered = false;
            let outcome = read_subscription(client, path, args, |result| {
                let decoded = result.and_then(|json| {
                    let size = json_size(&json);
                    decode::<T>(json).map(|value| (value, size))
                });
                let item = match decoded {
                    Ok((value, size)) => {
                        let data = match &current {
                            Some(previous) if **previous == value => {
                                if delivered {
                                    return;
                                }
                                previous.clone()
                            }
                            _ => Arc::new(value),
                        };
                        current = Some(data.clone());
                        Ok(Answer { data, size })
                    }
                    Err(error) => {
                        tracing::warn!(path, %error, "live query failed");
                        Err(error)
                    }
                };
                delivered = item.is_ok();
                sender.send_replace(Some(item));
            })
            .await;
            if let Err(error) = outcome {
                tracing::warn!(path, %error, "live query stopped");
                sender.send_replace(Some(Err(error)));
            }
        });
        Self {
            receiver,
            _task: task,
        }
    }

    pub(crate) fn receiver(&self) -> watch::Receiver<Option<FeedItem<T>>> {
        self.receiver.clone()
    }
}

/// Roughly how many bytes `value` takes in memory.
pub(crate) fn json_size(value: &serde_json::Value) -> usize {
    use serde_json::Value;
    match value {
        Value::Null | Value::Bool(_) | Value::Number(_) => 16,
        Value::String(text) => 24 + text.len(),
        Value::Array(items) => 24 + items.iter().map(json_size).sum::<usize>(),
        Value::Object(map) => {
            48 + map
                .iter()
                .map(|(key, value)| 24 + key.len() + json_size(value))
                .sum::<usize>()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::json_size;

    #[test]
    fn sizes_grow_with_content() {
        let small = serde_json::json!({ "a": 1 });
        let large = serde_json::json!({ "a": 1, "b": "x".repeat(1000), "c": [1, 2, 3] });
        assert!(json_size(&large) > json_size(&small) + 1000);
    }
}
