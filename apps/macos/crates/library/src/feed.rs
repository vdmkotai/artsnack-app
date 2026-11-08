//! Live queries a screen lets go of while it is hidden.
//!
//! The shell keeps every screen it has built, and each screen kept every page
//! it had loaded subscribed for as long as the window was open: a progress
//! tick in a hidden Gallery still ran its whole update. Now a hidden screen
//! drops its subscriptions once it has stayed hidden for [`HIDDEN_GRACE`] —
//! a quick look at another screen keeps them — and subscribes again when it
//! shows. Nothing on screen goes away meanwhile: the screen keeps its own
//! snapshot of what it showed, a new live query starts from the rows the last
//! one delivered (remembered app-wide by the backend crate), and the grid
//! keeps its scroll position because the rows come back with the same keys.

use std::time::Duration;

use gpui_kit::{Context, Entity, Subscription, Task};

/// How long a hidden screen keeps its subscriptions.
pub const HIDDEN_GRACE: Duration = Duration::from_secs(60);

/// Runs `release` on the view once the grace period is over. Dropping the
/// returned task (the screen showed again) cancels it.
pub fn release_after_grace<V: 'static>(
    cx: &mut Context<V>,
    release: impl FnOnce(&mut V, &mut Context<V>) + 'static,
) -> Task<()> {
    cx.spawn(async move |this, cx| {
        cx.background_executor().timer(HIDDEN_GRACE).await;
        let _ = this.update(cx, release);
    })
}

/// A live query and the screen's observation of it, or nothing while
/// released.
pub struct Feed<Q: 'static> {
    live: Option<(Entity<Q>, Subscription)>,
}

impl<Q: 'static> Default for Feed<Q> {
    fn default() -> Self {
        Self { live: None }
    }
}

impl<Q: 'static> Feed<Q> {
    pub fn get(&self) -> Option<&Entity<Q>> {
        self.live.as_ref().map(|(query, _)| query)
    }

    pub fn is_live(&self) -> bool {
        self.live.is_some()
    }

    /// Subscribes with `make` unless already subscribed; `changed` runs
    /// whenever the query notifies.
    pub fn connect<V: 'static>(
        &mut self,
        make: impl FnOnce(&mut Context<V>) -> Entity<Q>,
        mut changed: impl FnMut(&mut V, &mut Context<V>) + 'static,
        cx: &mut Context<V>,
    ) {
        if self.live.is_some() {
            return;
        }
        let query = make(cx);
        let subscription = cx.observe(&query, move |this, _, cx| changed(this, cx));
        self.live = Some((query, subscription));
    }

    /// Drops the query, and with it every subscription it held.
    pub fn release(&mut self) {
        self.live = None;
    }
}
