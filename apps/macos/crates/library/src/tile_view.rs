//! Grid tiles as cached views.
//!
//! GPUI's `list` renders every visible row again on every frame its screen
//! draws — a spinner turning, a clip's next frame, a progress tick, a caret
//! blinking in a field — and a media tile is the most expensive thing in a
//! row: its image, the hover controls, their tooltips. A [`TileView`] is one
//! tile as an entity drawn through `Entity::cached`, so a frame that changes
//! nothing about it reuses the tile's last paint instead of building it again.
//!
//! Two rules keep a reused paint correct:
//!
//! - **The revision says what the tile shows.** The owner hands over, every
//!   frame, a value that changes whenever anything the tile draws does — its
//!   row (by `Arc` identity, see [`Same`]), the heart, the selection mark. A
//!   tile whose revision moved gets a new renderer and is drawn afresh. Nothing
//!   has to remember to notify a tile.
//! - **Images stay held.** `MediaImages` keeps an image (and its queued
//!   download) while an element drawing it holds a lease in its element state,
//!   and GPUI carries element state over when a cached view's paint is reused.
//!   So a reused tile keeps its images in the texture atlas for as long as it
//!   is on screen, without rendering again.
//!
//! Cached views need a definite size; a tile has one (the grid's layout).

use std::{collections::HashMap, rc::Rc, sync::Arc, time::Instant};

use gpui_kit::{
    AnyElement, App, AppContext as _, Context, Entity, IntoElement, Pixels, Render, SharedString,
    Size, StyleRefinement, Styled as _, Window,
};

/// Draws a tile at its laid-out size.
pub(crate) type TileRenderer = Rc<dyn Fn(Size<Pixels>, &mut Window, &mut App) -> AnyElement>;

/// An `Arc` compared by identity. A live query keeps a row's `Arc` for as long
/// as its value is unchanged, and holding it here keeps the address from being
/// reused by another row.
#[derive(Debug)]
pub(crate) struct Same<T>(pub Arc<T>);

impl<T> Clone for Same<T> {
    fn clone(&self) -> Self {
        Self(self.0.clone())
    }
}

impl<T> PartialEq for Same<T> {
    fn eq(&self, other: &Self) -> bool {
        Arc::ptr_eq(&self.0, &other.0)
    }
}

/// One tile as a view. It holds no state of its own: what it shows is in its
/// renderer, made by the owner for the tile's current revision.
pub(crate) struct TileView {
    renderer: TileRenderer,
    size: Size<Pixels>,
    rendered_at: Option<Instant>,
}

impl Render for TileView {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        self.rendered_at = Some(Instant::now());
        let renderer = self.renderer.clone();
        renderer(self.size, window, cx)
    }
}

/// The tiles of one grid, by item key. `R` is a tile's revision.
pub(crate) struct TileViews<R> {
    tiles: HashMap<SharedString, (Entity<TileView>, R)>,
}

impl<R> Default for TileViews<R> {
    fn default() -> Self {
        Self {
            tiles: HashMap::new(),
        }
    }
}

impl<R: PartialEq + 'static> TileViews<R> {
    /// The tile for `key` at `size`, as an element for the grid. `renderer`
    /// is called for a new tile and whenever `revision` moved. A `live` tile
    /// (a clip playing in it) renders on every frame.
    pub fn element(
        &mut self,
        key: &SharedString,
        size: Size<Pixels>,
        revision: R,
        live: bool,
        renderer: impl FnOnce() -> TileRenderer,
        cx: &mut App,
    ) -> AnyElement {
        let reusable = match self.tiles.get_mut(key) {
            Some((tile, current)) if *current == revision => {
                // A new size is a new bound, which redraws a cached view by
                // itself; the renderer only needs to know it.
                tile.update(cx, |tile, _| tile.size = size);
                true
            }
            Some((tile, current)) => {
                let renderer = renderer();
                tile.update(cx, |tile, _| {
                    tile.renderer = renderer;
                    tile.size = size;
                });
                *current = revision;
                false
            }
            None => {
                let renderer = renderer();
                let tile = cx.new(|_| TileView {
                    renderer,
                    size,
                    rendered_at: None,
                });
                self.tiles.insert(key.clone(), (tile, revision));
                false
            }
        };
        let tile = self.tiles[key].0.clone();
        if reusable && !live && tile.read(cx).is_fresh() {
            tile.cached(StyleRefinement::default().size_full())
                .into_any_element()
        } else {
            tile.into_any_element()
        }
    }

    /// Forgets the tiles of items that are gone.
    pub fn retain(&mut self, mut keep: impl FnMut(&str) -> bool) {
        self.tiles.retain(|key, _| keep(key));
    }
}

impl TileView {
    /// Rendered at least once, so there is a paint to reuse.
    fn is_fresh(&self) -> bool {
        self.rendered_at.is_some()
    }
}
