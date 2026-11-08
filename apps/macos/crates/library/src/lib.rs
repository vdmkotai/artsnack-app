//! Browsing what was made: Favorites, Gallery and History.

mod command;
mod favorites;
mod feed;
mod gallery;
mod grid_sync;
mod history;
mod reference_picker;
mod selection;
mod tile_view;

pub use command::{MediaCommand, ReproduceSource};
pub use favorites::FavoritesView;
pub use feed::{Feed, HIDDEN_GRACE, release_after_grace};
pub use gallery::{FavoriteHearts, GalleryView};
pub use grid_sync::GridSync;
pub use history::{HistoryEvent, HistoryView};
pub use reference_picker::{PickedImage, open_reference_picker};
pub use selection::Selection;

/// Binds the library screens' keys (Gallery's Escape and Delete while
/// selecting). Call once at startup.
pub fn init(cx: &mut gpui_kit::App) {
    gallery::init(cx);
}
