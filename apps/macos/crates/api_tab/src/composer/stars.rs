//! Starred Atlas models, with a star flipping in the frame it is clicked —
//! the same overlay as the gallery's hearts ([`artsnack_library::FavoriteHearts`]).
//!
//! The switcher's chips and the picker's stars both read this one list, so a
//! star clicked in the picker shows on the chip row at once too. Without the
//! overlay a star changed only once `atlasFavorites:list` re-ran, a round trip
//! later, and a second click meanwhile was a second toggle undoing the first.

use std::collections::HashMap;

use artsnack_backend::{
    Backend, LiveQuery, NoArgs,
    api::atlas::{self, ToggleFavoriteArgs},
};
use gpui_kit::{
    App, AppContext as _, Context, Entity, Global, Subscription,
    component::notification::Notification,
};

use super::ApiComposer;

/// A toggle the live list does not show yet.
struct Pending {
    starred: bool,
    /// Which toggle of this model set it; only the latest one may settle it.
    toggle: u64,
    /// The server answered; the entry goes once the list agrees.
    settled: bool,
}

pub(crate) struct AtlasStars {
    query: Entity<LiveQuery<Vec<String>>>,
    /// The server's list, oldest star first; `None` until it first arrives.
    live: Option<Vec<String>>,
    pending: HashMap<String, Pending>,
    /// `live` with `pending` applied: what is shown.
    ids: Option<Vec<String>>,
    toggles: u64,
    _subscription: Subscription,
}

struct GlobalStars(Entity<AtlasStars>);

impl Global for GlobalStars {}

impl AtlasStars {
    /// The app's one list, created on first use.
    pub(crate) fn global(cx: &mut App) -> Entity<Self> {
        if let Some(stars) = cx.try_global::<GlobalStars>() {
            return stars.0.clone();
        }
        let stars = cx.new(|cx| {
            let query = LiveQuery::new(atlas::FAVORITES, &NoArgs {}, cx);
            let subscription = cx.observe(&query, |this: &mut Self, _, cx| this.live_changed(cx));
            let mut this = Self {
                query,
                live: None,
                pending: HashMap::new(),
                ids: None,
                toggles: 0,
                _subscription: subscription,
            };
            this.live_changed(cx);
            this
        });
        cx.set_global(GlobalStars(stars.clone()));
        stars
    }

    /// The starred ids as shown, oldest first; `None` while the list loads.
    pub(crate) fn ids(&self) -> Option<&Vec<String>> {
        self.ids.as_ref()
    }

    /// Flips the star now and asks the server to follow. `composer`, when
    /// given, reports the outcome; the picker passes none and lets the star
    /// speak for itself.
    pub(crate) fn toggle(
        &mut self,
        model_id: String,
        label: String,
        composer: Option<Entity<ApiComposer>>,
        cx: &mut Context<Self>,
    ) {
        // The server's mutation is a toggle: before the list is known it
        // could only guess the direction.
        let Some(starred) = self.ids.as_ref().map(|ids| ids.contains(&model_id)) else {
            return;
        };
        self.toggles += 1;
        let toggle = self.toggles;
        self.pending.insert(
            model_id.clone(),
            Pending {
                starred: !starred,
                toggle,
                settled: false,
            },
        );
        self.merge(cx);

        let task = Backend::global(cx).update(cx, |backend, cx| {
            backend.mutate(
                atlas::TOGGLE_FAVORITE,
                &ToggleFavoriteArgs {
                    model_id: model_id.clone(),
                },
                cx,
            )
        });
        cx.spawn(async move |this, cx| {
            let result = task.await;
            let outcome = result.as_ref().ok().copied();
            let _ = this.update(cx, |this, cx| this.settle(&model_id, toggle, outcome, cx));
            if let Some(composer) = composer {
                composer.update(cx, |composer, cx| {
                    let notification = match result {
                        Ok(true) => Notification::success(format!("Starred {label}")),
                        Ok(false) => Notification::success(format!("Unstarred {label}")),
                        Err(error) => Notification::error(error.user_message()),
                    };
                    composer.notify(notification, cx);
                });
            }
        })
        .detach();
    }

    /// The server answered toggle `toggle` of `model_id`: `Some(starred)` is
    /// its state now, `None` a failure (the star falls back to the list).
    fn settle(
        &mut self,
        model_id: &str,
        toggle: u64,
        outcome: Option<bool>,
        cx: &mut Context<Self>,
    ) {
        let Some(pending) = self.pending.get_mut(model_id) else {
            return;
        };
        if pending.toggle != toggle {
            // A later click owns the star now; its answer decides.
            return;
        }
        let live = self
            .live
            .as_ref()
            .is_some_and(|live| live.iter().any(|id| id == model_id));
        match outcome {
            Some(starred) if live != starred => {
                pending.starred = starred;
                pending.settled = true;
            }
            _ => {
                self.pending.remove(model_id);
            }
        }
        self.merge(cx);
    }

    /// A new list replaces the last; a loading or failed query keeps it.
    fn live_changed(&mut self, cx: &mut Context<Self>) {
        let Some(live) = self.query.read(cx).data().map(|ids| ids.as_ref().clone()) else {
            return;
        };
        self.pending
            .retain(|id, pending| !(pending.settled && live.contains(id) == pending.starred));
        self.live = Some(live);
        self.merge(cx);
    }

    fn merge(&mut self, cx: &mut Context<Self>) {
        let Some(live) = &self.live else {
            return;
        };
        let mut ids: Vec<String> = live
            .iter()
            .filter(|id| self.pending.get(*id).is_none_or(|pending| pending.starred))
            .cloned()
            .collect();
        // New stars go last, in click order, where the server puts them.
        let mut added: Vec<(&String, u64)> = self
            .pending
            .iter()
            .filter(|(id, pending)| pending.starred && !ids.contains(id))
            .map(|(id, pending)| (id, pending.toggle))
            .collect();
        added.sort_by_key(|(_, toggle)| *toggle);
        ids.extend(added.into_iter().map(|(id, _)| id.clone()));
        self.ids = Some(ids);
        cx.notify();
    }
}
