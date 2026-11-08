//! ArtSnack's reusable, domain-aware components. Generic controls come from
//! GPUI Kit; what lives here is what a media app needs that the Kit does not
//! have: zoom for panes, the media grid and the lightbox.

pub mod lightbox;
pub mod media_grid;
pub mod media_masonry;
pub mod media_tile;
pub mod split_pane;
mod tile_cache;
pub mod video;
pub mod zoom;

pub use lightbox::{Lightbox, LightboxEvent, LightboxItem};
pub use media_grid::{MediaGridState, flow};
pub use media_masonry::{MasonryCell, MasonryLayout, MediaMasonryState, masonry};
pub use media_tile::{MediaTile, TileAction, TileMedia, TileMenuItem};
pub use split_pane::{DEFAULT_SPLIT_RATIO, SplitPane};
pub use video::{ClipChooser, ClipPlayers, ClipViewer, PLAYBACK};
pub use zoom::{PaneZoom, ZoomControl, ZoomScale, pane_zoom};

/// Binds the components' keys. Call once at startup.
/// The key context of any text field inside `context`, for a form's Cmd+Enter.
///
/// GPUI Kit's multi-line field binds Cmd+Enter itself: it inserts a newline
/// and only then reports the press, so a form that submitted on that report
/// did both. A binding for `"<Form> > Input"` sits at the field's own depth and,
/// being registered after GPUI Kit's, wins the tie: the form's action runs and
/// the field never sees the key.
pub fn field_in(context: &str) -> String {
    format!("{context} > Input")
}

pub fn init(cx: &mut gpui_kit::App) {
    lightbox::init(cx);
    video::init(cx);
}
