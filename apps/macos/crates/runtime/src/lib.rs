//! One Tokio runtime for the whole app, bridged into GPUI.
//!
//! GPUI runs its own executors; convex-rs and reqwest need Tokio's reactor for
//! sockets and timers. Work that touches the network is spawned here and its
//! result is awaited from a GPUI task, so no GPUI entity is ever touched off the
//! main thread and no network call ever blocks it.
//!
//! Adapted from Zed's `gpui_tokio` (Apache-2.0,
//! https://github.com/zed-industries/zed/tree/main/crates/gpui_tokio).

use std::future::Future;

use gpui_kit::{App, AppContext, Global, Task};

pub use tokio::task::JoinError;

struct GlobalRuntime {
    runtime: Option<tokio::runtime::Runtime>,
    handle: tokio::runtime::Handle,
}

impl Global for GlobalRuntime {}

impl Drop for GlobalRuntime {
    fn drop(&mut self) {
        if let Some(runtime) = self.runtime.take() {
            runtime.shutdown_background();
        }
    }
}

/// Starts the runtime. Call once, before anything that talks to the network.
pub fn init(cx: &mut App) {
    let runtime = tokio::runtime::Builder::new_multi_thread()
        // GPUI already owns a thread pool; two workers are plenty for sockets,
        // TLS and timers, which is all that runs here.
        .worker_threads(2)
        .thread_name("artsnack-io")
        .enable_all()
        .build()
        .expect("failed to start the Tokio runtime");
    let handle = runtime.handle().clone();
    cx.set_global(GlobalRuntime {
        runtime: Some(runtime),
        handle,
    });
}

/// Cancels the wrapped Tokio task when the GPUI task awaiting it is dropped.
struct AbortOnDrop(tokio::task::AbortHandle);

impl Drop for AbortOnDrop {
    fn drop(&mut self) {
        self.0.abort();
    }
}

/// Runs `future` on the runtime and hands its output back as a GPUI task.
///
/// Dropping the returned task cancels the Tokio task, so a view that goes away
/// takes its in-flight requests with it.
pub fn spawn<C, F, R>(cx: &C, future: F) -> Task<Result<R, JoinError>>
where
    C: AppContext,
    F: Future<Output = R> + Send + 'static,
    R: Send + 'static,
{
    cx.read_global(|runtime: &GlobalRuntime, cx| {
        let join = runtime.handle.spawn(future);
        let guard = AbortOnDrop(join.abort_handle());
        cx.background_spawn(async move {
            let result = join.await;
            drop(guard);
            result
        })
    })
}

/// [`spawn`] for futures that already return `anyhow::Result`.
pub fn spawn_result<C, F, R>(cx: &C, future: F) -> Task<anyhow::Result<R>>
where
    C: AppContext,
    F: Future<Output = anyhow::Result<R>> + Send + 'static,
    R: Send + 'static,
{
    cx.read_global(|runtime: &GlobalRuntime, cx| {
        let join = runtime.handle.spawn(future);
        let guard = AbortOnDrop(join.abort_handle());
        cx.background_spawn(async move {
            let result = join.await;
            drop(guard);
            result?
        })
    })
}

/// The runtime's handle, for clients that spawn their own background tasks
/// (convex-rs starts its WebSocket worker with `tokio::spawn`).
pub fn handle(cx: &App) -> tokio::runtime::Handle {
    cx.global::<GlobalRuntime>().handle.clone()
}
