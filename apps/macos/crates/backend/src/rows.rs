//! Stable row identity across live updates.
//!
//! Convex sends a whole result again whenever anything in it changes, and every
//! row arrives as a new value. If each update replaced every row, every tile in
//! a grid would re-render on every background write — the problem the web app's
//! `useStableRows` solves. Here a row keeps its `Arc` as long as its decoded
//! value is equal, and DTOs leave out bookkeeping fields (leases, progress
//! stamps), so those writes do not count as changes at all.

use std::{collections::HashMap, sync::Arc};

/// A document with a stable id (`_id`).
pub trait Row: Clone + PartialEq + Send + Sync + 'static {
    fn row_id(&self) -> &str;
}

/// Reuses the previous `Arc` for every row whose value did not change.
pub struct RowCache<T> {
    rows: HashMap<String, Arc<T>>,
}

impl<T> Default for RowCache<T> {
    fn default() -> Self {
        Self {
            rows: HashMap::new(),
        }
    }
}

impl<T: Row> RowCache<T> {
    /// A cache that already knows `rows`, so their equal successors keep
    /// these `Arc`s (a page re-subscribed or split, a remembered list).
    pub fn from_rows(rows: &[Arc<T>]) -> Self {
        Self {
            rows: rows
                .iter()
                .map(|row| (row.row_id().to_string(), row.clone()))
                .collect(),
        }
    }

    /// Interns `fresh`, returning `Arc`s that are pointer-equal to the previous
    /// ones for unchanged rows. Rows that disappeared are forgotten.
    pub fn intern(&mut self, fresh: Vec<T>) -> Vec<Arc<T>> {
        let mut next = HashMap::with_capacity(fresh.len());
        let rows = fresh
            .into_iter()
            .map(|row| {
                let row = match self.rows.remove(row.row_id()) {
                    Some(previous) if *previous == row => previous,
                    _ => Arc::new(row),
                };
                next.insert(row.row_id().to_string(), row.clone());
                row
            })
            .collect();
        self.rows = next;
        rows
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Clone, PartialEq, Debug)]
    struct Item {
        id: &'static str,
        value: u32,
    }

    impl Row for Item {
        fn row_id(&self) -> &str {
            self.id
        }
    }

    #[test]
    fn unchanged_rows_keep_their_identity() {
        let mut cache = RowCache::default();
        let first = cache.intern(vec![Item { id: "a", value: 1 }, Item { id: "b", value: 1 }]);
        let second = cache.intern(vec![Item { id: "a", value: 1 }, Item { id: "b", value: 2 }]);
        assert!(Arc::ptr_eq(&first[0], &second[0]));
        assert!(!Arc::ptr_eq(&first[1], &second[1]));
    }

    #[test]
    fn a_seeded_cache_keeps_the_seed_identity() {
        let seed = vec![Arc::new(Item { id: "a", value: 1 })];
        let mut cache = RowCache::from_rows(&seed);
        let rows = cache.intern(vec![Item { id: "a", value: 1 }, Item { id: "b", value: 1 }]);
        assert!(Arc::ptr_eq(&seed[0], &rows[0]));
    }

    #[test]
    fn removed_rows_are_forgotten() {
        let mut cache = RowCache::default();
        let first = cache.intern(vec![Item { id: "a", value: 1 }]);
        cache.intern(vec![]);
        let third = cache.intern(vec![Item { id: "a", value: 1 }]);
        assert!(!Arc::ptr_eq(&first[0], &third[0]));
    }
}
