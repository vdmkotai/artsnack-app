//! The last result of each query, kept so a revisited screen renders from
//! memory while its fresh subscription loads — the web's `convex-cache.ts`.
//! A snapshot is for display only: never seed an editable form from it.
//!
//! - **Bounded.** Least recently used entries go first, by count and by size,
//!   with one budget for plain queries (by approximate JSON size) and another
//!   for paginated lists (by rows), which hold thousands of rows per filter.
//! - **One user's.** Snapshots belong to the signed-in user: a different user
//!   ([`QuerySnapshots::set_owner`]) or a sign-out ([`QuerySnapshots::clear`])
//!   drops all of them, so one account never sees another's data.

use std::{any::Any, collections::HashMap, sync::Arc};

use gpui_kit::{App, Global};

/// Which budget an entry counts against.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Pool {
    /// [`crate::LiveQuery`] results; weight is approximate bytes.
    Queries,
    /// [`crate::LivePaginatedQuery`] rows; weight is the number of rows.
    Lists,
}

#[derive(Clone, Copy, Debug)]
struct Budget {
    entries: usize,
    weight: usize,
}

impl Pool {
    fn budget(self) -> Budget {
        match self {
            Self::Queries => Budget {
                entries: 192,
                weight: 24 << 20,
            },
            Self::Lists => Budget {
                entries: 24,
                weight: 10_000,
            },
        }
    }
}

struct Snapshot {
    data: Arc<dyn Any + Send + Sync>,
    pool: Pool,
    weight: usize,
    /// The store's clock when this entry was last read or written.
    used: u64,
}

type SnapshotKey = (&'static str, String);

/// Last results by query identity, for instant revisits.
#[derive(Default)]
pub struct QuerySnapshots {
    owner: Option<String>,
    clock: u64,
    entries: HashMap<SnapshotKey, Snapshot>,
}

impl Global for QuerySnapshots {}

impl QuerySnapshots {
    /// Forgets every snapshot and the owner. Call on sign-out.
    pub fn clear(cx: &mut App) {
        cx.set_global(QuerySnapshots::default());
    }

    /// Makes `user_id` the owner of the snapshots from now on; when it differs
    /// from the current owner, everything remembered so far is dropped.
    pub fn set_owner(cx: &mut App, user_id: Option<&str>) {
        let snapshots = cx.default_global::<Self>();
        if snapshots.owner.as_deref() != user_id {
            *snapshots = Self {
                owner: user_id.map(str::to_string),
                ..Self::default()
            };
        }
    }

    pub(crate) fn get<T: Send + Sync + 'static>(
        cx: &mut App,
        path: &'static str,
        key: &str,
    ) -> Option<Arc<T>> {
        if !cx.has_global::<Self>() {
            return None;
        }
        cx.global_mut::<Self>().lookup::<T>(path, key)
    }

    pub(crate) fn put<T: Send + Sync + 'static>(
        cx: &mut App,
        pool: Pool,
        path: &'static str,
        key: String,
        data: Arc<T>,
        weight: usize,
    ) {
        cx.default_global::<Self>()
            .insert(pool, (path, key), data, weight);
    }

    fn lookup<T: Send + Sync + 'static>(
        &mut self,
        path: &'static str,
        key: &str,
    ) -> Option<Arc<T>> {
        self.clock += 1;
        let entry = self.entries.get_mut(&(path, key.to_string()))?;
        entry.used = self.clock;
        entry.data.clone().downcast::<T>().ok()
    }

    fn insert(
        &mut self,
        pool: Pool,
        key: SnapshotKey,
        data: Arc<dyn Any + Send + Sync>,
        weight: usize,
    ) {
        self.clock += 1;
        self.entries.insert(
            key.clone(),
            Snapshot {
                data,
                pool,
                weight,
                used: self.clock,
            },
        );
        self.evict(pool, &key);
    }

    /// Drops the least recently used entries of `pool` until it fits its
    /// budget. `keep`, just written, stays even when it alone is over.
    fn evict(&mut self, pool: Pool, keep: &SnapshotKey) {
        let budget = pool.budget();
        let (mut count, mut weight) = self
            .entries
            .values()
            .filter(|entry| entry.pool == pool)
            .fold((0, 0), |(count, weight), entry| {
                (count + 1, weight + entry.weight)
            });
        while count > budget.entries || weight > budget.weight {
            let victim = self
                .entries
                .iter()
                .filter(|(key, entry)| entry.pool == pool && *key != keep)
                .min_by_key(|(_, entry)| entry.used)
                .map(|(key, _)| key.clone());
            let Some(victim) = victim else {
                break;
            };
            if let Some(entry) = self.entries.remove(&victim) {
                count -= 1;
                weight -= entry.weight;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn put(store: &mut QuerySnapshots, pool: Pool, key: &str, weight: usize) {
        store.insert(
            pool,
            ("q", key.to_string()),
            Arc::new(key.to_string()),
            weight,
        );
    }

    #[test]
    fn evicts_the_least_recently_used_rows_first() {
        let mut store = QuerySnapshots::default();
        put(&mut store, Pool::Lists, "a", 4_000);
        put(&mut store, Pool::Lists, "b", 4_000);
        // Reading `a` makes `b` the oldest.
        assert!(store.lookup::<String>("q", "a").is_some());
        put(&mut store, Pool::Lists, "c", 4_000);
        assert!(store.lookup::<String>("q", "a").is_some());
        assert!(store.lookup::<String>("q", "b").is_none());
        assert!(store.lookup::<String>("q", "c").is_some());
    }

    #[test]
    fn pools_have_separate_budgets() {
        let mut store = QuerySnapshots::default();
        put(&mut store, Pool::Queries, "small", 10);
        for ix in 0..30 {
            put(&mut store, Pool::Lists, &format!("list-{ix}"), 10);
        }
        assert!(store.lookup::<String>("q", "small").is_some());
        let lists = store
            .entries
            .values()
            .filter(|entry| entry.pool == Pool::Lists)
            .count();
        assert_eq!(lists, Pool::Lists.budget().entries);
    }

    #[test]
    fn keeps_a_single_entry_over_budget() {
        let mut store = QuerySnapshots::default();
        put(&mut store, Pool::Lists, "huge", 50_000);
        assert!(store.lookup::<String>("q", "huge").is_some());
    }
}
