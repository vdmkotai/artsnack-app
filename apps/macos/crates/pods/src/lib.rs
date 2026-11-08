//! Tools for the self-hosted pods: the backend manager (rent, start, stop and
//! destroy RunPod pods and Vast.ai instances, and pick the one new generations
//! use) and the paid-launch confirmation.
//!
//! # Embedding the RunPod panel
//!
//! The video tab shows video pods with the same panel the backend manager
//! uses for the image pod. Keep each panel in a field and render it as a child:
//!
//! ```ignore
//! // A card for a running video pod, by its `runpodBackends` id…
//! let pod = cx.new(|cx| {
//!     RunpodBackendPanel::new(RunpodPanelOptions::video().with_backend_id(id), window, cx)
//! });
//! // …and the form to rent one more next to it.
//! let another = cx.new(|cx| {
//!     RunpodBackendPanel::new(RunpodPanelOptions::video().launch_only(true), window, cx)
//! });
//! // While the panels are kept but not on screen, stop their polling:
//! pod.update(cx, |panel, cx| panel.set_open(false, window, cx));
//! ```
//!
//! A panel polls RunPod while it is open and has a pod, and loads the GPU
//! catalogue when it opens without one. It emits
//! [`RunpodPanelEvent::Launched`] after a rental went through; the pod itself
//! arrives through `runpodBackendStore.videoPods` like any other.
//! [`Poller`] is the loop behind its polling, for other per-pod status (the
//! video pod's downloads).

mod backend_manager;
mod controls;
mod format;
mod launch_dialog;
mod polling;
mod runpod_panel;
mod vast_panel;

use artsnack_backend::{Action, Backend, CallError};
use gpui_kit::{App, Global, Task, Window};
use serde::{Serialize, de::DeserializeOwned};

pub use launch_dialog::{PodLaunchEvent, PodLaunchPanel};
pub use polling::{FAST_POLL, Poller, SLOW_POLL};
pub use runpod_panel::{RunpodBackendPanel, RunpodPanelEvent, RunpodPanelOptions};

/// Bumped whenever a model lands on a pod, so composers re-read their model
/// lists (the web's `artsnack:pod-catalog-version`). Observe it with
/// `cx.observe_global::<PodCatalogVersion>`.
#[derive(Default)]
pub struct PodCatalogVersion(u64);

impl Global for PodCatalogVersion {}

impl PodCatalogVersion {
    pub fn bump(cx: &mut App) {
        cx.default_global::<PodCatalogVersion>().0 += 1;
    }
}

/// Opens the self-hosted backend manager (RunPod | Vast.ai): rent, start,
/// stop and destroy pods, and pick the one new generations use.
pub fn open_backend_manager(window: &mut Window, cx: &mut App) {
    backend_manager::open(window, cx);
}

/// Runs a Convex action with the default deadline.
pub(crate) fn act<Args, Output>(
    action: Action<Args, Output>,
    args: &Args,
    cx: &mut App,
) -> Task<Result<Output, CallError>>
where
    Args: Serialize,
    Output: DeserializeOwned + Send + 'static,
{
    Backend::global(cx).update(cx, |backend, cx| backend.act(action, args, cx))
}
