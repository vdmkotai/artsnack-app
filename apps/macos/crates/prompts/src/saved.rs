//! The saved-prompt library: one editable card per prompt.
//!
//! The list is virtual (`card_list`): only rows on screen are built, and a
//! card's editors are made the first time its row is drawn — from a live
//! answer only. A remembered snapshot, or the last rows before a failure,
//! shows read-only previews until the server answers.

use std::{
    collections::{HashMap, HashSet},
    sync::Arc,
};

use artsnack_backend::{
    Backend,
    api::saved_prompts::{self, SaveArgs, SavedPrompt, UpdateArgs},
};
use gpui_kit::{
    AnyElement, AppContext as _, ClipboardItem, Context, Entity, FontWeight, IntoElement,
    ParentElement as _, Render, Styled as _, Subscription, Window,
    assets::IconName,
    component::{
        ActiveTheme as _, Sizable as _, WindowExt as _,
        button::{Button, ButtonVariant, ButtonVariants as _},
        h_flex,
        input::{Input, InputEvent, InputState, Textarea, TextareaState},
        notification::Notification,
        spinner::Spinner,
        v_flex,
    },
    div,
};

use crate::{
    card_list::{CardList, Item, card_row},
    editor::{Saves, Tracked},
    store::{PromptStore, Rows, StoreEvent},
};

/// `MAX_TITLE` in packages/backend/convex/savedPrompts.ts.
const MAX_TITLE_CHARS: usize = 120;

/// The title the server stores for `title` (`title.slice(0, MAX_TITLE) ||
/// "Untitled"`).
fn stored_title(title: &str) -> String {
    let title: String = title.chars().take(MAX_TITLE_CHARS).collect();
    if title.is_empty() {
        "Untitled".into()
    } else {
        title
    }
}

pub struct PromptCard {
    id: String,
    title: Entity<InputState>,
    text: Entity<TextareaState>,
    tracked_title: Tracked,
    tracked_text: Tracked,
    saves: Saves,
    _subscriptions: Vec<Subscription>,
}

impl PromptCard {
    fn new(prompt: &SavedPrompt, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let title = cx.new(|cx| InputState::new(window, cx).default_value(prompt.title.clone()));
        let text = cx.new(|cx| {
            TextareaState::new(window, cx)
                .rows(6)
                .default_value(prompt.text.clone())
        });
        let subscriptions = vec![
            cx.subscribe_in(
                &title,
                window,
                |this, state, event, window, cx| match event {
                    InputEvent::Change => {
                        let value = state.read(cx).value().to_string();
                        this.tracked_title.edit(&value);
                        cx.notify();
                    }
                    InputEvent::Blur | InputEvent::PressEnter { .. } => this.save(window, cx),
                    _ => {}
                },
            ),
            cx.subscribe_in(
                &text,
                window,
                |this, state, event, window, cx| match event {
                    InputEvent::Change => {
                        let value = state.read(cx).value().to_string();
                        this.tracked_text.edit(&value);
                        cx.notify();
                    }
                    InputEvent::Blur => this.save(window, cx),
                    _ => {}
                },
            ),
        ];
        Self {
            id: prompt.id.clone(),
            title,
            text,
            tracked_title: Tracked::new(&prompt.title),
            tracked_text: Tracked::new(&prompt.text),
            saves: Saves::default(),
            _subscriptions: subscriptions,
        }
    }

    /// The server's copy changed; adopt it unless the card is being edited.
    fn server_update(&mut self, prompt: &SavedPrompt, window: &mut Window, cx: &mut Context<Self>) {
        let was_dirty = self.is_dirty();
        let title = self.tracked_title.server(&prompt.title);
        let text = self.tracked_text.server(&prompt.text);
        if let Some(title) = &title {
            self.title
                .update(cx, |input, cx| input.set_value(title.clone(), window, cx));
        }
        if let Some(text) = &text {
            self.text
                .update(cx, |input, cx| input.set_value(text.clone(), window, cx));
        }
        if title.is_some() || text.is_some() || was_dirty != self.is_dirty() {
            cx.notify();
        }
    }

    fn is_dirty(&self) -> bool {
        self.tracked_title.is_dirty() || self.tracked_text.is_dirty()
    }

    /// Sends the fields that changed. One save is out at a time; edits made
    /// meanwhile go out after it. A failure keeps the text and offers Retry.
    fn save(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if !self.is_dirty() {
            return;
        }
        let sent_text = self
            .tracked_text
            .is_dirty()
            .then(|| self.tracked_text.local().to_string());
        if sent_text
            .as_deref()
            .is_some_and(|text| text.trim().is_empty())
        {
            window.push_notification(Notification::error("A prompt cannot be empty"), cx);
            let restored = self.tracked_text.revert();
            self.text
                .update(cx, |input, cx| input.set_value(restored, window, cx));
            cx.notify();
            if !self.tracked_title.is_dirty() {
                return;
            }
        }
        let sent_text = sent_text.filter(|text| !text.trim().is_empty());
        let sent_title = self
            .tracked_title
            .is_dirty()
            .then(|| self.tracked_title.local().to_string());
        if sent_title.is_none() && sent_text.is_none() {
            return;
        }
        if !self.saves.begin() {
            return;
        }
        cx.notify();
        let args = UpdateArgs {
            id: self.id.clone(),
            title: sent_title.clone(),
            text: sent_text.as_deref().map(|text| text.trim().to_string()),
        };
        let request = Backend::global(cx).update(cx, |backend, cx| {
            backend.mutate(saved_prompts::UPDATE, &args, cx)
        });
        let window_handle = window.window_handle();
        cx.spawn(async move |this, cx| {
            let result = request.await;
            let _ = window_handle.update(cx, |_, window, cx| {
                let _ = this.update(cx, |this, cx| {
                    let again = match result {
                        Ok(()) => {
                            if let Some(sent) = &sent_title
                                && let Some(shown) =
                                    this.tracked_title.saved(sent, &stored_title(sent))
                            {
                                this.title
                                    .update(cx, |input, cx| input.set_value(shown, window, cx));
                            }
                            if let Some(sent) = &sent_text
                                && let Some(shown) = this.tracked_text.saved(sent, sent.trim())
                            {
                                this.text
                                    .update(cx, |input, cx| input.set_value(shown, window, cx));
                            }
                            this.saves.finish(Ok(()))
                        }
                        Err(error) => {
                            let message = error.user_message();
                            window.push_notification(Notification::error(message.clone()), cx);
                            this.saves.finish(Err(message))
                        }
                    };
                    cx.notify();
                    if again {
                        this.save(window, cx);
                    }
                });
            });
        })
        .detach();
    }

    fn copy(&self, window: &mut Window, cx: &mut Context<Self>) {
        cx.write_to_clipboard(ClipboardItem::new_string(
            self.tracked_text.local().to_string(),
        ));
        window.push_notification(Notification::success("Prompt copied"), cx);
    }

    fn confirm_delete(&self, window: &mut Window, cx: &mut Context<Self>) {
        let id = self.id.clone();
        let title = self.tracked_title.local().to_string();
        window.open_alert_dialog(cx, move |alert, _, _| {
            let id = id.clone();
            alert
                .title(format!("Delete \u{201c}{title}\u{201d}?"))
                .confirm()
                .ok_text("Delete")
                .ok_variant(ButtonVariant::Danger)
                .on_ok(move |_, window, cx| {
                    let window = window.window_handle();
                    PromptStore::global(cx)
                        .update(cx, |store, cx| store.remove_prompt(id.clone(), window, cx));
                    true
                })
        });
    }

    /// Under the text: saving, the last failure with Retry, or unsaved.
    fn render_save_state(&self, cx: &mut Context<Self>) -> Option<AnyElement> {
        let muted = cx.theme().muted_foreground;
        if self.saves.is_saving() {
            return Some(
                div()
                    .text_xs()
                    .text_color(muted)
                    .child("Saving…")
                    .into_any_element(),
            );
        }
        if let Some(message) = self.saves.failed() {
            return Some(
                h_flex()
                    .gap_2()
                    .justify_between()
                    .child(
                        div()
                            .min_w_0()
                            .text_xs()
                            .text_color(cx.theme().danger)
                            .child(format!("Not saved: {message}")),
                    )
                    .child(
                        Button::new("retry-save")
                            .xsmall()
                            .outline()
                            .label("Retry")
                            .on_click(cx.listener(|this, _, window, cx| this.save(window, cx))),
                    )
                    .into_any_element(),
            );
        }
        self.is_dirty().then(|| {
            div()
                .text_xs()
                .text_color(muted)
                .child("Unsaved — click away to save.")
                .into_any_element()
        })
    }
}

impl Render for PromptCard {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let save_state = self.render_save_state(cx);
        card_frame(cx)
            .child(
                h_flex()
                    .gap_1()
                    .child(
                        div()
                            .flex_1()
                            .child(Input::new(&self.title).appearance(false)),
                    )
                    .child(
                        Button::new("copy")
                            .ghost()
                            .xsmall()
                            .icon(IconName::Copy)
                            .tooltip("Copy prompt")
                            .on_click(cx.listener(|this, _, window, cx| this.copy(window, cx))),
                    )
                    .child(
                        Button::new("delete")
                            .ghost()
                            .xsmall()
                            .icon(IconName::Trash)
                            .tooltip("Delete prompt")
                            .on_click(
                                cx.listener(|this, _, window, cx| this.confirm_delete(window, cx)),
                            ),
                    ),
            )
            .child(Textarea::new(&self.text))
            .children(save_state)
    }
}

fn card_frame(cx: &gpui_kit::App) -> gpui_kit::Div {
    v_flex()
        .gap_2()
        .p_3()
        .rounded(cx.theme().radius_lg)
        .border_1()
        .border_color(cx.theme().border)
        .bg(cx.theme().popover)
}

/// A prompt shown before the server has answered: the text, not editable.
fn preview(prompt: &SavedPrompt, cx: &gpui_kit::App) -> AnyElement {
    card_frame(cx)
        .child(
            div()
                .truncate()
                .text_sm()
                .font_weight(FontWeight::MEDIUM)
                .child(prompt.title.clone()),
        )
        .child(
            div()
                .text_sm()
                .text_color(cx.theme().muted_foreground)
                .line_clamp(6)
                .child(prompt.text.clone()),
        )
        .into_any_element()
}

pub struct SavedPromptsTab {
    store: Entity<PromptStore>,
    /// The rows the list was last laid out for.
    rows: Rows<Vec<SavedPrompt>>,
    /// Editors, made the first time a card is drawn from a live answer.
    cards: HashMap<String, Entity<PromptCard>>,
    list: CardList,
    creating: bool,
    _subscriptions: Vec<Subscription>,
}

impl SavedPromptsTab {
    pub fn new(window: &mut Window, cx: &mut Context<Self>) -> Self {
        let store = PromptStore::global(cx);
        let subscriptions =
            vec![
                cx.subscribe_in(&store, window, |this, _, event: &StoreEvent, window, cx| {
                    if *event == StoreEvent::SavedPrompts {
                        this.sync(window, cx);
                    }
                }),
            ];
        let mut this = Self {
            store,
            rows: Rows {
                data: None,
                fresh: false,
                error: None,
            },
            cards: HashMap::new(),
            list: CardList::new(),
            creating: false,
            _subscriptions: subscriptions,
        };
        this.sync(window, cx);
        this
    }

    /// Brings the cards and the list in line with the store. Only cards whose
    /// row changed hear about it.
    fn sync(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let next = self.store.read(cx).saved_prompts(cx);
        if next.same_as(&self.rows) && self.list.is_synced() {
            return;
        }
        let rows: Arc<Vec<SavedPrompt>> = next.data.clone().unwrap_or_default();
        let previous: HashMap<&str, &SavedPrompt> = self
            .rows
            .data
            .iter()
            .flat_map(|rows| rows.iter())
            .map(|prompt| (prompt.id.as_str(), prompt))
            .collect();
        let mut changed = Vec::new();
        if next.data.is_some() {
            let present: HashSet<&str> = rows.iter().map(|prompt| prompt.id.as_str()).collect();
            self.cards.retain(|id, _| present.contains(id.as_str()));
        }
        for (ix, prompt) in rows.iter().enumerate() {
            if previous.get(prompt.id.as_str()) == Some(&prompt) {
                continue;
            }
            changed.push(ix);
            if let Some(card) = self.cards.get(&prompt.id) {
                card.update(cx, |card, cx| card.server_update(prompt, window, cx));
            }
        }
        let ids = rows.iter().map(|prompt| prompt.id.clone()).collect();
        let trailing = usize::from(rows.is_empty());
        self.list.sync(ids, &changed, trailing, next.fresh);
        self.rows = next;
        cx.notify();
    }

    fn create(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.creating = true;
        cx.notify();
        let args = SaveArgs {
            text: "New prompt".into(),
            title: Some("New prompt".into()),
            allow_duplicate: Some(true),
        };
        let request = Backend::global(cx).update(cx, |backend, cx| {
            backend.mutate(saved_prompts::SAVE, &args, cx)
        });
        let window_handle = window.window_handle();
        cx.spawn(async move |this, cx| {
            let result = request.await;
            let _ = this.update(cx, |this, cx| {
                this.creating = false;
                cx.notify();
            });
            if let Err(error) = result {
                let _ = window_handle.update(cx, |_, window, cx| {
                    window.push_notification(Notification::error(error.user_message()), cx)
                });
            }
        })
        .detach();
    }

    fn retry(&mut self, cx: &mut Context<Self>) {
        self.store.update(cx, |store, cx| store.retry(cx));
    }

    fn render_item(
        &mut self,
        ix: usize,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        match self.list.item(ix) {
            Item::Header => self.render_toolbar(cx),
            Item::Row(left, right) => {
                let Some(rows) = self.rows.data.clone() else {
                    return div().into_any_element();
                };
                let left = rows
                    .get(left)
                    .map(|prompt| self.render_card(prompt, window, cx));
                let right = rows
                    .get(right)
                    .map(|prompt| self.render_card(prompt, window, cx));
                card_row(left, right)
            }
            Item::Trailing(_) => self.render_empty(cx),
        }
    }

    fn render_card(
        &mut self,
        prompt: &SavedPrompt,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        if let Some(card) = self.cards.get(&prompt.id) {
            return card.clone().into_any_element();
        }
        if !self.rows.fresh {
            return preview(prompt, cx);
        }
        let card = cx.new(|cx| PromptCard::new(prompt, window, cx));
        self.cards.insert(prompt.id.clone(), card.clone());
        card.into_any_element()
    }

    /// "New prompt", and what the list is showing when it is not live.
    fn render_toolbar(&self, cx: &mut Context<Self>) -> AnyElement {
        let muted = cx.theme().muted_foreground;
        let status: Option<AnyElement> = match (&self.rows.error, self.rows.fresh) {
            (Some(error), _) => Some(
                h_flex()
                    .gap_2()
                    .min_w_0()
                    .child(
                        div()
                            .min_w_0()
                            .text_sm()
                            .text_color(cx.theme().danger)
                            .child(format!("Could not load your prompts: {error}")),
                    )
                    .child(
                        Button::new("retry-prompts")
                            .xsmall()
                            .outline()
                            .label("Retry")
                            .on_click(cx.listener(|this, _, _, cx| this.retry(cx))),
                    )
                    .into_any_element(),
            ),
            (None, false) if self.rows.data.is_some() => Some(
                h_flex()
                    .gap_2()
                    .text_sm()
                    .text_color(muted)
                    .child(Spinner::new().xsmall())
                    .child("Updating…")
                    .into_any_element(),
            ),
            _ => None,
        };
        h_flex()
            .px_4()
            .pb_4()
            .gap_4()
            .justify_between()
            .child(div().min_w_0().children(status))
            .child(
                Button::new("new-prompt")
                    .primary()
                    .small()
                    .icon(IconName::Plus)
                    .label("New prompt")
                    .loading(self.creating)
                    .on_click(cx.listener(|this, _, window, cx| this.create(window, cx))),
            )
            .into_any_element()
    }

    /// Loading, or nothing saved — the error, if any, is in the toolbar.
    fn render_empty(&self, cx: &mut Context<Self>) -> AnyElement {
        if self.rows.data.is_none() {
            if self.rows.error.is_some() {
                return div().into_any_element();
            }
            return div()
                .py_8()
                .flex()
                .justify_center()
                .child(Spinner::new())
                .into_any_element();
        }
        v_flex()
            .py_8()
            .items_center()
            .gap_1()
            .child(
                div()
                    .font_weight(FontWeight::SEMIBOLD)
                    .child("Nothing saved yet"),
            )
            .child(
                div()
                    .text_sm()
                    .text_color(cx.theme().muted_foreground)
                    .child("Press Save beside any prompt field, or start one here."),
            )
            .into_any_element()
    }
}

impl Render for SavedPromptsTab {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        self.list
            .render(cx.processor(|this, ix: usize, window, cx| this.render_item(ix, window, cx)))
    }
}

#[cfg(test)]
mod tests {
    use super::stored_title;

    #[test]
    fn titles_are_stored_cut_and_never_empty() {
        assert_eq!(stored_title(""), "Untitled");
        assert_eq!(stored_title("Night market"), "Night market");
        assert_eq!(stored_title(&"x".repeat(130)).chars().count(), 120);
    }
}
