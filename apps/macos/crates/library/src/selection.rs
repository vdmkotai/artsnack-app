//! Multi-select over an ordered list, keyed by stable ids (never by position,
//! which shifts under live updates).
//!
//! File-manager semantics, as on the web: a click toggles one item and moves
//! the anchor to it; Shift-click adds every item between the anchor and the
//! clicked one, inclusive, and leaves the anchor where it was.

use std::collections::HashSet;

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Selection {
    selected: HashSet<String>,
    anchor: Option<String>,
}

impl Selection {
    pub fn is_selected(&self, id: &str) -> bool {
        self.selected.contains(id)
    }

    pub fn len(&self) -> usize {
        self.selected.len()
    }

    pub fn is_empty(&self) -> bool {
        self.selected.is_empty()
    }

    /// The selected ids, in the order they appear in `order`.
    pub fn ordered<'a>(&self, order: impl IntoIterator<Item = &'a str>) -> Vec<String> {
        order
            .into_iter()
            .filter(|id| self.selected.contains(*id))
            .map(str::to_string)
            .collect()
    }

    /// A plain click: toggle `id`, anchor on it.
    pub fn toggle(&mut self, id: &str) {
        if !self.selected.remove(id) {
            self.selected.insert(id.to_string());
        }
        self.anchor = Some(id.to_string());
    }

    /// Shift-click: add the inclusive range from the anchor to `id` within
    /// `order`. Without an anchor (or if it is gone) it behaves like a click.
    pub fn extend_to<'a>(&mut self, id: &str, order: impl IntoIterator<Item = &'a str> + Clone) {
        let position = |target: &str| order.clone().into_iter().position(|item| item == target);
        let (Some(anchor), Some(to)) = (self.anchor.as_deref().and_then(position), position(id))
        else {
            self.toggle(id);
            return;
        };
        let (start, end) = if anchor <= to {
            (anchor, to)
        } else {
            (to, anchor)
        };
        for item in order.into_iter().skip(start).take(end - start + 1) {
            self.selected.insert(item.to_string());
        }
    }

    /// Drops ids that are no longer in the list (deleted elsewhere).
    pub fn retain_present<'a>(&mut self, present: impl IntoIterator<Item = &'a str>) {
        let present: HashSet<&str> = present.into_iter().collect();
        self.selected.retain(|id| present.contains(id.as_str()));
        if self
            .anchor
            .as_deref()
            .is_some_and(|anchor| !present.contains(anchor))
        {
            self.anchor = None;
        }
    }

    pub fn clear(&mut self) {
        self.selected.clear();
        self.anchor = None;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const ORDER: [&str; 5] = ["a", "b", "c", "d", "e"];

    #[test]
    fn click_toggles_and_shift_click_adds_the_range_from_the_anchor() {
        let mut selection = Selection::default();
        selection.toggle("b");
        selection.extend_to("d", ORDER);
        assert_eq!(selection.ordered(ORDER), ["b", "c", "d"]);
        // The anchor stays on b: extending upward adds a.
        selection.extend_to("a", ORDER);
        assert_eq!(selection.ordered(ORDER), ["a", "b", "c", "d"]);
        selection.toggle("c");
        assert_eq!(selection.ordered(ORDER), ["a", "b", "d"]);
    }

    #[test]
    fn shift_click_without_an_anchor_is_a_click() {
        let mut selection = Selection::default();
        selection.extend_to("c", ORDER);
        assert_eq!(selection.ordered(ORDER), ["c"]);
    }

    #[test]
    fn forgets_ids_that_disappeared() {
        let mut selection = Selection::default();
        selection.toggle("a");
        selection.toggle("b");
        selection.retain_present(["b", "c"]);
        assert_eq!(selection.ordered(ORDER), ["b"]);
        selection.extend_to("c", ["b", "c"]);
        assert_eq!(selection.ordered(["b", "c"]), ["b", "c"]);
    }
}
