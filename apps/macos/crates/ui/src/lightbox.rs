//! The full-screen viewer over a live list (the web's `MediaLightbox`).
//!
//! - The current item is anchored by its key, not its position: a result
//!   finishing at the top of the list or a deletion does not move the view. If
//!   the item disappears, the one now at its position takes over; an empty list
//!   closes the viewer.
//! - ← / → step, Escape closes, I toggles the details. Near the end of the list
//!   it asks for more, and → at the very end steps onto the first new item once
//!   it arrives — unless the user has moved since (any ← or →), or the item it
//!   was pressed on is no longer the current one.
//! - The preview already in memory shows at once; the original replaces it
//!   when decoded. Both load ahead of the grid behind the viewer.
//! - A clip plays in a [`crate::ClipViewer`], muted until the user unmutes it.
//!   The player lives exactly while its clip is the current item: stepping to
//!   an image (or a clip with no URL) drops it, and the keyboard goes back to
//!   the viewer.

use std::rc::Rc;

use artsnack_media::{ImageRequest, media_image};
use gpui_kit::{
    AnyElement, App, AppContext as _, Context, Entity, EventEmitter, FocusHandle, Focusable,
    InteractiveElement as _, IntoElement, KeyBinding, ObjectFit, ParentElement as _, Render,
    SharedString, Styled as _, StyledImage as _, Window, actions,
    assets::IconName,
    component::{
        ActiveTheme as _, Disableable as _, Sizable as _,
        button::{Button, ButtonVariants as _},
        h_flex, v_flex,
    },
    div, img,
    prelude::FluentBuilder as _,
};

use crate::{TileAction, TileMedia};

actions!(
    lightbox,
    [CloseLightbox, PreviousItem, NextItem, ToggleDetails]
);

const CONTEXT: &str = "Lightbox";
/// Ask for more when this close to the end.
const LOAD_MORE_WITHIN: usize = 3;

pub fn init(cx: &mut App) {
    cx.bind_keys([
        KeyBinding::new("escape", CloseLightbox, Some(CONTEXT)),
        KeyBinding::new("left", PreviousItem, Some(CONTEXT)),
        KeyBinding::new("right", NextItem, Some(CONTEXT)),
        KeyBinding::new("i", ToggleDetails, Some(CONTEXT)),
    ]);
}

/// One item the viewer can show.
#[derive(Clone, Debug, PartialEq)]
pub struct LightboxItem {
    pub key: SharedString,
    pub preview: ImageRequest,
    pub original: ImageRequest,
    pub media: TileMedia,
    /// For clips: the URL to play.
    pub video_url: Option<SharedString>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum LightboxEvent {
    Closed,
    /// The viewer is near the end of the list and the list can grow.
    LoadMore,
}

type ActionsFor = Rc<dyn Fn(&LightboxItem, &mut Window, &mut App) -> Vec<TileAction>>;
type DetailsFor = Rc<dyn Fn(&LightboxItem, &mut Window, &mut App) -> Option<AnyElement>>;
type CaptionFor = Rc<dyn Fn(&LightboxItem, &App) -> Option<SharedString>>;

pub struct Lightbox {
    focus_handle: FocusHandle,
    items: Vec<LightboxItem>,
    current: usize,
    current_key: SharedString,
    can_load_more: bool,
    /// → was pressed at the end, on this item: step forward from it when the
    /// next item arrives. Cleared by any other navigation.
    advance_from: Option<SharedString>,
    show_details: bool,
    actions_for: ActionsFor,
    details_for: DetailsFor,
    caption_for: Option<CaptionFor>,
    /// The player of the clip on screen, made when a clip comes up and
    /// dropped (download and decoder with it) when the viewer moves on.
    clip: Option<(SharedString, Entity<crate::ClipViewer>)>,
}

impl EventEmitter<LightboxEvent> for Lightbox {}

impl Lightbox {
    /// Opens on `key` within `items`. `actions_for` builds the action bar for an
    /// item; `details_for` its details panel (I), if it has one.
    pub fn new(
        items: Vec<LightboxItem>,
        key: SharedString,
        can_load_more: bool,
        actions_for: impl Fn(&LightboxItem, &mut Window, &mut App) -> Vec<TileAction> + 'static,
        details_for: impl Fn(&LightboxItem, &mut Window, &mut App) -> Option<AnyElement> + 'static,
        cx: &mut App,
    ) -> Entity<Self> {
        cx.new(|cx| {
            let current = items.iter().position(|item| item.key == key).unwrap_or(0);
            Self {
                focus_handle: cx.focus_handle(),
                current_key: items
                    .get(current)
                    .map(|item| item.key.clone())
                    .unwrap_or(key),
                items,
                current,
                can_load_more,
                advance_from: None,
                show_details: false,
                actions_for: Rc::new(actions_for),
                details_for: Rc::new(details_for),
                caption_for: None,
                clip: None,
            }
        })
    }

    pub fn current(&self) -> Option<&LightboxItem> {
        self.items.get(self.current)
    }

    /// A short muted text before the action bar, e.g. a result's price.
    pub fn set_caption_for(
        &mut self,
        caption_for: impl Fn(&LightboxItem, &App) -> Option<SharedString> + 'static,
    ) {
        self.caption_for = Some(Rc::new(caption_for));
    }

    /// The list changed (live updates, more loaded). Keeps the current item.
    pub fn set_items(
        &mut self,
        items: Vec<LightboxItem>,
        can_load_more: bool,
        cx: &mut Context<Self>,
    ) {
        self.items = items;
        self.can_load_more = can_load_more;
        if self.items.is_empty() {
            cx.emit(LightboxEvent::Closed);
            return;
        }
        let keys: Vec<&SharedString> = self.items.iter().map(|item| &item.key).collect();
        let (current, advance_from) = place(
            &keys,
            self.current,
            &self.current_key,
            self.advance_from.take(),
            can_load_more,
        );
        self.current = current;
        self.advance_from = advance_from;
        self.current_key = self.items[self.current].key.clone();
        cx.notify();
    }

    /// Pauses a playing clip while the viewer is not shown (`false`): its
    /// screen hidden, the window hidden. `true` resumes what was playing.
    pub fn set_active(&mut self, active: bool, cx: &mut Context<Self>) {
        if let Some((_, clip)) = &self.clip {
            clip.update(cx, |clip, cx| clip.set_active(active, cx));
        }
    }

    fn step(&mut self, forward: bool, cx: &mut Context<Self>) {
        // Any navigation replaces a pending "→ once it arrives".
        self.advance_from = None;
        if forward {
            if self.current + 1 < self.items.len() {
                self.current += 1;
            } else if self.can_load_more {
                self.advance_from = Some(self.current_key.clone());
                cx.emit(LightboxEvent::LoadMore);
            }
        } else if self.current > 0 {
            self.current -= 1;
        }
        if let Some(item) = self.items.get(self.current) {
            self.current_key = item.key.clone();
        }
        if self.can_load_more && self.current + LOAD_MORE_WITHIN >= self.items.len() {
            cx.emit(LightboxEvent::LoadMore);
        }
        cx.notify();
    }

    fn close(&mut self, cx: &mut Context<Self>) {
        cx.emit(LightboxEvent::Closed);
    }

    /// Keeps the clip player in step with `item`: one for a clip with a URL
    /// (made when it comes up, focused so Space, K, M and F reach it while
    /// ← → and Esc still reach the viewer around it), none for anything else.
    /// A player that goes away takes its download, decoder and sound with it,
    /// and gives the keyboard back to the viewer.
    fn sync_clip(&mut self, item: &LightboxItem, window: &mut Window, cx: &mut Context<Self>) {
        let url = (item.media == TileMedia::Video)
            .then(|| item.video_url.clone())
            .flatten();
        if self
            .clip
            .as_ref()
            .is_some_and(|(key, _)| url.is_some() && *key == item.key)
        {
            return;
        }
        let had_focus = self
            .clip
            .take()
            .is_some_and(|(_, clip)| clip.read(cx).focus_handle(cx).contains_focused(window, cx));
        match url {
            Some(url) => {
                let poster = item.preview.clone();
                let clip = cx.new(|cx| crate::ClipViewer::new(url, poster, cx));
                clip.read(cx).focus_handle(cx).focus(window, cx);
                self.clip = Some((item.key.clone(), clip));
            }
            None if had_focus => self.focus_handle.focus(window, cx),
            None => {}
        }
    }
}

/// Where the viewer stands in a changed, non-empty list `keys`: on
/// `current_key` wherever it moved, or — if it went away — on whatever is now
/// at its old position `current`. A pending → (`advance_from`) applies only to
/// the item it was pressed on, and only once something follows it; until then
/// it keeps waiting while the list can grow. Returns the index and what is
/// still pending.
fn place(
    keys: &[&SharedString],
    current: usize,
    current_key: &SharedString,
    advance_from: Option<SharedString>,
    can_load_more: bool,
) -> (usize, Option<SharedString>) {
    let found = keys.iter().position(|key| *key == current_key);
    let ix = found.unwrap_or(current.min(keys.len() - 1));
    match advance_from {
        Some(from) if found.is_some() && from == *current_key => {
            if ix + 1 < keys.len() {
                (ix + 1, None)
            } else if can_load_more {
                (ix, Some(from))
            } else {
                (ix, None)
            }
        }
        _ => (ix, None),
    }
}

impl Focusable for Lightbox {
    fn focus_handle(&self, _: &App) -> FocusHandle {
        self.focus_handle.clone()
    }
}

impl Render for Lightbox {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let Some(item) = self.items.get(self.current).cloned() else {
            return div().into_any_element();
        };
        let actions = (self.actions_for)(&item, window, cx);
        let caption = self
            .caption_for
            .as_ref()
            .and_then(|caption_for| caption_for(&item, cx));
        let details = if self.show_details {
            (self.details_for)(&item, window, cx)
        } else {
            None
        };
        let has_previous = self.current > 0;
        let has_next = self.current + 1 < self.items.len() || self.can_load_more;
        let counter: SharedString = format!("{} / {}", self.current + 1, self.items.len()).into();

        self.sync_clip(&item, window, cx);
        let preview = item.preview.clone().urgent();
        let media: AnyElement = match item.media {
            TileMedia::Image => img(media_image(item.original.clone().urgent()))
                .id(item.key.clone())
                .max_w_full()
                .max_h_full()
                .object_fit(ObjectFit::Contain)
                .with_loading(move || {
                    img(media_image(preview.clone()))
                        .size_full()
                        .object_fit(ObjectFit::Contain)
                        .into_any_element()
                })
                .with_fallback(|| {
                    div()
                        .child("Image unavailable — the backend server may be offline")
                        .into_any_element()
                })
                .into_any_element(),
            TileMedia::Video => match &self.clip {
                Some((_, clip)) => clip.clone().into_any_element(),
                None => img(media_image(preview))
                    .max_w_full()
                    .max_h_full()
                    .object_fit(ObjectFit::Contain)
                    .into_any_element(),
            },
        };

        h_flex()
            .id("lightbox")
            .key_context(CONTEXT)
            .track_focus(&self.focus_handle)
            .absolute()
            .inset_0()
            .items_stretch()
            .bg(cx.theme().background.opacity(0.97))
            .on_action(cx.listener(|this, _: &CloseLightbox, _, cx| this.close(cx)))
            .on_action(cx.listener(|this, _: &PreviousItem, _, cx| this.step(false, cx)))
            .on_action(cx.listener(|this, _: &NextItem, _, cx| this.step(true, cx)))
            .on_action(cx.listener(|this, _: &ToggleDetails, _, cx| {
                this.show_details = !this.show_details;
                cx.notify();
            }))
            .child(
                v_flex()
                    .flex_1()
                    .min_w_0()
                    .child(
                        h_flex()
                            .p_2()
                            .justify_between()
                            .child(
                                div()
                                    .px_2()
                                    .text_sm()
                                    .text_color(cx.theme().muted_foreground)
                                    .child(counter),
                            )
                            .child(
                                h_flex()
                                    .gap_1()
                                    .when_some(caption, |this, caption| {
                                        this.child(
                                            div()
                                                .mr_2()
                                                .text_sm()
                                                .text_color(cx.theme().muted_foreground)
                                                .child(caption),
                                        )
                                    })
                                    .children(
                                        actions.into_iter().map(|action| action.into_element()),
                                    )
                                    .child(
                                        Button::new("details")
                                            .ghost()
                                            .small()
                                            .icon(IconName::Info)
                                            .tooltip(if self.show_details {
                                                "Hide details (I)"
                                            } else {
                                                "Show details (I)"
                                            })
                                            .on_click(cx.listener(|this, _, _, cx| {
                                                this.show_details = !this.show_details;
                                                cx.notify();
                                            })),
                                    )
                                    .child(
                                        Button::new("close")
                                            .ghost()
                                            .small()
                                            .icon(IconName::X)
                                            .tooltip("Close (Esc)")
                                            .on_click(cx.listener(|this, _, _, cx| this.close(cx))),
                                    ),
                            ),
                    )
                    .child(
                        h_flex()
                            .flex_1()
                            .min_h_0()
                            .px_2()
                            .pb_4()
                            .gap_2()
                            .child(
                                Button::new("previous")
                                    .ghost()
                                    .icon(IconName::ChevronLeft)
                                    .tooltip("Previous (←)")
                                    .disabled(!has_previous)
                                    .on_click(cx.listener(|this, _, _, cx| this.step(false, cx))),
                            )
                            .child(
                                div()
                                    .flex_1()
                                    .min_w_0()
                                    .h_full()
                                    .flex()
                                    .items_center()
                                    .justify_center()
                                    .child(media),
                            )
                            .child(
                                Button::new("next")
                                    .ghost()
                                    .icon(IconName::ChevronRight)
                                    .tooltip("Next (→)")
                                    .disabled(!has_next)
                                    .on_click(cx.listener(|this, _, _, cx| this.step(true, cx))),
                            ),
                    ),
            )
            .when_some(details, |this, details| {
                this.child(
                    div()
                        .w_80()
                        .flex_shrink_0()
                        .h_full()
                        .border_l_1()
                        .border_color(cx.theme().border)
                        .bg(cx.theme().popover)
                        .child(details),
                )
            })
            .into_any_element()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn keys(names: &[&'static str]) -> Vec<SharedString> {
        names.iter().map(|name| SharedString::from(*name)).collect()
    }

    fn place_in(
        names: &[&'static str],
        current: usize,
        key: &'static str,
        advance_from: Option<&'static str>,
    ) -> (usize, Option<SharedString>) {
        let keys = keys(names);
        let keys: Vec<&SharedString> = keys.iter().collect();
        place(
            &keys,
            current,
            &SharedString::from(key),
            advance_from.map(SharedString::from),
            true,
        )
    }

    #[test]
    fn a_pending_step_lands_on_the_first_new_item() {
        // → at the end on "c"; the next page arrives.
        assert_eq!(
            place_in(&["a", "b", "c", "d"], 2, "c", Some("c")),
            (3, None)
        );
    }

    #[test]
    fn a_new_result_above_does_not_trigger_the_pending_step() {
        // A result lands at the top while → waits at the end on "c".
        assert_eq!(
            place_in(&["new", "a", "b", "c"], 2, "c", Some("c")),
            (3, Some("c".into()))
        );
    }

    #[test]
    fn a_step_pressed_on_another_item_does_nothing() {
        // → at the end on "c", then ← to "b" (which clears it in `step`; a
        // stale one must not apply either).
        assert_eq!(
            place_in(&["a", "b", "c", "d"], 1, "b", Some("c")),
            (1, None)
        );
    }

    #[test]
    fn a_vanished_item_is_replaced_by_its_position() {
        assert_eq!(place_in(&["a", "c"], 1, "b", None), (1, None));
        assert_eq!(place_in(&["a"], 3, "z", Some("z")), (0, None));
    }
}
