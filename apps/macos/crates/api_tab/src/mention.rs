//! `@imageN` reference tags in the prompt (the web's prompt-input.tsx): typing
//! `@` offers the selected references, picking one writes the tag, and every
//! tag shows as an inline token. The text stays plain `@imageN`, so the form,
//! the rules and the vendors read exactly what the web writes.
//!
//! [`PromptMentions`] wraps a composer's prompt field with all of it; the
//! API composer and the self-hosted video form both use it.
//!
//! Where a mention starts and which spans are tags is decided by
//! packages/shared/grok-prompt.ts, through QuickJS. It counts in UTF-16, the
//! text field in UTF-8 bytes; this module converts between the two.
//!
//! The caret moves far more often than the text changes, and the prompt can
//! be long, so a move is checked against the field's focus first and a text
//! revision second, and only the words around the caret are handed to the
//! shared code — all of the prompt a mention under the caret can involve
//! ([`mention_window`]).

use std::{ops::Range, rc::Rc, sync::Arc};

use artsnack_rules::Rules;
use gpui_kit::{
    AnyElement, App, Context, Entity, EventEmitter, Focusable as _, InteractiveElement as _,
    IntoElement, KeystrokeEvent, MouseButton, ObjectFit, ParentElement as _, Render, RenderImage,
    SharedString, StatefulInteractiveElement as _, Styled as _, StyledImage as _, Subscription,
    Window, anchored,
    component::{
        ActiveTheme as _, ThemeStyled as _, h_flex,
        input::{InlineToken, InputContent, InputEvent, InputToken, Textarea, TextareaState},
        v_flex,
    },
    deferred, div, img,
    prelude::FluentBuilder as _,
    px, rems,
};
use serde::Deserialize;

/// The thumbnails of the references `@imageN` can name, in order; none while
/// the form takes no tags.
pub type TaggableReferences = Rc<dyn Fn(&App) -> Vec<Arc<RenderImage>>>;

/// The prompt changed by a tag being written. The field's own `Change` does
/// not fire for every part of that edit, so owners treat this as one.
#[derive(Clone, Debug)]
pub struct TagInserted;

/// A prompt field with the reference menu and tag tokens.
pub struct PromptMentions {
    prompt: Entity<TextareaState>,
    references: TaggableReferences,
    /// The `@word` at the caret while the menu is open.
    mention: Option<Mention>,
    /// The menu row the arrows are on.
    highlight: usize,
    /// Counts changes of the prompt's text.
    revision: u64,
    /// The text revision and caret the mention was last worked out for.
    seen: Option<(u64, usize)>,
    /// The menu opens above the caret: for a field at the foot of a pane.
    above: bool,
    _subscriptions: Vec<Subscription>,
}

impl EventEmitter<TagInserted> for PromptMentions {}

impl PromptMentions {
    pub fn new(
        prompt: Entity<TextareaState>,
        references: TaggableReferences,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        let subscriptions = vec![
            cx.subscribe_in(&prompt, window, |this, _, event, window, cx| match event {
                InputEvent::Blur => this.close(cx),
                InputEvent::Change => {
                    this.revision += 1;
                    this.sync(window, cx);
                }
                _ => {}
            }),
            // The caret moving is a notify, not an event: the mention follows it.
            cx.observe_in(&prompt, window, |this, _, window, cx| this.sync(window, cx)),
            // Arrows, Enter, Tab and Escape belong to the menu while it is
            // open; the text field would otherwise take them first.
            {
                let view = cx.entity().downgrade();
                cx.intercept_keystrokes(move |event, window, cx| {
                    let _ = view.update(cx, |this, cx| this.key(event, window, cx));
                })
            },
        ];
        Self {
            prompt,
            references,
            mention: None,
            highlight: 0,
            revision: 0,
            seen: None,
            above: false,
            _subscriptions: subscriptions,
        }
    }

    /// Opens the menu above the caret instead of below it.
    pub fn menu_above(mut self) -> Self {
        self.above = true;
        self
    }

    /// Replaces the prompt, showing its tags as tokens.
    pub fn set_text(&mut self, text: &str, window: &mut Window, cx: &mut Context<Self>) {
        let content = content(text, cx);
        self.prompt
            .update(cx, |state, cx| state.set_value(content, window, cx));
        self.revision += 1;
    }

    fn sync(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let state = self.prompt.read(cx);
        if !state.focus_handle(cx).is_focused(window) {
            self.close(cx);
            return;
        }
        let cursor = state.cursor();
        let seen = (self.revision, cursor);
        if self.seen == Some(seen) {
            return;
        }
        self.seen = Some(seen);
        let mention = if (self.references)(cx).is_empty() {
            None
        } else {
            let text = self.prompt.read(cx).text();
            let (back, forward) =
                mention_window(text.chars_at(cursor).reversed(), text.chars_at(cursor));
            let start = cursor - back;
            let window_text = text.slice(start..cursor + forward).to_string();
            mention_at(&window_text, back, cx).map(|mention| Mention {
                range: mention.range.start + start..mention.range.end + start,
                query: mention.query,
            })
        };
        if mention != self.mention {
            self.mention = mention;
            self.highlight = 0;
            cx.notify();
        }
    }

    fn close(&mut self, cx: &mut Context<Self>) {
        if self.mention.take().is_some() {
            cx.notify();
        }
    }

    /// The menu's keys; anything else, or any key with a modifier, goes on
    /// to the text field.
    fn key(&mut self, event: &KeystrokeEvent, window: &mut Window, cx: &mut Context<Self>) {
        let Some(mention) = self.mention.clone() else {
            return;
        };
        if event.keystroke.modifiers.modified()
            || !self.prompt.read(cx).focus_handle(cx).is_focused(window)
        {
            return;
        }
        let matches = mention.matches((self.references)(cx).len());
        if matches.is_empty() {
            return;
        }
        match event.keystroke.key.as_str() {
            "down" => self.highlight = (self.highlight + 1) % matches.len(),
            "up" => self.highlight = (self.highlight + matches.len() - 1) % matches.len(),
            "enter" | "tab" => {
                let number = matches[self.highlight.min(matches.len() - 1)];
                cx.stop_propagation();
                self.insert(number, mention, window, cx);
                return;
            }
            // Dismissed until the text or the caret moves again.
            "escape" => self.mention = None,
            _ => return,
        }
        cx.stop_propagation();
        cx.notify();
    }

    /// Writes `@imageN` as a token over the `@word` being typed (the web's
    /// `replaceGrokMention`).
    fn insert(
        &mut self,
        number: usize,
        mention: Mention,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.mention = None;
        let tag = format!("@image{number}");
        // Re-picking over an existing tag keeps what follows it as it is; a
        // new one gets a space to type on from.
        let existing = mention.query.is_empty() && mention.range.len() > 1;
        self.prompt.update(cx, |state, cx| {
            if let Err(error) =
                state.replace_range_with_token(mention.range, token(number, &tag), window, cx)
            {
                tracing::warn!(?error, "could not insert a reference tag");
                state.insert(tag.clone(), window, cx);
            }
            if !existing {
                state.insert(" ", window, cx);
            }
            state.focus(window, cx);
        });
        cx.emit(TagInserted);
        cx.notify();
    }

    /// The reference list under the `@` being typed.
    fn render_menu(
        &self,
        previews: &[Arc<RenderImage>],
        cx: &mut Context<Self>,
    ) -> Option<AnyElement> {
        let mention = self.mention.as_ref()?;
        let matches = mention.matches(previews.len());
        if matches.is_empty() {
            return None;
        }
        let caret = self
            .prompt
            .read(cx)
            .range_to_bounds(&(mention.range.start..mention.range.start))?;
        let (anchor, corner) = if self.above {
            (caret.origin, gpui_kit::Anchor::BottomLeft)
        } else {
            (caret.bottom_left(), gpui_kit::Anchor::TopLeft)
        };
        let above = self.above;
        let highlight = self.highlight.min(matches.len() - 1);
        let rows = matches.into_iter().enumerate().map(|(row, number)| {
            let preview = previews[number - 1].clone();
            let picked = mention.clone();
            h_flex()
                .id(SharedString::from(format!("mention-{number}")))
                .gap_3()
                .px_3()
                .py_1p5()
                .rounded(cx.theme().radius)
                .cursor_pointer()
                .when(row == highlight, |this| {
                    this.bg(cx.theme().accent)
                        .text_color(cx.theme().accent_foreground)
                })
                .child(
                    img(gpui_kit::ImageSource::Render(preview))
                        .size_9()
                        .rounded(cx.theme().radius)
                        .border_1()
                        .border_color(cx.theme().border)
                        .object_fit(ObjectFit::Cover),
                )
                .child(
                    div()
                        .text_sm()
                        .font_weight(gpui_kit::FontWeight::MEDIUM)
                        .child(format!("Image {number}")),
                )
                .on_hover(cx.listener(move |this, hovered: &bool, _, cx| {
                    if *hovered && this.highlight != row {
                        this.highlight = row;
                        cx.notify();
                    }
                }))
                // Mouse down, so the pick lands before the field's blur
                // closes the menu; the row carries its mention in case the
                // blur got there first.
                .on_mouse_down(
                    MouseButton::Left,
                    cx.listener(move |this, _, window, cx| {
                        cx.stop_propagation();
                        this.insert(number, picked.clone(), window, cx)
                    }),
                )
        });
        Some(
            deferred(
                anchored()
                    .anchor(corner)
                    .position(anchor)
                    .snap_to_window_with_margin(px(8.))
                    .child(
                        v_flex()
                            .id("mention-menu")
                            .when(above, |menu| menu.mb_1())
                            .when(!above, |menu| menu.mt_1())
                            .w(rems(16.))
                            .max_h(rems(15.))
                            .overflow_y_scroll()
                            .p_1()
                            .popover_style(cx)
                            .children(rows),
                    ),
            )
            .with_priority(1)
            .into_any_element(),
        )
    }
}

impl Render for PromptMentions {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let previews = (self.references)(cx);
        let count = previews.len();
        let field = Textarea::new(&self.prompt).token(move |token, _, cx| {
            let named = token_number(token.token().id());
            let valid = named.is_some_and(|number| (1..=count).contains(&number));
            // A tag past the references is refused at submit; show it now.
            InputToken::new(token).when(!valid, |chip| {
                chip.bg(cx.theme().danger.opacity(0.15))
                    .border_color(cx.theme().danger)
            })
        });
        div().child(field).children(self.render_menu(&previews, cx))
    }
}

/// The `@word` the caret is in, as byte offsets into the prompt.
#[derive(Clone, Debug, PartialEq)]
pub struct Mention {
    pub range: Range<usize>,
    /// What follows the `@`, lowercased: "", "ima", "2".
    pub query: String,
}

impl Mention {
    /// The reference numbers the mention can become, in order (the web's
    /// filter: everything for a bare `@`, else by `imageN` or `N` prefix).
    pub fn matches(&self, count: usize) -> Vec<usize> {
        (1..=count)
            .filter(|number| {
                self.query.is_empty()
                    || format!("image{number}").starts_with(&self.query)
                    || number.to_string().starts_with(&self.query)
            })
            .collect()
    }
}

#[derive(Deserialize)]
struct JsMention {
    start: usize,
    end: usize,
    query: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct JsTag {
    start: usize,
    end: usize,
    reference_index: usize,
}

/// Whitespace as JavaScript's `\s` has it, which grok-prompt.ts splits on.
fn is_js_space(character: char) -> bool {
    matches!(
        character,
        '\t' | '\n' | '\u{0B}' | '\u{0C}' | '\r' | ' ' | '\u{A0}' | '\u{1680}' | '\u{2000}'
            ..='\u{200A}'
                | '\u{2028}'
                | '\u{2029}'
                | '\u{202F}'
                | '\u{205F}'
                | '\u{3000}'
                | '\u{FEFF}'
    )
}

/// How far, in bytes, before and after the caret the text can bear on a
/// mention there: a mention is the word the caret ends (scanned back to
/// whitespace), and a tag the caret is in is `@image`, at most one
/// whitespace character and digits — so the word around the caret and one
/// word on each side, each up to its whitespace, hold all of it. Cut at
/// whitespace, the window ends where the full text's tag pattern would also
/// see a word boundary. `before` runs back from the caret, `after` on from it.
fn mention_window(
    before: impl Iterator<Item = char>,
    after: impl Iterator<Item = char>,
) -> (usize, usize) {
    fn reach(characters: impl Iterator<Item = char>) -> usize {
        let mut bytes = 0;
        let mut spaces = 0;
        let mut in_word = true;
        for character in characters {
            if is_js_space(character) {
                if spaces == 1 || !in_word {
                    break;
                }
                spaces += 1;
                in_word = false;
            } else {
                in_word = true;
            }
            bytes += character.len_utf8();
        }
        bytes
    }
    (reach(before), reach(after))
}

/// `getGrokMentionAtCaret` for a caret at byte `cursor`.
pub fn mention_at(text: &str, cursor: usize, cx: &App) -> Option<Mention> {
    let rules = Rules::global(cx)?;
    let caret = utf16_offset(text, cursor);
    let found: Option<JsMention> = rules
        .call("grokPrompt.getGrokMentionAtCaret", &(text, caret))
        .inspect_err(|error| tracing::warn!(?error, "mention lookup failed"))
        .ok()?;
    let found = found?;
    Some(Mention {
        range: byte_offset(text, found.start)..byte_offset(text, found.end),
        query: found.query,
    })
}

/// The text with each `@imageN` attached as a token, for `set_value`.
pub fn content(text: &str, cx: &App) -> InputContent {
    let tags: Vec<JsTag> = Rules::global(cx)
        .and_then(|rules| {
            rules
                .call("grokPrompt.findReferenceTags", &(text,))
                .inspect_err(|error| tracing::warn!(?error, "tag lookup failed"))
                .ok()
        })
        .unwrap_or_default();
    let plain = InputContent::new(text.to_string());
    tags.into_iter()
        .try_fold(plain.clone(), |content, tag| {
            let range = byte_offset(text, tag.start)..byte_offset(text, tag.end);
            content.with_token(range.clone(), token(tag.reference_index, &text[range]))
        })
        // A tag the field refuses (it overlaps another) leaves the text plain
        // rather than losing it.
        .unwrap_or(plain)
}

/// The token for reference `number`, spelled `text` (`@image2`, `@image 2`).
pub fn token(number: usize, text: &str) -> InlineToken {
    InlineToken::new(format!("image{number}"), text.to_string())
}

/// The reference a token names.
pub fn token_number(id: &SharedString) -> Option<usize> {
    id.strip_prefix("image")?.parse().ok()
}

fn utf16_offset(text: &str, byte: usize) -> usize {
    let byte = byte.min(text.len());
    let byte = (0..=byte)
        .rev()
        .find(|index| text.is_char_boundary(*index))
        .unwrap_or(0);
    text[..byte].encode_utf16().count()
}

fn byte_offset(text: &str, utf16: usize) -> usize {
    let mut units = 0;
    for (index, character) in text.char_indices() {
        if units >= utf16 {
            return index;
        }
        units += character.len_utf16();
    }
    text.len()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn offsets_round_trip_through_wide_characters() {
        let text = "ё 🙂 @image1";
        let at = text.find('@').unwrap();
        let units = utf16_offset(text, at);
        assert_eq!(units, "ё 🙂 ".encode_utf16().count());
        assert_eq!(byte_offset(text, units), at);
        assert_eq!(byte_offset(text, 999), text.len());
    }

    #[test]
    fn filters_like_the_web() {
        let mention = |query: &str| Mention {
            range: 0..1,
            query: query.into(),
        };
        assert_eq!(mention("").matches(3), vec![1, 2, 3]);
        assert_eq!(mention("ima").matches(2), vec![1, 2]);
        assert_eq!(mention("2").matches(12), vec![2]);
        assert_eq!(mention("image1").matches(12), vec![1, 10, 11, 12]);
        assert!(mention("x").matches(3).is_empty());
    }

    #[test]
    fn the_window_holds_the_words_around_the_caret() {
        fn window(text: &str, caret: usize) -> &str {
            let (back, forward) =
                mention_window(text[..caret].chars().rev(), text[caret..].chars());
            &text[caret - back..caret + forward]
        }
        let text = "a long prompt with @image 12 in it";
        let at = text.find("12").unwrap();
        // In the digits: the tag, space and all, is inside the window.
        assert_eq!(window(text, at + 1), "@image 12 in");
        // At "@ima|ge 12", the digits after the space are in it too.
        let at = text.find("ge 12").unwrap();
        assert_eq!(window(text, at), "with @image 12");
        // Typing a mention: the word back to its whitespace.
        assert_eq!(window("x @ima", 6), "x @ima");
        assert_eq!(window("", 0), "");
    }

    #[test]
    fn reads_token_numbers() {
        assert_eq!(token_number(&"image12".into()), Some(12));
        assert_eq!(token_number(&"photo".into()), None);
    }
}
