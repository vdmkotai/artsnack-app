//! A QuickJS context on its own thread.
//!
//! The API composer's rules need the Atlas catalogue — tens of thousands of
//! lines of generated data — and run the form normaliser dozens of times per
//! change to price every option. On the UI thread that would delay startup and
//! every click. Here the bundle loads in the background while the window
//! opens, and a call is a message to the thread whose answer comes back as a
//! future.
//!
//! - **Order.** Calls run one at a time. Interactive calls (the composer's
//!   edits, its submit plan) run in the order they were made, ahead of every
//!   background call (result labels, details), which run in their own order
//!   when nothing interactive waits.
//! - **Cancellation.** A call whose future was dropped before its turn is
//!   skipped: a superseded details panel or a closed picker costs nothing.
//! - **Off the UI thread.** [`JsWorker::call_owned`] and
//!   [`JsWorker::call_background`] take their arguments by value and encode
//!   them on the worker, so the caller pays for a move, not a JSON encoding.

use std::{
    collections::VecDeque,
    sync::{Arc, Condvar, Mutex},
    thread,
};

use anyhow::{Context as _, anyhow};
use futures::{FutureExt as _, channel::oneshot, future::BoxFuture};
use rquickjs::{Context, Ctx, Runtime};
use serde::{Serialize, de::DeserializeOwned};

use crate::{call_json, js_error};

/// What a job is handed: the context, or why the bundle failed to load.
type Job = Box<dyn for<'js> FnOnce(Result<&Ctx<'js>, &str>) + Send>;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Priority {
    Interactive,
    Background,
}

#[derive(Default)]
struct Jobs {
    interactive: VecDeque<Job>,
    background: VecDeque<Job>,
    closed: bool,
}

#[derive(Default)]
struct Queue {
    jobs: Mutex<Jobs>,
    ready: Condvar,
}

impl Queue {
    /// Queues `job`, or hands it back when the worker is gone.
    fn push(&self, priority: Priority, job: Job) -> Result<(), Job> {
        let mut jobs = self
            .jobs
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        if jobs.closed {
            return Err(job);
        }
        match priority {
            Priority::Interactive => jobs.interactive.push_back(job),
            Priority::Background => jobs.background.push_back(job),
        }
        drop(jobs);
        self.ready.notify_one();
        Ok(())
    }

    /// The next job, interactive first; `None` once the worker is closed.
    fn pop(&self) -> Option<Job> {
        let mut jobs = self
            .jobs
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        loop {
            if let Some(job) = jobs.interactive.pop_front() {
                return Some(job);
            }
            if let Some(job) = jobs.background.pop_front() {
                return Some(job);
            }
            if jobs.closed {
                return None;
            }
            jobs = self
                .ready
                .wait(jobs)
                .unwrap_or_else(|poison| poison.into_inner());
        }
    }

    fn close(&self) {
        let mut jobs = self
            .jobs
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        jobs.closed = true;
        drop(jobs);
        self.ready.notify_all();
    }
}

pub struct JsWorker {
    queue: Arc<Queue>,
}

impl JsWorker {
    /// Starts the thread and loads `bundle` on it. Calls made before it has
    /// loaded wait for it.
    pub fn spawn(name: &str, bundle: &'static str) -> Self {
        let queue = Arc::new(Queue::default());
        let worker_queue = queue.clone();
        let spawned = thread::Builder::new()
            .name(format!("js-{name}"))
            .spawn(move || run(bundle, &worker_queue));
        if let Err(error) = spawned {
            tracing::error!(?error, "could not start a JavaScript worker");
            queue.close();
        }
        Self { queue }
    }

    /// Calls an exported function on the worker with `args` (the arguments
    /// array, so pass a tuple or a `Vec`), encoded here. The result is decoded
    /// on the worker. Boxed, so the future borrows neither the arguments nor
    /// the worker.
    pub fn call<A: Serialize, T: DeserializeOwned + Send + 'static>(
        &self,
        path: &str,
        args: &A,
    ) -> BoxFuture<'static, anyhow::Result<T>> {
        let args = serde_json::to_string(args).context("encoding arguments");
        self.submit(Priority::Interactive, path, move || args)
    }

    /// [`Self::call`] with the arguments moved to the worker and encoded there.
    pub fn call_owned<A: Serialize + Send + 'static, T: DeserializeOwned + Send + 'static>(
        &self,
        path: &str,
        args: A,
    ) -> BoxFuture<'static, anyhow::Result<T>> {
        self.submit(Priority::Interactive, path, move || {
            serde_json::to_string(&args).context("encoding arguments")
        })
    }

    /// [`Self::call_owned`] for work nobody is waiting on with a click: it runs
    /// only when no interactive call is queued.
    pub fn call_background<A: Serialize + Send + 'static, T: DeserializeOwned + Send + 'static>(
        &self,
        path: &str,
        args: A,
    ) -> BoxFuture<'static, anyhow::Result<T>> {
        self.submit(Priority::Background, path, move || {
            serde_json::to_string(&args).context("encoding arguments")
        })
    }

    fn submit<T: DeserializeOwned + Send + 'static>(
        &self,
        priority: Priority,
        path: &str,
        args: impl FnOnce() -> anyhow::Result<String> + Send + 'static,
    ) -> BoxFuture<'static, anyhow::Result<T>> {
        let (reply, answer) = oneshot::channel();
        let path = path.to_string();
        let job: Job = Box::new(move |ctx| {
            // Nobody is waiting any more: skip the work.
            if reply.is_canceled() {
                return;
            }
            let result = (|| -> anyhow::Result<T> {
                let ctx = ctx.map_err(|reason| anyhow!("{reason}"))?;
                let json = call_json(ctx, &path, args()?)?;
                serde_json::from_str(&json)
                    .with_context(|| format!("decoding the result of {path}"))
            })();
            let _ = reply.send(result);
        });
        let sent = self.queue.push(priority, job).is_ok();
        async move {
            if !sent {
                return Err(anyhow!("the JavaScript worker is not running"));
            }
            answer
                .await
                .map_err(|_| anyhow!("the JavaScript worker stopped"))?
        }
        .boxed()
    }
}

impl Drop for JsWorker {
    fn drop(&mut self) {
        self.queue.close();
    }
}

fn run(bundle: &'static str, queue: &Queue) {
    let loaded = (|| -> anyhow::Result<(Runtime, Context)> {
        let runtime = Runtime::new().context("starting QuickJS")?;
        let context = Context::full(&runtime).context("creating a QuickJS context")?;
        context.with(|ctx| {
            ctx.eval::<(), _>(bundle)
                .map_err(|error| js_error(&ctx, error))
                .context("evaluating the bundle")
        })?;
        Ok((runtime, context))
    })();
    match loaded {
        // The runtime is kept alive (and dropped last) for as long as jobs come.
        Ok((_runtime, context)) => {
            while let Some(job) = queue.pop() {
                context.with(|ctx| job(Ok(&ctx)));
            }
        }
        Err(error) => {
            tracing::error!(?error, "could not load a JavaScript bundle");
            let reason = format!("{error:#}");
            while let Some(job) = queue.pop() {
                job(Err(&reason));
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::JsWorker;

    /// `spin` holds the worker for a while; `count` says how many `count`
    /// calls have run, this one included.
    const BUNDLE: &str = r#"
        var counted = 0;
        globalThis.ArtsnackShared = {
            __call(path, args) {
                if (path === "spin") {
                    const until = Date.now() + 100;
                    while (Date.now() < until) {}
                    return "null";
                }
                counted += 1;
                return JSON.stringify(path + ":" + counted);
            },
        };
    "#;

    #[test]
    fn interactive_calls_go_first_and_dropped_calls_never_run() {
        let worker = JsWorker::spawn("test", BUNDLE);
        let spin = worker.call_owned::<_, ()>("spin", ());
        // Queued while `spin` holds the worker.
        let dropped = worker.call_background::<_, String>("dropped", ());
        let background = worker.call_background::<_, String>("background", ());
        let interactive = worker.call::<_, String>("interactive", &());
        drop(dropped);
        futures::executor::block_on(spin).unwrap();
        assert_eq!(
            futures::executor::block_on(interactive).unwrap(),
            "interactive:1"
        );
        assert_eq!(
            futures::executor::block_on(background).unwrap(),
            "background:2"
        );
    }

    #[test]
    fn a_broken_bundle_fails_every_call() {
        let worker = JsWorker::spawn("broken", "this is not javascript");
        let error = futures::executor::block_on(worker.call_owned::<_, ()>("any", ()))
            .unwrap_err()
            .to_string();
        assert!(error.contains("evaluating the bundle"), "{error}");
    }
}
