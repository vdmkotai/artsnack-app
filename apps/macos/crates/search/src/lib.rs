//! The Search screen: the user's whole history, searched on the device.
//!
//! - [`SearchView`]: the screen the shell mounts. It reports hand-offs to
//!   other screens as [`MediaCommand`]s.
//! - [`engine`]: the search contract shared with the web, Convex and iOS
//!   (`packages/shared/search.ts`), ported to Rust.

mod catalog;
pub mod engine;
mod filters;
mod format;
mod help;
mod results;
mod saved;
mod time;
mod view;

pub use artsnack_library::MediaCommand;
pub use view::SearchView;

/// Binds the screen's keys (Escape leaves reference selection, ⌘F finds).
/// Call once at startup.
pub fn init(cx: &mut gpui_kit::App) {
    view::init(cx);
}
