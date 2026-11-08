//! The results grid: rows of one height, each tile as wide as its aspect ratio
//! makes it, wrapping when a row is full — the web's `ImageGrid` layout:
//!
//! - row height `clamp(10rem, 30% of the width, 17.5rem) × tile scale`;
//! - tile width `min(row height × aspect, grid width)`, and at least
//!   `min(10rem × tile scale, grid width)`, its height following its aspect;
//! - tiles top-aligned, the right edge ragged.
//!
//! Only the rows on screen exist as elements (GPUI's `list`). When the items
//! change — a new result at the top, a filter — the row at the top of the
//! viewport is found again by the key of its first tile, so the view does not
//! jump. A grid scrolled to the very top stays there, so a new result above
//! is seen.

use std::{
    cell::{Cell, RefCell},
    ops::Range,
    rc::Rc,
};

use gpui_kit::{
    AnyElement, App, Bounds, Entity, EntityId, IntoElement, ListAlignment, ListOffset, ListState,
    ParentElement as _, Pixels, SharedString, Size, Styled as _, Window, canvas,
    component::scroll::ScrollableElement as _, div, list, px, rems, size,
};

use crate::tile_cache::TileCache;

/// The geometry inputs of a flow, in pixels.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct FlowParams {
    pub width: f32,
    pub row_height: f32,
    pub min_tile_width: f32,
    pub gap: f32,
}

#[derive(Clone, Debug, PartialEq)]
pub struct TileBox {
    /// Index into the items.
    pub ix: usize,
    pub x: f32,
    pub width: f32,
    pub height: f32,
}

#[derive(Clone, Debug, PartialEq)]
pub struct GridRow {
    pub tiles: Vec<TileBox>,
    /// The tallest tile; the gap below is not included.
    pub height: f32,
}

impl GridRow {
    fn items(&self) -> Range<usize> {
        match (self.tiles.first(), self.tiles.last()) {
            (Some(first), Some(last)) => first.ix..last.ix + 1,
            _ => 0..0,
        }
    }
}

/// Lays `aspects` (width ÷ height, one per item) out in rows.
pub fn flow(aspects: &[f32], params: FlowParams) -> Vec<GridRow> {
    let FlowParams {
        width,
        row_height,
        min_tile_width,
        gap,
    } = params;
    if width <= 0.0 || row_height <= 0.0 {
        return Vec::new();
    }
    let floor = min_tile_width.min(width);
    let mut rows: Vec<GridRow> = Vec::new();
    let mut current = GridRow {
        tiles: Vec::new(),
        height: 0.0,
    };
    let mut x = 0.0f32;
    for (ix, aspect) in aspects.iter().enumerate() {
        let aspect = if aspect.is_finite() && *aspect > 0.0 {
            *aspect
        } else {
            1.0
        };
        let tile_width = (row_height * aspect).min(width).max(floor);
        let tile_height = tile_width / aspect;
        let needed = if current.tiles.is_empty() {
            tile_width
        } else {
            gap + tile_width
        };
        if !current.tiles.is_empty() && x + needed > width + 0.5 {
            rows.push(std::mem::replace(
                &mut current,
                GridRow {
                    tiles: Vec::new(),
                    height: 0.0,
                },
            ));
            x = 0.0;
        }
        if !current.tiles.is_empty() {
            x += gap;
        }
        current.tiles.push(TileBox {
            ix,
            x,
            width: tile_width,
            height: tile_height,
        });
        current.height = current.height.max(tile_height);
        x += tile_width;
    }
    if !current.tiles.is_empty() {
        rows.push(current);
    }
    rows
}

type TileRenderer = dyn Fn(usize, Size<Pixels>, &mut Window, &mut App) -> AnyElement;
type NearEndHandler = Rc<dyn Fn(&mut App)>;
type VisibleTiles = Vec<(usize, Bounds<Pixels>)>;

/// How many rows before the last one `on_near_end` fires.
const NEAR_END_ROWS: usize = 3;

/// Retained grid state, owned by the screen that shows the grid.
///
/// The owner drives it from `render`: [`Self::set_items`] when its items
/// change (cheap to repeat with the same shared slices), [`Self::prepare`]
/// every frame, then [`Self::render_cached`] (or [`Self::render`]).
pub struct MediaGridState {
    list: ListState,
    rows: Rc<Vec<GridRow>>,
    /// The keys `rows` were laid out for, to find the anchor and the tiles.
    layout_keys: Rc<[SharedString]>,
    keys: Rc<[SharedString]>,
    aspects: Rc<[f32]>,
    /// The items changed since the last layout.
    dirty: bool,
    params: Option<FlowParams>,
    /// The grid's width from the last paint. Read on the next render.
    width: Rc<Cell<f32>>,
    near_end: Rc<RefCell<Option<NearEndHandler>>>,
    /// What [`Self::visible_tiles`] answered this frame, checked against the
    /// layout once it is done.
    visible_answer: Rc<RefCell<Option<VisibleTiles>>>,
    tiles: Rc<TileCache>,
}

impl Default for MediaGridState {
    fn default() -> Self {
        Self::new()
    }
}

impl MediaGridState {
    pub fn new() -> Self {
        Self {
            list: ListState::new(0, ListAlignment::Top, px(800.)),
            rows: Rc::new(Vec::new()),
            layout_keys: Rc::from([]),
            keys: Rc::from([]),
            aspects: Rc::from([]),
            dirty: false,
            params: None,
            width: Rc::new(Cell::new(0.0)),
            near_end: Rc::new(RefCell::new(None)),
            visible_answer: Rc::new(RefCell::new(None)),
            tiles: Rc::new(TileCache::default()),
        }
    }

    /// The items, in display order: a stable key and an aspect ratio (width ÷
    /// height) each. Lays out again on the next [`Self::prepare`] if either
    /// changed. Passing the same `Rc` slices as last time costs nothing, so an
    /// owner that keeps them with its data can call this every frame.
    pub fn set_items(
        &mut self,
        keys: impl Into<Rc<[SharedString]>>,
        aspects: impl Into<Rc<[f32]>>,
    ) {
        let (keys, aspects) = (keys.into(), aspects.into());
        let same_keys = Rc::ptr_eq(&keys, &self.keys) || keys == self.keys;
        let same_aspects = Rc::ptr_eq(&aspects, &self.aspects) || aspects == self.aspects;
        if same_keys && same_aspects {
            return;
        }
        self.keys = keys;
        self.aspects = aspects;
        self.dirty = true;
    }

    /// Item `ix`'s real aspect became known (its preview decoded).
    pub fn set_aspect(&mut self, ix: usize, aspect: f32) {
        if self
            .aspects
            .get(ix)
            .is_some_and(|current| (current - aspect).abs() > f32::EPSILON)
        {
            let mut aspects = self.aspects.to_vec();
            aspects[ix] = aspect;
            self.aspects = aspects.into();
            self.dirty = true;
        }
    }

    /// Lays the items out again if anything that shapes the layout changed:
    /// the items, the width, the tile scale or the rem size. Call from
    /// `render`, every frame; it costs nothing when nothing changed.
    pub fn prepare(&mut self, tile_scale: f32, window: &Window) {
        let width = self.width.get();
        let rem = window.rem_size();
        let row_height = (width * 0.3).clamp(
            rems(10.).to_pixels(rem).as_f32(),
            rems(17.5).to_pixels(rem).as_f32(),
        ) * tile_scale;
        let params = FlowParams {
            width,
            row_height,
            min_tile_width: rems(10.).to_pixels(rem).as_f32() * tile_scale,
            gap: rems(0.5).to_pixels(rem).as_f32(),
        };
        if !self.dirty && Some(params) == self.params {
            return;
        }

        // Remember which item sits at the top of the viewport — unless that
        // is the very top, where a new result should push the rest down.
        let anchor = {
            let top = self.list.logical_scroll_top();
            let at_top = top.item_ix == 0 && top.offset_in_item <= px(0.5);
            (!at_top)
                .then(|| self.rows.get(top.item_ix))
                .flatten()
                .and_then(|row| row.tiles.first())
                .and_then(|tile| self.layout_keys.get(tile.ix).cloned())
                .map(|key| (key, top.offset_in_item))
        };

        let rows = flow(&self.aspects, params);
        self.list.reset(rows.len());
        if let Some((key, offset)) = anchor
            && let Some(ix) = self.keys.iter().position(|candidate| *candidate == key)
            && let Some(row_ix) = rows.iter().position(|row| row.items().contains(&ix))
        {
            self.list.scroll_to(ListOffset {
                item_ix: row_ix,
                offset_in_item: offset,
            });
        }
        self.rows = Rc::new(rows);
        self.layout_keys = self.keys.clone();
        self.params = Some(params);
        self.dirty = false;
        self.tiles.invalidate();
    }

    /// [`Self::set_items`] and [`Self::prepare`] in one call.
    ///
    /// Superseded by those two: this takes fresh vectors and compares them
    /// whole on every render, which is O(items) per frame — and with a playing
    /// clip, per clip frame. Kept for owners that have not moved yet.
    pub fn sync(
        &mut self,
        keys: Vec<SharedString>,
        aspects: Vec<f32>,
        tile_scale: f32,
        window: &Window,
    ) {
        self.set_items(keys, aspects);
        self.prepare(tile_scale, window);
    }

    /// Draws every tile afresh next frame, for a change the owner made
    /// without notifying itself (see [`Self::render_cached`]).
    pub fn invalidate_tiles(&self) {
        self.tiles.invalidate();
    }

    /// Calls `handler` (deferred, after the frame) whenever one of the last
    /// rows is laid out — for loading the next page. Layout rather than
    /// scrolling, so a first page shorter than the window still asks for more.
    /// It fires on every such frame; the handler must ignore repeats.
    pub fn on_near_end(&self, handler: impl Fn(&mut App) + 'static) {
        *self.near_end.borrow_mut() = Some(Rc::new(handler));
    }

    /// The range of items whose rows are at least partly visible.
    pub fn row_count(&self) -> usize {
        self.rows.len()
    }

    /// Items in rows `rows`.
    pub fn items_in_rows(&self, rows: Range<usize>) -> Range<usize> {
        let first = rows
            .clone()
            .find_map(|row| self.rows.get(row).map(|row| row.items().start));
        let last = rows
            .rev()
            .find_map(|row| self.rows.get(row).map(|row| row.items().end));
        match (first, last) {
            (Some(first), Some(last)) => first..last,
            _ => 0..0,
        }
    }

    /// Every tile on screen and its bounds in window coordinates, from the
    /// last layout (for choosing which clips play).
    ///
    /// The last layout is the previous frame's. If this frame's layout turns
    /// out different (a scroll, a resize, new items), the grid asks for one
    /// more frame of the view it renders in, so a choice made from this answer
    /// is made again from the current one.
    pub fn visible_tiles(&self) -> Vec<(usize, Bounds<Pixels>)> {
        let tiles = visible_tiles(&self.list, &self.rows);
        *self.visible_answer.borrow_mut() = Some(tiles.clone());
        tiles
    }

    /// The grid's visible area in window coordinates, from the last layout.
    pub fn viewport(&self) -> Bounds<Pixels> {
        self.list.viewport_bounds()
    }

    /// Scrolls so item `ix` is visible.
    pub fn reveal_item(&self, ix: usize) {
        if let Some(row) = self.rows.iter().position(|row| row.items().contains(&ix)) {
            self.list.scroll_to_reveal_item(row);
        }
    }

    /// The grid element. `view` is re-rendered when the width changes;
    /// `render_tile` draws item `ix` at the given size.
    ///
    /// Every tile is rebuilt whenever `view` re-renders; prefer
    /// [`Self::render_cached`].
    pub fn render(
        &self,
        view: EntityId,
        render_tile: impl Fn(usize, Size<Pixels>, &mut Window, &mut App) -> AnyElement + 'static,
    ) -> impl IntoElement {
        let render_tile: Rc<TileRenderer> = Rc::new(render_tile);
        self.render_rows(view, move |ix, size, window, cx| {
            render_tile(ix, size, window, cx)
        })
    }

    /// The grid element with each tile in a cached view of its own (see
    /// `tile_cache`): a re-render of `owner` that changed nothing in the grid
    /// — a playing clip's frame, a spinner elsewhere on the screen — reuses
    /// every tile but the live ones instead of rebuilding them. Tiles are
    /// drawn afresh after `owner` is notified, after a new layout, and when a
    /// view inside them is notified; `is_live(ix)` tiles (one with a playing
    /// clip: `ClipPlayers::is_playing`) are drawn afresh every time.
    ///
    /// `render_tile` runs later, while the tile's own view renders, so it must
    /// reach the owner's state through `owner.update(cx, …)` or captured
    /// values, not a borrow of the owner. Everything a tile shows must change
    /// together with a notification of `owner` or of a view in the tile.
    pub fn render_cached<V: 'static>(
        &self,
        owner: &Entity<V>,
        is_live: impl Fn(usize) -> bool + 'static,
        render_tile: impl Fn(usize, Size<Pixels>, &mut Window, &mut App) -> AnyElement + 'static,
        cx: &mut App,
    ) -> impl IntoElement {
        self.tiles.begin(owner, cx);
        let render_tile: Rc<TileRenderer> = Rc::new(render_tile);
        let tiles = self.tiles.clone();
        let keys = self.layout_keys.clone();
        self.render_rows(owner.entity_id(), move |ix, size, _, cx| {
            let Some(key) = keys.get(ix) else {
                return div().into_any_element();
            };
            let render_tile = render_tile.clone();
            tiles.tile(
                key,
                is_live(ix),
                Rc::new(move |window, cx| render_tile(ix, size, window, cx)),
                cx,
            )
        })
    }

    fn render_rows(
        &self,
        view: EntityId,
        render_tile: impl Fn(usize, Size<Pixels>, &mut Window, &mut App) -> AnyElement + 'static,
    ) -> impl IntoElement {
        let rows = self.rows.clone();
        let gap = self.params.map(|params| params.gap).unwrap_or(0.0);
        let width = self.width.clone();
        let near_end = self.near_end.clone();
        let list_state = self.list.clone();
        let laid_out_rows = self.rows.clone();
        let visible_answer = self.visible_answer.clone();

        div()
            .relative()
            .size_full()
            .child(
                list(self.list.clone(), move |row_ix, window, cx| {
                    let Some(row) = rows.get(row_ix) else {
                        return div().into_any_element();
                    };
                    if row_ix + NEAR_END_ROWS >= rows.len() {
                        let handler = near_end.borrow().clone();
                        if let Some(handler) = handler {
                            cx.defer(move |cx| handler(cx));
                        }
                    }
                    div()
                        .relative()
                        .w_full()
                        .h(px(row.height + gap))
                        .children(row.tiles.iter().map(|tile| {
                            div()
                                .absolute()
                                .top_0()
                                .left(px(tile.x))
                                .w(px(tile.width))
                                .h(px(tile.height))
                                .child(render_tile(
                                    tile.ix,
                                    size(px(tile.width), px(tile.height)),
                                    window,
                                    cx,
                                ))
                        }))
                        .into_any_element()
                })
                .size_full(),
            )
            // After the list in paint order, so its layout is this frame's:
            // measures the width for the next layout, and checks the visible
            // tiles the owner chose from. Either asks for one more frame of
            // `view` — only when something changed. A notification during the
            // draw itself would be dropped, so it is sent on the next frame.
            .child(
                canvas(
                    move |bounds: Bounds<Pixels>, window, _| {
                        let mut stale = false;
                        if (bounds.size.width.as_f32() - width.get()).abs() > 0.5 {
                            width.set(bounds.size.width.as_f32());
                            stale = true;
                        }
                        if let Some(answer) = visible_answer.borrow_mut().take()
                            && answer != visible_tiles(&list_state, &laid_out_rows)
                        {
                            stale = true;
                        }
                        if stale {
                            window.on_next_frame(move |_, cx| cx.notify(view));
                        }
                    },
                    |_, _, _, _| {},
                )
                .absolute()
                .size_full(),
            )
            .vertical_scrollbar(&self.list)
    }
}

/// Every tile of `rows` on screen in `list`'s last layout, with its bounds in
/// window coordinates.
fn visible_tiles(list: &ListState, rows: &[GridRow]) -> VisibleTiles {
    let viewport = list.viewport_bounds();
    let mut tiles = Vec::new();
    let mut row_ix = list.logical_scroll_top().item_ix;
    while let Some(bounds) = list.bounds_for_item(row_ix) {
        if bounds.top() > viewport.bottom() {
            break;
        }
        if let Some(row) = rows.get(row_ix) {
            tiles.extend(row.tiles.iter().map(|tile| {
                (
                    tile.ix,
                    Bounds::new(
                        gpui_kit::point(bounds.left() + px(tile.x), bounds.top()),
                        size(px(tile.width), px(tile.height)),
                    ),
                )
            }));
        }
        row_ix += 1;
    }
    tiles
}

#[cfg(test)]
mod tests {
    use super::*;

    const PARAMS: FlowParams = FlowParams {
        width: 1000.0,
        row_height: 200.0,
        min_tile_width: 160.0,
        gap: 8.0,
    };

    #[test]
    fn wraps_when_a_row_is_full() {
        // Each square tile is 200 wide: four fit (4×200 + 3×8 = 824), the fifth wraps.
        let rows = flow(&[1.0; 5], PARAMS);
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].tiles.len(), 4);
        assert_eq!(rows[1].tiles[0].x, 0.0);
        assert_eq!(rows[0].tiles[1].x, 208.0);
    }

    #[test]
    fn narrow_tiles_get_the_minimum_width_and_keep_their_aspect() {
        let rows = flow(&[0.5], PARAMS);
        let tile = &rows[0].tiles[0];
        assert_eq!(tile.width, 160.0);
        assert_eq!(tile.height, 320.0);
        assert_eq!(rows[0].height, 320.0);
    }

    #[test]
    fn wide_tiles_are_capped_at_the_grid_width() {
        let rows = flow(&[10.0], PARAMS);
        assert_eq!(rows[0].tiles[0].width, 1000.0);
        assert_eq!(rows[0].tiles[0].height, 100.0);
    }

    #[test]
    fn bad_aspects_fall_back_to_square_and_zero_width_lays_out_nothing() {
        let rows = flow(&[f32::NAN, 0.0], PARAMS);
        assert_eq!(rows[0].tiles[0].width, 200.0);
        assert!(
            flow(
                &[1.0],
                FlowParams {
                    width: 0.0,
                    ..PARAMS
                }
            )
            .is_empty()
        );
    }
}
