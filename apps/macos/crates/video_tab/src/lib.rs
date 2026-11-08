//! The Generate screen's Self-hosted video tab: MiniMax H3 and LTX 2.3 clips
//! on the managed video pods (the web's `components/h3/`).
//!
//! - [`VideoTab`]: the header (backend switch, form zoom, the pods' chip and
//!   its "Video pods" dialog), the form, and the results — the API tab's grid
//!   over `comfyVideo:list`.
//! - The form (`composer`) keeps one form per family, uploads the open
//!   mode's images to Convex storage and queues the clips with
//!   `comfyVideo.start` / `startLtx`; the graph is built server-side.
//! - Bounds, defaults and normalisation are `packages/shared/h3-video.ts` and
//!   `ltx-video.ts`, run through `artsnack-rules` (`rules`).

mod composer;
mod controls;
mod form;
mod inputs;
mod loras;
mod pods;
mod rules;
mod tab;

pub use tab::{TabsBuilder, VideoTab, VideoTabEvent};

/// Binds the tab's keys. Call once at startup.
pub fn init(cx: &mut gpui_kit::App) {
    composer::init(cx);
}
