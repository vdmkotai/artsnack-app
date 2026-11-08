//! History's layout: cards in equal columns, each row as tall as its tallest
//! card, then a footer.
//!
//! - One to five columns by the content width, at the web's breakpoints
//!   (`sm` 40rem, `lg` 64rem, `xl` 80rem, `2xl` 96rem).
//! - Only rows on screen exist as elements (GPUI's `list`, which measures
//!   them). A card whose content changed — a progress tick, a disclosure — has
//!   only its row measured again; a change of width or zoom re-measures all.
//! - When cards are added or removed, the card at the top of the viewport is
//!   found again by key, so the view does not jump. At the very top nothing is
//!   anchored, so a new generation shows up where the eye is.

use std::{cell::Cell, ops::Range, rc::Rc};

use gpui_kit::{
    AnyElement, App, Bounds, EntityId, IntoElement, ListAlignment, ListOffset, ListState,
    ParentElement as _, Pixels, SharedString, Styled as _, Window, canvas,
    component::scroll::ScrollableElement as _, div, list, px, rems,
};

/// Content width (rems) at which each further column starts.
const BREAKPOINTS: [f32; 4] = [40., 64., 80., 96.];
/// The rows' horizontal inset, inside the scroll owner so the scrollbar sits
/// at the window edge. Rows render it with `px_4`.
const INSET_REMS: f32 = 1.;
/// The gap between columns and between rows. Rows render it with `gap_6`/`pb_6`.
pub(crate) const GAP_REMS: f32 = 1.5;

#[derive(Clone, Copy, Debug, PartialEq)]
struct Layout {
    columns: usize,
    /// The measured width, in pixels.
    width: f32,
    rem: f32,
}

/// Retained grid state, owned by the screen. `R` is a card's revision: when it
/// changes, so may the card's height.
pub(crate) struct CardGrid<R> {
    list: ListState,
    /// The grid's width from the last paint. Read on the next render.
    width: Rc<Cell<f32>>,
    layout: Option<Layout>,
    /// The owner's revision of the cards last laid out.
    synced: Option<u64>,
    keys: Vec<SharedString>,
    revisions: Vec<R>,
}

pub(crate) fn columns_for(content_rems: f32) -> usize {
    1 + BREAKPOINTS
        .iter()
        .filter(|breakpoint| content_rems >= **breakpoint)
        .count()
}

fn row_count(cards: usize, columns: usize) -> usize {
    cards.div_ceil(columns.max(1))
}

impl<R: PartialEq> CardGrid<R> {
    pub fn new() -> Self {
        Self {
            // Overdraw is measured geometry, as in the media grid: rows this
            // far past the viewport are laid out (and load) ahead of a scroll.
            list: ListState::new(0, ListAlignment::Top, px(800.)),
            width: Rc::new(Cell::new(0.0)),
            layout: None,
            synced: None,
            keys: Vec::new(),
            revisions: Vec::new(),
        }
    }

    pub fn columns(&self) -> usize {
        self.layout.map(|layout| layout.columns).unwrap_or(1)
    }

    /// One card's width in pixels, for content sized from it (image tiles).
    pub fn card_width(&self) -> f32 {
        let Some(layout) = self.layout else {
            return 0.0;
        };
        let inset = INSET_REMS * layout.rem * 2.0;
        let gaps = GAP_REMS * layout.rem * (layout.columns - 1) as f32;
        ((layout.width - inset - gaps) / layout.columns as f32).max(0.0)
    }

    /// Lays the cards out again if anything that shapes them changed. Call from
    /// `render`; `revision` is the owner's count of changes to the cards, and
    /// `cards` — their keys and revisions in display order — is only asked for
    /// when it moved or the layout did.
    pub fn sync(
        &mut self,
        revision: u64,
        window: &Window,
        cards: impl FnOnce() -> (Vec<SharedString>, Vec<R>),
    ) {
        let width = self.width.get();
        let rem = window.rem_size().as_f32();
        let layout = (width > 0.0 && rem > 0.0).then(|| Layout {
            columns: columns_for(width / rem - INSET_REMS * 2.0),
            width,
            rem,
        });
        if self.synced == Some(revision) && layout == self.layout {
            return;
        }
        self.synced = Some(revision);
        let (keys, revisions) = cards();
        let same_columns = layout.is_some()
            && layout.map(|layout| layout.columns) == self.layout.map(|layout| layout.columns);
        let laid_out = same_columns && !self.keys.is_empty() && !keys.is_empty();

        if laid_out && keys == self.keys {
            if layout != self.layout {
                // Same columns, other width or zoom: every card wraps anew.
                self.list.remeasure();
            } else {
                self.remeasure_changed(&revisions);
            }
        } else if laid_out && keys.len() > self.keys.len() && keys.starts_with(&self.keys) {
            // A page loaded: rows go in where the footer was. Splicing keeps
            // every measured row and the scroll position.
            let columns = self.columns();
            let old_rows = row_count(self.keys.len(), columns);
            let new_rows = row_count(keys.len(), columns);
            self.list
                .splice(old_rows..old_rows + 1, new_rows - old_rows + 1);
            if layout != self.layout {
                self.list.remeasure();
            } else {
                if !self.keys.len().is_multiple_of(columns) {
                    // The last old row gained cards.
                    self.list.remeasure_items(old_rows - 1..old_rows);
                }
                self.remeasure_changed(&revisions);
            }
        } else {
            self.relayout(&keys, layout);
        }

        self.keys = keys;
        self.revisions = revisions;
        self.layout = layout;
    }

    /// Re-measures the rows of cards whose revision changed (same keys).
    fn remeasure_changed(&self, revisions: &[R]) {
        let columns = self.columns();
        let mut last_row = None;
        for (ix, (old, new)) in self.revisions.iter().zip(revisions).enumerate() {
            let row = ix / columns;
            if old != new && last_row != Some(row) {
                self.list.remeasure_items(row..row + 1);
                last_row = Some(row);
            }
        }
    }

    /// Lays everything out anew, keeping the card at the top of the viewport
    /// in place.
    fn relayout(&self, keys: &[SharedString], layout: Option<Layout>) {
        let top = self.list.logical_scroll_top();
        let at_top = top.item_ix == 0 && top.offset_in_item <= px(0.);
        let anchor = (!at_top)
            .then(|| self.keys.get(top.item_ix * self.columns()).cloned())
            .flatten();

        let columns = layout.map(|layout| layout.columns).unwrap_or(1);
        let count = match layout {
            Some(_) if !keys.is_empty() => row_count(keys.len(), columns) + 1,
            _ => 0,
        };
        if count == 0 && self.list.item_count() == 0 {
            return;
        }
        self.list.reset(count);
        if let Some(key) = anchor
            && let Some(ix) = keys.iter().position(|candidate| *candidate == key)
        {
            self.list.scroll_to(ListOffset {
                item_ix: ix / columns,
                offset_in_item: top.offset_in_item,
            });
        }
    }

    /// The grid element. `view` is re-rendered when the width changes;
    /// `render_row` draws the cards in an index range, `render_footer` the
    /// line after the last row.
    pub fn render(
        &self,
        view: EntityId,
        render_row: impl Fn(Range<usize>, &mut Window, &mut App) -> AnyElement + 'static,
        render_footer: impl Fn(&mut Window, &mut App) -> AnyElement + 'static,
    ) -> impl IntoElement {
        let columns = self.columns();
        let cards = self.keys.len();
        let rows = row_count(cards, columns);
        let width = self.width.clone();

        div()
            .relative()
            .size_full()
            .child(
                list(self.list.clone(), move |ix, window, cx| {
                    if ix < rows {
                        let start = ix * columns;
                        render_row(start..(start + columns).min(cards), window, cx)
                    } else {
                        render_footer(window, cx)
                    }
                })
                .size_full(),
            )
            // Measures the width for the next layout; asks for one more frame
            // only when it changed.
            .child(
                canvas(
                    move |bounds: Bounds<Pixels>, _, cx| {
                        if (bounds.size.width.as_f32() - width.get()).abs() > 0.5 {
                            width.set(bounds.size.width.as_f32());
                            cx.notify(view);
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

/// The row container: the shared inset and gaps the width math assumes.
pub(crate) fn row() -> gpui_kit::Div {
    gpui_kit::component::h_flex()
        .items_start()
        .px(rems(INSET_REMS))
        .pb(rems(GAP_REMS))
        .gap(rems(GAP_REMS))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn columns_follow_the_web_breakpoints() {
        assert_eq!(columns_for(30.), 1);
        assert_eq!(columns_for(40.), 2);
        assert_eq!(columns_for(63.9), 2);
        assert_eq!(columns_for(64.), 3);
        assert_eq!(columns_for(80.), 4);
        assert_eq!(columns_for(120.), 5);
    }

    #[test]
    fn rows_round_up() {
        assert_eq!(row_count(0, 3), 0);
        assert_eq!(row_count(7, 3), 3);
        assert_eq!(row_count(6, 3), 2);
    }
}
