//! Which images are favourited, with the heart flipping in the frame it is
//! clicked (the web's `useToggleFavorite` optimistic update).
//!
//! Without the overlay the heart only changes once the mutation lands and
//! `favorites:myKeys` re-runs; on a slow link that reads as a dead button, and
//! the natural response — clicking again — is a second toggle that silently
//! undoes the first.
//!
//! The server's mutation is a toggle, so a heart is only offered once the key
//! list is known: an empty list while it loads would show "Add" on an image
//! that is already a favourite, and the click would remove it. A query that
//! fails or re-subscribes keeps the last list it delivered.

use std::collections::{HashMap, HashSet};

use artsnack_backend::{
    Backend, LiveQuery, NoArgs,
    api::favorites::{self, ToggleArgs},
};
use artsnack_ui::TileAction;
use gpui_kit::{
    App, Context, Entity, Task, Window,
    assets::IconName,
    component::{WindowExt as _, notification::Notification},
};

use crate::feed::{Feed, release_after_grace};

/// A toggle the live key list does not show yet.
struct Pending {
    favorited: bool,
    /// Which toggle of this key set it; only the latest one may settle it.
    toggle: u64,
    /// The server answered; the entry goes once the key list agrees.
    settled: bool,
}

pub struct FavoriteHearts {
    keys: Feed<LiveQuery<Vec<String>>>,
    /// The last key list the server delivered; `None` until the first.
    live: Option<HashSet<String>>,
    pending: HashMap<String, Pending>,
    toggles: u64,
    _release: Option<Task<()>>,
}

impl FavoriteHearts {
    pub fn new(cx: &mut Context<Self>) -> Self {
        let mut this = Self {
            keys: Feed::default(),
            live: None,
            pending: HashMap::new(),
            toggles: 0,
            _release: None,
        };
        this.connect(cx);
        this
    }

    fn connect(&mut self, cx: &mut Context<Self>) {
        self.keys.connect(
            |cx| LiveQuery::new(favorites::MY_KEYS, &NoArgs {}, cx),
            Self::keys_changed,
            cx,
        );
        self.keys_changed(cx);
    }

    /// Whether the owning screen is shown. Hidden, the key list is released
    /// after a grace period; the last one keeps answering meanwhile.
    pub fn set_active(&mut self, active: bool, cx: &mut Context<Self>) {
        if active {
            self._release = None;
            self.connect(cx);
        } else if self.keys.is_live() && self._release.is_none() {
            self._release = Some(release_after_grace(cx, |this, _| {
                this.keys.release();
            }));
        }
    }

    /// Whether `b2_key` is a favourite, `None` while the key list has never
    /// arrived — offer no heart then.
    pub fn favorited(&self, b2_key: &str) -> Option<bool> {
        match self.pending.get(b2_key) {
            Some(pending) => Some(pending.favorited),
            None => self.live.as_ref().map(|live| live.contains(b2_key)),
        }
    }

    /// [`Self::favorited`], with an unknown state read as "not a favourite".
    /// [`Self::toggle`] refuses to act on an unknown state either way.
    pub fn is_favorited(&self, b2_key: &str) -> bool {
        self.favorited(b2_key).unwrap_or(false)
    }

    /// The viewer's heart for `args`' image, `None` while the key list is
    /// unknown.
    pub fn viewer_action(hearts: &Entity<Self>, args: ToggleArgs, cx: &App) -> Option<TileAction> {
        let favorited = hearts.read(cx).favorited(&args.b2_key)?;
        let hearts = hearts.clone();
        Some(TileAction::new(
            "favorite",
            if favorited {
                IconName::HeartOff
            } else {
                IconName::Heart
            },
            if favorited {
                "Remove from favorites"
            } else {
                "Add to favorites"
            },
            move |window, cx| {
                hearts.update(cx, |hearts, cx| hearts.toggle(args.clone(), window, cx));
            },
        ))
    }

    /// Flips the heart now and asks the server to follow. `args` names the
    /// image and the row it belongs to. Does nothing until the key list is
    /// known, since the server's toggle could only guess the direction.
    pub fn toggle(&mut self, args: ToggleArgs, window: &mut Window, cx: &mut Context<Self>) {
        let key = args.b2_key.clone();
        let Some(favorited) = self.favorited(&key) else {
            window.push_notification(
                Notification::warning("Favorites are still loading. Try again in a moment."),
                cx,
            );
            return;
        };
        self.toggles += 1;
        let toggle = self.toggles;
        self.pending.insert(
            key.clone(),
            Pending {
                favorited: !favorited,
                toggle,
                settled: false,
            },
        );
        cx.notify();

        let task = Backend::global(cx).update(cx, |backend, cx| {
            backend.mutate(favorites::TOGGLE, &args, cx)
        });
        let window_handle = window.window_handle();
        cx.spawn(async move |this, cx| {
            let result = task.await;
            let outcome = result.as_ref().ok().map(|result| result.favorited);
            let _ = this.update(cx, |this, cx| this.settle(&key, toggle, outcome, cx));
            if let Err(error) = result {
                let _ = window_handle.update(cx, |_, window, cx| {
                    window.push_notification(Notification::error(error.user_message()), cx)
                });
            }
        })
        .detach();
    }

    /// The server answered toggle `toggle` of `key`: `Some(favorited)` is its
    /// state now, `None` a failure (the heart falls back to the key list).
    fn settle(&mut self, key: &str, toggle: u64, outcome: Option<bool>, cx: &mut Context<Self>) {
        let Some(pending) = self.pending.get_mut(key) else {
            return;
        };
        if pending.toggle != toggle {
            // A later click owns the heart now; its answer decides.
            return;
        }
        let live = self.live.as_ref().is_some_and(|live| live.contains(key));
        match outcome {
            Some(favorited) if live != favorited => {
                pending.favorited = favorited;
                pending.settled = true;
            }
            _ => {
                self.pending.remove(key);
            }
        }
        cx.notify();
    }

    /// A new key list replaces the last; a loading or failed query keeps it.
    fn keys_changed(&mut self, cx: &mut Context<Self>) {
        let Some(keys) = self.keys.get().and_then(|query| query.read(cx).data()) else {
            return;
        };
        let live: HashSet<String> = keys.iter().cloned().collect();
        self.pending
            .retain(|key, pending| !(pending.settled && live.contains(key) == pending.favorited));
        self.live = Some(live);
        cx.notify();
    }
}
