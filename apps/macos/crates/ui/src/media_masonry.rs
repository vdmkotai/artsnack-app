//! Column masonry for feeds of results (the web's `MediaMasonry`): equal-width
//! columns, each item in the shortest one, its height taken from its aspect
//! ratio, so portrait and landscape results line up without cropping:
//!
//! - columns `floor((width + gap) / (13.75rem × tile scale + gap))`, at least
//!   one;
//! - an item goes into the shortest column, ties to the leftmost, so equal
//!   tiles read left to right in a newest-first feed.
//!
//! Only the cells within about a screen of the viewport exist as elements; the
//! rest are numbers. A column's cells are stored top to bottom, so finding the
//! visible ones is a binary search per column, and a frame costs the same with
//! fifty items as with five thousand. Scrolling re-renders the owning view (a
//! scroll notifies the view whose element scrolled), which asks for the new
//! visible set.
//!
//! When the layout changes — a result lands at the top, a filter, a measured
//! aspect, a narrower pane — the item at the top of the viewport is found again
//! by its key, so the view does not jump; if it is gone (deleted, filtered
//! out), its nearest surviving neighbour takes its place. A grid scrolled to the
//! very top stays there, so a new result above is seen, and a scroll offset past
//! the end of a shorter layout is pulled back before anything is drawn from it.
//!
//! The owner drives it from `render`: [`MediaMasonryState::set_items`] when
//! its items change, [`MediaMasonryState::prepare`] every frame, then
//! [`MediaMasonryState::render_cached`] (or [`MediaMasonryState::visible_items`]
//! and [`MediaMasonryState::render`] with a tile for each).

use std::{
    cell::{Cell, RefCell},
    collections::HashMap,
    rc::Rc,
};

use gpui_kit::{
    AnyElement, App, Bounds, Entity, EntityId, InteractiveElement as _, IntoElement,
    ParentElement as _, Pixels, Rems, ScrollHandle, SharedString, Size,
    StatefulInteractiveElement as _, Styled as _, Window, canvas,
    component::scroll::ScrollableElement as _, div, point, px, rems, size,
};

use crate::tile_cache::TileCache;

/// The geometry inputs of a masonry, in pixels.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct MasonryParams {
    pub width: f32,
    /// The narrowest a column may get before the grid drops one.
    pub min_column_width: f32,
    pub gap: f32,
}

/// Where one item sits, relative to the top left of the masonry.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct MasonryCell {
    pub x: f32,
    pub y: f32,
    pub width: f32,
    pub height: f32,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct MasonryLayout {
    /// The width the columns fill.
    pub width: f32,
    pub columns: usize,
    pub column_width: f32,
    /// The bottom of the tallest column; the gap below it is not included.
    pub height: f32,
    cells: Vec<MasonryCell>,
    /// Each column's items, top to bottom.
    column_items: Vec<Vec<usize>>,
}

impl MasonryLayout {
    pub fn cell(&self, ix: usize) -> Option<MasonryCell> {
        self.cells.get(ix).copied()
    }

    pub fn len(&self) -> usize {
        self.cells.len()
    }

    pub fn is_empty(&self) -> bool {
        self.cells.is_empty()
    }

    /// The items whose cells overlap `top..=bottom`, in item order.
    pub fn items_between(&self, top: f32, bottom: f32) -> Vec<usize> {
        let mut items = Vec::new();
        for column in &self.column_items {
            let start = column.partition_point(|&ix| {
                let cell = &self.cells[ix];
                cell.y + cell.height < top
            });
            for &ix in &column[start..] {
                if self.cells[ix].y > bottom {
                    break;
                }
                items.push(ix);
            }
        }
        items.sort_unstable();
        items
    }
}

/// Lays `aspects` (width ÷ height, one per item) out in columns.
pub fn masonry(aspects: &[f32], params: MasonryParams) -> MasonryLayout {
    let MasonryParams {
        width,
        min_column_width,
        gap,
    } = params;
    if width <= 0.0 || min_column_width <= 0.0 {
        return MasonryLayout::default();
    }
    let columns = (((width + gap) / (min_column_width + gap)).floor() as usize).max(1);
    let column_width = (width - gap * (columns - 1) as f32) / columns as f32;
    let mut heights = vec![0.0f32; columns];
    let mut column_items = vec![Vec::new(); columns];
    let mut cells = Vec::with_capacity(aspects.len());
    for (ix, aspect) in aspects.iter().enumerate() {
        let mut target = 0;
        for column in 1..columns {
            // Half a pixel of slack, so columns of equal tiles fill left to right.
            if heights[column] < heights[target] - 0.5 {
                target = column;
            }
        }
        let aspect = if aspect.is_finite() && *aspect > 0.0 {
            *aspect
        } else {
            1.0
        };
        let height = column_width / aspect;
        cells.push(MasonryCell {
            x: target as f32 * (column_width + gap),
            y: heights[target],
            width: column_width,
            height,
        });
        heights[target] += height + gap;
        column_items[target].push(ix);
    }
    let tallest = heights.iter().copied().fold(0.0f32, f32::max);
    MasonryLayout {
        width,
        columns,
        column_width,
        height: (tallest - gap).max(0.0),
        cells,
        column_items,
    }
}

/// The item to keep in place across a relayout: where the item at the top of
/// the viewport (`top`, `height`, in the old `layout`'s coordinates) is in the
/// new `keys`, and how far below the viewport's top its cell started. `None` at
/// the very top. If that item is gone, the nearest one that survives stands in:
/// the next ones in the old order first (they move up into its place), then
/// the ones before it.
fn find_anchor(
    layout: &MasonryLayout,
    layout_keys: &[SharedString],
    keys: &[SharedString],
    top: f32,
    height: f32,
) -> Option<(usize, f32)> {
    if top <= 0.5 {
        return None;
    }
    let first = layout
        .items_between(top, top + height)
        .into_iter()
        .min_by(|a, b| layout.cells[*a].y.total_cmp(&layout.cells[*b].y))?;
    let new_ix: HashMap<&SharedString, usize> =
        keys.iter().enumerate().map(|(ix, key)| (key, ix)).collect();
    (first..layout_keys.len())
        .chain((0..first).rev())
        .find_map(|old_ix| {
            let ix = *new_ix.get(layout_keys.get(old_ix)?)?;
            Some((ix, layout.cells.get(old_ix)?.y - top))
        })
}

/// `scroll_top` pulled back so the viewport does not start past the end of
/// content `content_height` tall.
fn clamp_scroll_top(scroll_top: f32, content_height: f32, viewport_height: f32) -> f32 {
    scroll_top.min((content_height - viewport_height).max(0.0))
}

type NearEndHandler = Rc<dyn Fn(&mut App)>;

/// How far past the viewport, in viewport heights, cells are built: a flick
/// does not outrun them, and the next screen's images are already loading.
const OVERDRAW_SCREENS: f32 = 0.75;
/// `on_near_end` fires while the end of the layout is within this many viewport
/// heights below the viewport (the web sentinel's `rootMargin: 150%`).
const NEAR_END_SCREENS: f32 = 1.5;

/// The pixel sizes of one layout pass, resolved from rems.
#[derive(Clone, Copy, Debug, PartialEq)]
struct Geometry {
    params: MasonryParams,
    padding_x: f32,
    padding_y: f32,
}

/// Retained masonry state, owned by the screen that shows the grid.
pub struct MediaMasonryState {
    scroll: ScrollHandle,
    layout: Rc<MasonryLayout>,
    /// The keys `layout` was made for, to find the anchor in it.
    layout_keys: Vec<SharedString>,
    keys: Vec<SharedString>,
    aspects: Vec<f32>,
    dirty: bool,
    geometry: Option<Geometry>,
    /// The viewport's size from the last paint. Read on the next render.
    viewport: Rc<Cell<Size<Pixels>>>,
    near_end: Rc<RefCell<Option<NearEndHandler>>>,
    min_column_width: Rems,
    gap: Rems,
    padding_x: Rems,
    padding_y: Rems,
    tiles: Rc<TileCache>,
}

impl Default for MediaMasonryState {
    fn default() -> Self {
        Self::new()
    }
}

impl MediaMasonryState {
    /// The web's geometry: 220 px columns at 100 %, a 6 px gutter.
    pub fn new() -> Self {
        Self {
            scroll: ScrollHandle::new(),
            layout: Rc::new(MasonryLayout::default()),
            layout_keys: Vec::new(),
            keys: Vec::new(),
            aspects: Vec::new(),
            dirty: false,
            geometry: None,
            viewport: Rc::new(Cell::new(size(px(0.), px(0.)))),
            near_end: Rc::new(RefCell::new(None)),
            min_column_width: rems(13.75),
            gap: rems(0.375),
            padding_x: rems(0.),
            padding_y: rems(0.),
            tiles: Rc::new(TileCache::default()),
        }
    }

    /// Space between the grid and the edges of its scroll area, inside it, so
    /// the scrollbar stays at the edge.
    pub fn with_padding(mut self, horizontal: Rems, vertical: Rems) -> Self {
        self.padding_x = horizontal;
        self.padding_y = vertical;
        self
    }

    /// The items, in display order: a stable key and an aspect ratio (width ÷
    /// height) each. Lays out again on the next [`Self::prepare`] if either
    /// changed.
    pub fn set_items(&mut self, keys: Vec<SharedString>, aspects: Vec<f32>) {
        if keys == self.keys && aspects == self.aspects {
            return;
        }
        self.keys = keys;
        self.aspects = aspects;
        self.dirty = true;
    }

    /// Item `ix`'s real aspect became known (its preview decoded).
    pub fn set_aspect(&mut self, ix: usize, aspect: f32) {
        if let Some(current) = self.aspects.get_mut(ix)
            && (*current - aspect).abs() > f32::EPSILON
        {
            *current = aspect;
            self.dirty = true;
        }
    }

    /// Calls `handler` (deferred, after the frame) whenever the end of the
    /// layout is near the viewport — for loading the next page. It goes by the
    /// layout, not by scrolling, so a first page shorter than the window still
    /// asks for more. It fires on every such frame; the handler must ignore
    /// repeats.
    pub fn on_near_end(&self, handler: impl Fn(&mut App) + 'static) {
        *self.near_end.borrow_mut() = Some(Rc::new(handler));
    }

    /// Lays the items out again if anything that shapes the layout changed:
    /// the items, the width, the tile scale or the rem size. Call from
    /// `render`, before [`Self::visible_items`].
    pub fn prepare(&mut self, tile_scale: f32, window: &Window) {
        let rem = window.rem_size();
        let to_px = |value: Rems| value.to_pixels(rem).as_f32();
        let padding_x = to_px(self.padding_x);
        let geometry = Geometry {
            params: MasonryParams {
                width: (self.viewport.get().width.as_f32() - 2.0 * padding_x).max(0.0),
                min_column_width: to_px(self.min_column_width) * tile_scale,
                gap: to_px(self.gap),
            },
            padding_x,
            padding_y: to_px(self.padding_y),
        };
        if !self.dirty && self.geometry == Some(geometry) {
            return;
        }

        let anchor = self.anchor();
        let layout = masonry(&self.aspects, geometry.params);
        if let Some((ix, offset)) = anchor
            && let Some(cell) = layout.cell(ix)
        {
            let top = (cell.y - offset).max(0.0) + geometry.padding_y;
            self.scroll.set_offset(point(px(0.), px(-top)));
        }
        // A shorter layout: the offset may now point past its end, and the
        // scroll area would only pull it back while painting — after this
        // frame's visible items were taken from it, leaving the grid empty.
        let content_height = layout.height + 2.0 * geometry.padding_y;
        let scroll_top = -self.scroll.offset().y.as_f32();
        let clamped = clamp_scroll_top(
            scroll_top,
            content_height,
            self.viewport.get().height.as_f32(),
        );
        if clamped < scroll_top {
            self.scroll.set_offset(point(px(0.), px(-clamped)));
        }
        self.layout = Rc::new(layout);
        self.layout_keys = self.keys.clone();
        self.geometry = Some(geometry);
        self.dirty = false;
        self.tiles.invalidate();
    }

    /// The item to keep in place across this relayout; see [`find_anchor`].
    fn anchor(&self) -> Option<(usize, f32)> {
        let (top, height) = self.viewport_in_layout();
        find_anchor(&self.layout, &self.layout_keys, &self.keys, top, height)
    }

    /// The viewport's top and height in layout coordinates.
    fn viewport_in_layout(&self) -> (f32, f32) {
        let padding_y = self.geometry.map(|g| g.padding_y).unwrap_or(0.0);
        let scroll_top = (-self.scroll.offset().y.as_f32()).max(0.0);
        (scroll_top - padding_y, self.viewport.get().height.as_f32())
    }

    /// The current layout: its columns and height, and every item's cell.
    pub fn layout(&self) -> &MasonryLayout {
        &self.layout
    }

    /// The viewport as `(top, height)` in layout coordinates, from the last
    /// paint — what a scheduler ranks visible cells against.
    pub fn viewport(&self) -> (f32, f32) {
        self.viewport_in_layout()
    }

    /// The items near the viewport, in item order: the ones to build tiles for.
    pub fn visible_items(&self) -> Vec<usize> {
        let (top, height) = self.viewport_in_layout();
        let margin = height * OVERDRAW_SCREENS;
        self.layout
            .items_between(top - margin, top + height + margin)
    }

    /// Scrolls back to the first row.
    pub fn scroll_to_top(&self) {
        self.scroll.set_offset(point(px(0.), px(0.)));
    }

    /// Draws every tile afresh next frame, for a change the owner made
    /// without notifying itself (see [`Self::render_cached`]).
    pub fn invalidate_tiles(&self) {
        self.tiles.invalidate();
    }

    /// The grid element with a tile for each of [`Self::visible_items`], each
    /// in a cached view of its own (see `tile_cache`): a re-render of `owner`
    /// that changed nothing in the grid — a playing clip's frame, a spinner
    /// elsewhere on the screen — reuses every tile but the live ones instead
    /// of rebuilding them. Tiles are drawn afresh after `owner` is notified,
    /// after a new layout, and when a view inside them is notified;
    /// `is_live(ix)` tiles (one with a playing clip:
    /// `ClipPlayers::is_playing`) are drawn afresh every time.
    ///
    /// `render_tile` runs later, while the tile's own view renders, so it must
    /// reach the owner's state through `owner.update(cx, …)` or captured
    /// values, not a borrow of the owner. Everything a tile shows must change
    /// together with a notification of `owner` or of a view in the tile.
    pub fn render_cached<V: 'static>(
        &self,
        owner: &Entity<V>,
        is_live: impl Fn(usize) -> bool,
        render_tile: impl Fn(usize, Size<Pixels>, &mut Window, &mut App) -> AnyElement + 'static,
        cx: &mut App,
    ) -> impl IntoElement {
        self.tiles.begin(owner, cx);
        let render_tile = Rc::new(render_tile);
        let tiles: Vec<(usize, AnyElement)> = self
            .visible_items()
            .into_iter()
            .filter_map(|ix| {
                let key = self.layout_keys.get(ix)?;
                let cell = self.layout.cell(ix)?;
                let size = size(px(cell.width), px(cell.height));
                let render_tile = render_tile.clone();
                let tile = self.tiles.tile(
                    key,
                    is_live(ix),
                    Rc::new(move |window, cx| render_tile(ix, size, window, cx)),
                    cx,
                );
                Some((ix, tile))
            })
            .collect();
        self.render(owner.entity_id(), tiles)
    }

    /// The grid element, with `tiles` (item index and its element, as
    /// [`Self::visible_items`] named them) placed in their cells. `view` is
    /// re-rendered when the viewport's size changes.
    ///
    /// Every tile is built anew whenever `view` re-renders; prefer
    /// [`Self::render_cached`].
    pub fn render(
        &self,
        view: EntityId,
        tiles: impl IntoIterator<Item = (usize, AnyElement)>,
    ) -> impl IntoElement {
        let layout = self.layout.clone();
        let geometry = self.geometry;
        let (padding_x, padding_y) = geometry
            .map(|g| (g.padding_x, g.padding_y))
            .unwrap_or_default();
        let content_height = layout.height + 2.0 * padding_y;
        let cells = tiles.into_iter().filter_map(|(ix, tile)| {
            let cell = layout.cell(ix)?;
            Some(
                div()
                    .absolute()
                    .left(px(padding_x + cell.x))
                    .top(px(padding_y + cell.y))
                    .w(px(cell.width))
                    .h(px(cell.height))
                    .child(tile),
            )
        });

        let viewport = self.viewport.clone();
        let near_end = self.near_end.clone();
        let scroll = self.scroll.clone();
        let laid_out = layout.columns > 0;

        div()
            .relative()
            .size_full()
            .child(
                div()
                    .id("media-masonry")
                    .size_full()
                    .overflow_y_scroll()
                    .track_scroll(&self.scroll)
                    .child(
                        div()
                            .relative()
                            .w_full()
                            .h(px(content_height))
                            .children(cells),
                    ),
            )
            // Measures the viewport for the next layout, asking for one more
            // frame only when it changed, and reports a near end. After the
            // scroll area in paint order, so its offset is already clamped.
            // A notification during the draw itself would be dropped (GPUI
            // neither marks the view nor schedules a frame then), so it is
            // sent on the next frame.
            .child(
                canvas(
                    move |bounds: Bounds<Pixels>, window, cx| {
                        let measured = bounds.size;
                        let previous = viewport.get();
                        let moved = |a: Pixels, b: Pixels| (a.as_f32() - b.as_f32()).abs() > 0.5;
                        // A width of 0 is a hidden pane, not a layout to keep.
                        if measured.width > px(0.)
                            && (moved(measured.width, previous.width)
                                || moved(measured.height, previous.height))
                        {
                            viewport.set(measured);
                            window.on_next_frame(move |_, cx| cx.notify(view));
                        }
                        let scroll_top = -scroll.offset().y.as_f32();
                        let reach = measured.height.as_f32() * (1.0 + NEAR_END_SCREENS);
                        if laid_out && scroll_top + reach >= content_height {
                            let handler = near_end.borrow().clone();
                            if let Some(handler) = handler {
                                cx.defer(move |cx| handler(cx));
                            }
                        }
                    },
                    |_, _, _, _| {},
                )
                .absolute()
                .size_full(),
            )
            .vertical_scrollbar(&self.scroll)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const PARAMS: MasonryParams = MasonryParams {
        width: 1000.0,
        min_column_width: 220.0,
        gap: 6.0,
    };

    #[test]
    fn fits_as_many_columns_as_the_minimum_width_allows() {
        // (1000 + 6) / (220 + 6) = 4.45 → four columns of (1000 − 18) / 4.
        let layout = masonry(&[1.0], PARAMS);
        assert_eq!(layout.columns, 4);
        assert_eq!(layout.column_width, 245.5);
        let narrow = masonry(
            &[1.0],
            MasonryParams {
                width: 100.0,
                ..PARAMS
            },
        );
        assert_eq!(narrow.columns, 1);
        assert_eq!(narrow.column_width, 100.0);
    }

    #[test]
    fn places_each_item_in_the_shortest_column_ties_to_the_left() {
        let params = MasonryParams {
            width: 206.0,
            min_column_width: 100.0,
            gap: 6.0,
        };
        // Two 100-wide columns: a tall item left, then two squares right.
        let layout = masonry(&[0.5, 1.0, 1.0, 1.0], params);
        let cell = |ix| layout.cell(ix).unwrap();
        assert_eq!((cell(0).x, cell(0).y, cell(0).height), (0.0, 0.0, 200.0));
        assert_eq!((cell(1).x, cell(1).y), (106.0, 0.0));
        assert_eq!((cell(2).x, cell(2).y), (106.0, 106.0));
        // Left is 206 tall, right 212: the fourth goes left.
        assert_eq!((cell(3).x, cell(3).y), (0.0, 206.0));
        assert_eq!(layout.height, 306.0);
    }

    #[test]
    fn bad_aspects_fall_back_to_square_and_zero_width_lays_out_nothing() {
        let layout = masonry(&[f32::NAN, 0.0], PARAMS);
        assert_eq!(layout.cell(0).unwrap().height, layout.column_width);
        assert!(
            masonry(
                &[1.0],
                MasonryParams {
                    width: 0.0,
                    ..PARAMS
                }
            )
            .is_empty()
        );
    }

    fn keys(names: &[&str]) -> Vec<SharedString> {
        names
            .iter()
            .map(|name| SharedString::from(name.to_string()))
            .collect()
    }

    #[test]
    fn keeps_the_top_item_or_its_nearest_survivor_in_place() {
        let params = MasonryParams {
            width: 100.0,
            min_column_width: 100.0,
            gap: 0.0,
        };
        // One column of 100-tall squares; the viewport starts 30 into "c".
        let old = masonry(&[1.0; 5], params);
        let old_keys = keys(&["a", "b", "c", "d", "e"]);
        // "c" is still there, now third of four: it stays 70 above the top.
        let anchor = find_anchor(&old, &old_keys, &keys(&["a", "c", "d", "e"]), 230.0, 100.0);
        assert_eq!(anchor, Some((1, -30.0)));
        // "c" was deleted: "d", which moves up into its place, stands in.
        let anchor = find_anchor(&old, &old_keys, &keys(&["a", "b", "d", "e"]), 230.0, 100.0);
        assert_eq!(anchor, Some((2, 70.0)));
        // Everything from "c" on was filtered out: "b", before it, stands in.
        let anchor = find_anchor(&old, &old_keys, &keys(&["a", "b"]), 230.0, 100.0);
        assert_eq!(anchor, Some((1, -130.0)));
        assert_eq!(find_anchor(&old, &old_keys, &old_keys, 0.0, 100.0), None);
    }

    #[test]
    fn pulls_a_scroll_past_the_end_back() {
        assert_eq!(clamp_scroll_top(900.0, 500.0, 300.0), 200.0);
        assert_eq!(clamp_scroll_top(100.0, 500.0, 300.0), 100.0);
        assert_eq!(clamp_scroll_top(100.0, 200.0, 300.0), 0.0);
    }

    #[test]
    fn finds_the_items_overlapping_a_band() {
        let params = MasonryParams {
            width: 100.0,
            min_column_width: 100.0,
            gap: 0.0,
        };
        // One column of 100-tall squares: item n spans n×100 .. (n+1)×100.
        let layout = masonry(&[1.0; 10], params);
        assert_eq!(layout.items_between(250.0, 420.0), [2, 3, 4]);
        assert_eq!(layout.items_between(-50.0, 0.0), [0]);
        assert!(layout.items_between(2000.0, 3000.0).is_empty());
    }
}
