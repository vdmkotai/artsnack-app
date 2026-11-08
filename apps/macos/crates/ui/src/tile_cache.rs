//! Grid tiles drawn in cached views, so a frame that changes one tile does not
//! rebuild all the others.
//!
//! In GPUI a notification re-renders the notified view and every view above
//! it; a view embedded with `Entity::cached` is reused — its layout, paint and
//! element state replayed — as long as nothing inside it was notified and its
//! bounds did not change. A playing clip notifies itself for every new frame,
//! so the grid's owner re-renders at the clip's frame rate whatever it does;
//! what this module saves is the tiles. Each tile lives in a small view of its
//! own, keyed by the item's key, which is drawn cached unless:
//!
//! - the owner was notified since the last frame (`cx.notify()` on the view the
//!   grid belongs to) — every tile is drawn afresh once;
//! - the grid laid out again (new items, width, tile scale) — the same;
//! - the tile is live (`is_live`): it changes without the owner being
//!   notified, like a tile with a playing clip, and is drawn afresh every
//!   frame;
//! - the tile itself was notified: its hover state, an image arriving in it, a
//!   menu opening on it.
//!
//! The contract for the owner is GPUI's usual one for cached views: whatever a
//! tile shows changes together with a notification of the owner, or of a view
//! inside the tile. State the tile builder reads from another entity that does
//! not notify the owner is not seen until the next owner notification.
//! Asking for animation frames on the owner (`request_animation_frame`)
//! notifies it every frame and turns the cache off; playing clips belong in
//! `ClipPlayers::surface`, which notifies only itself.

use std::{
    cell::{Cell, RefCell},
    collections::HashMap,
    rc::Rc,
};

use gpui_kit::{
    AnyElement, App, AppContext as _, Context, Entity, EntityId, IntoElement, Render, SharedString,
    StyleRefinement, Styled as _, Subscription, Window, div,
};

pub(crate) type TileBuilder = Rc<dyn Fn(&mut Window, &mut App) -> AnyElement>;

/// The cached tiles of one grid, by item key.
#[derive(Default)]
pub(crate) struct TileCache {
    hosts: RefCell<HashMap<SharedString, Entity<TileHost>>>,
    /// Bumped by everything that may change what any tile shows.
    revision: Rc<Cell<u64>>,
    /// Counts the owner's renders, to let go of tiles no longer drawn.
    frame: Cell<u64>,
    owner: RefCell<Option<(EntityId, Subscription)>>,
}

/// One tile's view: draws whatever its latest builder draws.
pub(crate) struct TileHost {
    build: Option<TileBuilder>,
    /// The cache revision it was last drawn at.
    revision: Option<u64>,
    /// The owner render it was last drawn in.
    used: u64,
}

impl Render for TileHost {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        match self.build.clone() {
            Some(build) => build(window, cx),
            None => div().into_any_element(),
        }
    }
}

impl TileCache {
    /// Every tile is drawn afresh next frame.
    pub(crate) fn invalidate(&self) {
        self.revision.set(self.revision.get().wrapping_add(1));
    }

    /// Starts one of the owner's renders: watches `owner` for notifications
    /// and lets go of tiles the previous render did not draw.
    pub(crate) fn begin<V: 'static>(&self, owner: &Entity<V>, cx: &mut App) {
        let id = owner.entity_id();
        let watched = self
            .owner
            .borrow()
            .as_ref()
            .is_some_and(|(watched, _)| *watched == id);
        if !watched {
            let revision = self.revision.clone();
            let subscription = cx.observe(owner, move |_, _| {
                revision.set(revision.get().wrapping_add(1));
            });
            *self.owner.borrow_mut() = Some((id, subscription));
            self.invalidate();
        }
        let frame = self.frame.get() + 1;
        self.frame.set(frame);
        self.hosts
            .borrow_mut()
            .retain(|_, host| host.read(cx).used + 1 >= frame);
    }

    /// The tile of `key`, drawn by `build`: from the cache if nothing that
    /// could change it happened, afresh otherwise.
    pub(crate) fn tile(
        &self,
        key: &SharedString,
        live: bool,
        build: TileBuilder,
        cx: &mut App,
    ) -> AnyElement {
        let (revision, frame) = (self.revision.get(), self.frame.get());
        let host = self
            .hosts
            .borrow_mut()
            .entry(key.clone())
            .or_insert_with(|| {
                cx.new(|_| TileHost {
                    build: None,
                    revision: None,
                    used: 0,
                })
            })
            .clone();
        let fresh = host.update(cx, |host, _| {
            let fresh = host.revision == Some(revision);
            host.revision = Some(revision);
            host.used = frame;
            host.build = Some(build);
            fresh
        });
        if fresh && !live {
            host.cached(StyleRefinement::default().size_full())
                .into_any_element()
        } else {
            // Uncached: rendered now. The next cached frame finds no state from
            // this one and renders once more before it starts reusing. Either
            // way the tile's element id is its view's, so its hover and menu
            // state carry across.
            host.into_any_element()
        }
    }
}
