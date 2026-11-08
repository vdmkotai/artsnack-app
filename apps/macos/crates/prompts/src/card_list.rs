//! The Prompts screen's lists: a header, the cards two to a row, and whatever
//! follows them, with only the rows on screen built (GPUI's `list`, which
//! measures them).
//!
//! Item 0 is the header; then one item per row of two cards; then the
//! tab's trailing items (an empty state, a legend). When cards are added or
//! removed the card at the top of the viewport is found again by id, so the
//! list does not jump; at the very top nothing is anchored, so a new card
//! shows up where the eye is.

use gpui_kit::{
    AnyElement, App, IntoElement, ListAlignment, ListOffset, ListState, ParentElement as _,
    Styled as _, Window,
    component::{h_flex, scroll::ScrollableElement as _},
    div, list, px,
};

/// Where an item of the list is.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Item {
    Header,
    /// The cards at these indices (the second may be past the end).
    Row(usize, usize),
    /// The tab's own items after the rows, from 0.
    Trailing(usize),
}

pub(crate) struct CardList {
    list: ListState,
    ids: Vec<String>,
    trailing: usize,
    editable: bool,
    synced: bool,
}

impl CardList {
    pub fn new() -> Self {
        Self {
            // Overdraw is measured geometry: rows this far past the viewport
            // are laid out ahead of a scroll.
            list: ListState::new(0, ListAlignment::Top, px(600.)),
            ids: Vec::new(),
            trailing: 0,
            editable: false,
            synced: false,
        }
    }

    /// Whether the list was laid out at least once.
    pub fn is_synced(&self) -> bool {
        self.synced
    }

    fn rows(cards: usize) -> usize {
        cards.div_ceil(2)
    }

    /// Lays the list out again if anything that shapes it changed. `ids` are
    /// the cards in display order, `changed` the indices of cards whose
    /// content changed, `editable` whether cards are editors (they are
    /// taller than read-only previews).
    pub fn sync(&mut self, ids: Vec<String>, changed: &[usize], trailing: usize, editable: bool) {
        let count = 1 + Self::rows(ids.len()) + trailing;
        if self.synced && ids == self.ids && trailing == self.trailing {
            if editable != self.editable {
                self.list.remeasure();
            } else {
                let mut last = None;
                for row in changed.iter().map(|ix| 1 + ix / 2) {
                    if last != Some(row) {
                        self.list.remeasure_items(row..row + 1);
                        last = Some(row);
                    }
                }
            }
        } else {
            let top = self.list.logical_scroll_top();
            let rows = Self::rows(self.ids.len());
            let anchor = (top.item_ix >= 1 && top.item_ix <= rows)
                .then(|| self.ids.get((top.item_ix - 1) * 2).cloned())
                .flatten();
            self.list.reset(count);
            match anchor.and_then(|id| ids.iter().position(|candidate| *candidate == id)) {
                Some(ix) => self.list.scroll_to(ListOffset {
                    item_ix: 1 + ix / 2,
                    offset_in_item: top.offset_in_item,
                }),
                None if top.item_ix == 0 && top.offset_in_item > px(0.) => self.list.scroll_to(top),
                None => {}
            }
        }
        self.ids = ids;
        self.trailing = trailing;
        self.editable = editable;
        self.synced = true;
    }

    pub fn item(&self, ix: usize) -> Item {
        let rows = Self::rows(self.ids.len());
        match ix {
            0 => Item::Header,
            ix if ix <= rows => Item::Row((ix - 1) * 2, (ix - 1) * 2 + 1),
            ix => Item::Trailing(ix - 1 - rows),
        }
    }

    /// The list, filling its parent, with its scrollbar.
    pub fn render(
        &self,
        render_item: impl FnMut(usize, &mut Window, &mut App) -> AnyElement + 'static,
    ) -> impl IntoElement {
        div()
            .relative()
            .size_full()
            .child(list(self.list.clone(), render_item).size_full())
            .vertical_scrollbar(&self.list)
    }
}

/// One row: two cards side by side, the second column kept when it is empty.
pub(crate) fn card_row(left: Option<AnyElement>, right: Option<AnyElement>) -> AnyElement {
    h_flex()
        .items_start()
        .gap_4()
        .px_4()
        .pb_4()
        .child(div().flex_1().min_w_0().children(left))
        .child(div().flex_1().min_w_0().children(right))
        .into_any_element()
}

#[cfg(test)]
mod tests {
    use super::{CardList, Item};

    #[test]
    fn items_are_the_header_rows_of_two_then_the_tabs_own() {
        let mut list = CardList::new();
        list.sync(vec!["a".into(), "b".into(), "c".into()], &[], 1, true);
        assert_eq!(list.item(0), Item::Header);
        assert_eq!(list.item(1), Item::Row(0, 1));
        assert_eq!(list.item(2), Item::Row(2, 3));
        assert_eq!(list.item(3), Item::Trailing(0));
    }
}
