//! Saved searches: named intents synced through Convex to the web and iOS
//! apps, and the raw queries this Mac remembers (the web's localStorage
//! `artsnack.search.history.v1`).
//!
//! Save checks what the server checks (`validateSavedSearchInput`) before
//! sending, whether pressed or by Enter: a name of 1–80 UTF-16 units once
//! trimmed, and an intent of 1–16 000. The default search serialises to
//! nothing, so it says so instead of offering a Save the server refuses.

use std::{collections::HashSet, rc::Rc};

use artsnack_backend::{
    Backend, LiveQuery, NoArgs,
    api::saved_searches::{self, MAX_TITLE_CHARS, RemoveArgs, SaveArgs, SavedSearch},
};
use artsnack_settings::{Preference, Preferences};
use gpui_kit::{
    App, AppContext as _, Context, Entity, EventEmitter, FocusHandle, Focusable, FontWeight,
    InteractiveElement as _, IntoElement, ParentElement as _, Render, SharedString,
    StatefulInteractiveElement as _, Styled as _, Subscription, Window,
    assets::IconName,
    component::{
        ActiveTheme as _, Disableable as _, Sizable as _, WindowExt as _,
        button::{Button, ButtonVariants as _},
        h_flex,
        input::{Input, InputEvent, InputState},
        notification::Notification,
        spinner::Spinner,
        v_flex,
    },
    div,
    prelude::FluentBuilder as _,
    rems,
};
use serde_json::Value;

use crate::engine::{
    SEARCH_HISTORY_LIMIT, SearchIntent, add_search_history, deserialize_search_intent, is_js_space,
    search_history_from_value, serialize_search_intent,
};

/// The longest intent the server stores (`MAX_INTENT`), in UTF-16 units.
const MAX_INTENT_UNITS: usize = 16_000;

/// Why a search cannot be saved under a name.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum SaveError {
    NoName,
    NameTooLong,
    /// The default search: nothing to save.
    Nothing,
    TooLarge,
}

impl SaveError {
    /// What to say under the field; an empty name only disables Save.
    fn message(self) -> Option<String> {
        match self {
            SaveError::NoName => None,
            SaveError::NameTooLong => Some(format!(
                "A name can be at most {MAX_TITLE_CHARS} characters."
            )),
            SaveError::Nothing => Some(
                "Type a query or set a filter first: the default search has nothing to save."
                    .into(),
            ),
            SaveError::TooLarge => Some("This search is too large to save.".into()),
        }
    }
}

/// The server's rules for a save (`validateSavedSearchInput`): the trimmed
/// name, or why it would be refused. Lengths are JavaScript's, in UTF-16
/// units, and trimming is JavaScript's `trim()`.
fn validate_save(title: &str, intent: &str) -> Result<String, SaveError> {
    let units = |text: &str| text.encode_utf16().count();
    let title = title.trim_matches(is_js_space);
    if title.is_empty() {
        return Err(SaveError::NoName);
    }
    if units(title) > MAX_TITLE_CHARS {
        return Err(SaveError::NameTooLong);
    }
    if intent.is_empty() {
        return Err(SaveError::Nothing);
    }
    if units(intent) > MAX_INTENT_UNITS {
        return Err(SaveError::TooLarge);
    }
    Ok(title.to_string())
}

/// The raw queries typed here, newest first.
const HISTORY: Preference<Value> = Preference::new("search.history", || Value::Array(Vec::new()));

pub fn recent_queries(cx: &App) -> Vec<String> {
    search_history_from_value(&Preferences::get(cx, &HISTORY), SEARCH_HISTORY_LIMIT)
}

/// Remembers a query that stuck: newest first, no repeats, at most 20.
pub fn remember_query(query: &str, cx: &mut App) {
    if query.trim().is_empty() {
        return;
    }
    let next = add_search_history(&recent_queries(cx), query, SEARCH_HISTORY_LIMIT);
    Preferences::set(cx, &HISTORY, Value::from(next));
}

pub enum SavedSearchesEvent {
    /// Run this search now.
    Load(SearchIntent),
}

/// The Saved searches dialog's content.
pub struct SavedSearches {
    focus_handle: FocusHandle,
    /// The search to save under a name, and its URL form.
    intent: SearchIntent,
    encoded: String,
    name: Entity<InputState>,
    list: Entity<LiveQuery<Vec<SavedSearch>>>,
    /// The list's entries with their intents, decoded once per change, less
    /// the ones being deleted.
    entries: Rc<Vec<(SavedSearch, SearchIntent)>>,
    /// Deleted here and maybe still listed: off the list until the live list
    /// drops them, or back if the delete fails.
    removing: HashSet<String>,
    history: Vec<String>,
    saving: bool,
    _subscriptions: Vec<Subscription>,
}

impl EventEmitter<SavedSearchesEvent> for SavedSearches {}

impl SavedSearches {
    pub fn new(intent: SearchIntent, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let name = cx.new(|cx| InputState::new(window, cx).placeholder("Name this search"));
        let list = LiveQuery::new(saved_searches::LIST, &NoArgs {}, cx);
        let subscriptions = vec![
            cx.observe(&list, |this, _, cx| this.list_changed(cx)),
            cx.subscribe_in(&name, window, |this, _, event, window, cx| match event {
                InputEvent::PressEnter { .. } => this.save(window, cx),
                InputEvent::Change => cx.notify(),
                _ => {}
            }),
        ];
        let entries = Rc::new(Self::decode(&list, cx));
        Self {
            focus_handle: cx.focus_handle(),
            encoded: serialize_search_intent(&intent),
            intent,
            name,
            list,
            entries,
            removing: HashSet::new(),
            history: recent_queries(cx),
            saving: false,
            _subscriptions: subscriptions,
        }
    }

    fn list_changed(&mut self, cx: &mut Context<Self>) {
        if let Some(listed) = self.list.read(cx).data() {
            let listed = listed.clone();
            self.removing
                .retain(|id| listed.iter().any(|entry| &entry.id == id));
        }
        self.reshow(cx);
    }

    fn reshow(&mut self, cx: &mut Context<Self>) {
        let mut entries = Self::decode(&self.list, cx);
        entries.retain(|(entry, _)| !self.removing.contains(&entry.id));
        self.entries = Rc::new(entries);
        cx.notify();
    }

    /// The name field, focused when the dialog opens.
    pub fn name_input(&self) -> &Entity<InputState> {
        &self.name
    }

    fn decode(
        list: &Entity<LiveQuery<Vec<SavedSearch>>>,
        cx: &App,
    ) -> Vec<(SavedSearch, SearchIntent)> {
        list.read(cx)
            .data()
            .map(|entries| {
                entries
                    .iter()
                    .map(|entry| (entry.clone(), deserialize_search_intent(&entry.intent)))
                    .collect()
            })
            .unwrap_or_default()
    }

    /// The name typed, checked against the server's rules.
    fn checked_title(&self, cx: &App) -> Result<String, SaveError> {
        validate_save(&self.name.read(cx).value(), &self.encoded)
    }

    fn save(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.saving {
            return;
        }
        // Enter takes this path too, so the button's rules hold for it.
        let Ok(title) = self.checked_title(cx) else {
            return;
        };
        self.saving = true;
        cx.notify();
        let args = SaveArgs {
            title,
            intent: self.encoded.clone(),
        };
        let task = Backend::global(cx).update(cx, |backend, cx| {
            backend.mutate(saved_searches::SAVE, &args, cx)
        });
        let window_handle = window.window_handle();
        cx.spawn(async move |this, cx| {
            let result = task.await;
            let saved = result.is_ok();
            let _ = window_handle.update(cx, |_, window, cx| {
                let _ = this.update(cx, |this, cx| {
                    this.saving = false;
                    if saved {
                        this.name
                            .update(cx, |input, cx| input.set_value("", window, cx));
                    }
                    cx.notify();
                });
                match result {
                    Ok(_) => window.push_notification(Notification::success("Search saved"), cx),
                    Err(error) => window.push_notification(
                        Notification::error(format!(
                            "Couldn\u{2019}t save the search. {}",
                            error.user_message()
                        )),
                        cx,
                    ),
                }
            });
        })
        .detach();
    }

    /// Deletes at once, as the web does: a saved search is a shortcut, and it
    /// is one Save away from coming back.
    fn remove(&mut self, id: String, window: &mut Window, cx: &mut Context<Self>) {
        self.removing.insert(id.clone());
        self.reshow(cx);
        let task = Backend::global(cx).update(cx, |backend, cx| {
            backend.mutate(saved_searches::REMOVE, &RemoveArgs { id: id.clone() }, cx)
        });
        let window_handle = window.window_handle();
        cx.spawn(async move |this, cx| {
            if let Err(error) = task.await {
                let _ = this.update(cx, |this, cx| {
                    this.removing.remove(&id);
                    this.reshow(cx);
                });
                let _ = window_handle.update(cx, |_, window, cx| {
                    window.push_notification(
                        Notification::error(format!(
                            "Couldn\u{2019}t delete the search. {}",
                            error.user_message()
                        )),
                        cx,
                    );
                });
            }
        })
        .detach();
    }

    fn render_entries(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let loading = self.list.read(cx).is_loading();
        let error = self.list.read(cx).error().cloned();
        let muted = cx.theme().muted_foreground;
        let message = |text: SharedString| {
            div()
                .py_6()
                .text_center()
                .text_sm()
                .text_color(muted)
                .child(text)
        };
        if loading {
            return div()
                .py_6()
                .flex()
                .justify_center()
                .child(Spinner::new())
                .into_any_element();
        }
        if let Some(error) = error {
            return message(format!("Couldn\u{2019}t load saved searches. {error}").into())
                .into_any_element();
        }
        if self.entries.is_empty() {
            return message("No named searches yet.".into()).into_any_element();
        }
        v_flex()
            .id("saved-search-list")
            .max_h(rems(18.))
            .overflow_y_scroll()
            .gap_1()
            .children(self.entries.iter().map(|(entry, intent)| {
                let summary: SharedString = if intent.query.is_empty() {
                    "Recent generations with filters".into()
                } else {
                    intent.query.clone().into()
                };
                let load = intent.clone();
                let id = entry.id.clone();
                h_flex()
                    .gap_1()
                    .child(
                        Button::new(SharedString::from(format!("saved-{}", entry.id)))
                            .ghost()
                            .flex_1()
                            .min_w_0()
                            .h_auto()
                            .py_1p5()
                            .child(
                                v_flex()
                                    .flex_1()
                                    .min_w_0()
                                    .items_start()
                                    .child(
                                        div()
                                            .w_full()
                                            .text_sm()
                                            .font_weight(FontWeight::MEDIUM)
                                            .truncate()
                                            .child(entry.title.clone()),
                                    )
                                    .child(
                                        div()
                                            .w_full()
                                            .text_xs()
                                            .text_color(muted)
                                            .truncate()
                                            .child(summary),
                                    ),
                            )
                            .on_click(cx.listener(move |_, _, _, cx| {
                                cx.emit(SavedSearchesEvent::Load(load.clone()))
                            })),
                    )
                    .child(
                        Button::new(SharedString::from(format!("delete-saved-{}", entry.id)))
                            .ghost()
                            .small()
                            .icon(IconName::Trash)
                            .tooltip(format!("Delete \u{201c}{}\u{201d}", entry.title))
                            .on_click(cx.listener(move |this, _, window, cx| {
                                this.remove(id.clone(), window, cx)
                            })),
                    )
            }))
            .into_any_element()
    }

    fn render_history(&self, cx: &mut Context<Self>) -> Option<impl IntoElement> {
        if self.history.is_empty() {
            return None;
        }
        Some(
            v_flex()
                .gap_2()
                .child(
                    div()
                        .text_xs()
                        .font_weight(FontWeight::SEMIBOLD)
                        .text_color(cx.theme().muted_foreground)
                        .child("Recent on this Mac"),
                )
                .child(
                    h_flex()
                        .flex_wrap()
                        .gap_1p5()
                        .children(self.history.iter().map(|query| {
                            let intent = SearchIntent {
                                query: query.clone(),
                                ..self.intent.clone()
                            };
                            Button::new(SharedString::from(format!("recent-{query}")))
                                .outline()
                                .xsmall()
                                .label(query.clone())
                                .on_click(cx.listener(move |_, _, _, cx| {
                                    cx.emit(SavedSearchesEvent::Load(intent.clone()))
                                }))
                        })),
                ),
        )
    }
}

impl Focusable for SavedSearches {
    fn focus_handle(&self, _: &App) -> FocusHandle {
        self.focus_handle.clone()
    }
}

impl Render for SavedSearches {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let checked = self.checked_title(cx);
        let problem = checked.as_ref().err().and_then(|error| error.message());
        v_flex()
            .gap_4()
            .child(
                div()
                    .text_sm()
                    .text_color(cx.theme().muted_foreground)
                    .child(
                        "Named searches sync to the web and iOS apps. The last 20 queries typed here stay on this Mac.",
                    ),
            )
            .child(
                v_flex()
                    .gap_1()
                    .child(
                        h_flex()
                            .gap_2()
                            .child(div().flex_1().child(Input::new(&self.name)))
                            .child(
                                Button::new("save-search")
                                    .primary()
                                    .icon(IconName::Bookmark)
                                    .label("Save")
                                    .loading(self.saving)
                                    .disabled(checked.is_err() || self.saving)
                                    .on_click(
                                        cx.listener(|this, _, window, cx| this.save(window, cx)),
                                    ),
                            ),
                    )
                    .when_some(problem, |this, problem| {
                        this.child(
                            div()
                                .text_xs()
                                .text_color(cx.theme().danger)
                                .child(problem),
                        )
                    }),
            )
            .child(self.render_entries(cx))
            .children(self.render_history(cx))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn checks_saves_as_the_server_does() {
        assert_eq!(validate_save("  cats \u{feff}", "q=cat"), Ok("cats".into()));
        assert_eq!(validate_save("   ", "q=cat"), Err(SaveError::NoName));
        // The default search serialises to nothing.
        assert_eq!(
            validate_save("all", &serialize_search_intent(&SearchIntent::default())),
            Err(SaveError::Nothing)
        );
        // 80 UTF-16 units, not 80 characters: 40 emoji are 80 units.
        let emoji = "\u{1F600}".repeat(40);
        assert!(validate_save(&emoji, "q=cat").is_ok());
        assert_eq!(
            validate_save(&format!("{emoji}a"), "q=cat"),
            Err(SaveError::NameTooLong)
        );
        assert_eq!(
            validate_save("big", &"x".repeat(MAX_INTENT_UNITS + 1)),
            Err(SaveError::TooLarge)
        );
    }
}
