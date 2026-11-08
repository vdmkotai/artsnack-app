//! The chat's pieces (the web's studio-variant-card.tsx and `UserBubble`): a
//! variant with its label, title, summary and prompt — clamped until opened,
//! a revision showing its changes against its parent — and the user's
//! messages with their `@imageN` tags marked.

use std::{ops::Range, sync::Arc};

use artsnack_backend::api::prompt_studio::StudioVariant;
use gpui_kit::{
    AnyElement, Context, HighlightStyle, InteractiveElement as _, IntoElement, ParentElement as _,
    RenderImage, SharedString, StatefulInteractiveElement as _, StrikethroughStyle, Styled as _,
    StyledText,
    assets::IconName,
    component::{
        ActiveTheme as _, Sizable as _,
        button::{Button, ButtonVariants as _},
        h_flex, v_flex,
    },
    div,
    prelude::FluentBuilder as _,
    px, relative, rems,
};
use serde::Deserialize;

use super::PromptStudio;

/// One run of `diffWords`.
#[derive(Clone, Debug, PartialEq, Deserialize)]
pub(crate) struct DiffSegment {
    /// "same" | "added" | "removed".
    pub kind: String,
    pub text: String,
}

pub(super) struct CardState<'a> {
    pub variant: &'a StudioVariant,
    /// The variant this one revises, while it is still in the session.
    pub parent: Option<&'a StudioVariant>,
    pub diff: Option<Arc<Vec<DiffSegment>>>,
    pub show_changes: bool,
    pub expanded: bool,
    /// The form's prompt is exactly this one.
    pub in_prompt: bool,
    /// The message box is answering this variant.
    pub replying: bool,
    pub copied: bool,
}

pub(super) fn variant_card(state: CardState, cx: &mut Context<PromptStudio>) -> AnyElement {
    let theme = cx.theme().clone();
    let variant = state.variant;
    let label = variant.label.clone();
    let words = variant.prompt.split_whitespace().count();
    let id = |what: &str| SharedString::from(format!("studio-{what}-{label}"));

    // The prompt, or its changes: removed words struck out, added ones marked.
    let text = match &state.diff {
        Some(segments) => {
            let mut text = String::new();
            let mut highlights: Vec<(Range<usize>, HighlightStyle)> = Vec::new();
            for segment in segments.iter() {
                let start = text.len();
                text.push_str(&segment.text);
                let range = start..text.len();
                match segment.kind.as_str() {
                    "added" => highlights.push((
                        range,
                        HighlightStyle {
                            color: Some(theme.foreground),
                            background_color: Some(theme.primary.opacity(0.35)),
                            ..Default::default()
                        },
                    )),
                    "removed" => highlights.push((
                        range,
                        HighlightStyle {
                            color: Some(theme.danger.opacity(0.8)),
                            strikethrough: Some(StrikethroughStyle {
                                thickness: px(1.),
                                color: Some(theme.danger.opacity(0.8)),
                            }),
                            ..Default::default()
                        },
                    )),
                    _ => {}
                }
            }
            StyledText::new(text).with_highlights(highlights)
        }
        None => StyledText::new(variant.prompt.clone()),
    };

    let prompt_box = div()
        .id(id("prompt"))
        .relative()
        .w_full()
        .rounded(theme.radius)
        .bg(theme.muted.opacity(0.4))
        .px_2p5()
        .py_2()
        .font_family(theme.mono_font_family.clone())
        .text_xs()
        .text_color(theme.muted_foreground)
        .cursor_pointer()
        .when(!state.expanded, |this| {
            this.max_h(rems(4.6)).overflow_hidden()
        })
        .tooltip({
            let expanded = state.expanded;
            move |window, cx| {
                gpui_kit::component::tooltip::Tooltip::new(if expanded {
                    "Collapse"
                } else {
                    "Show the whole prompt"
                })
                .build(window, cx)
            }
        })
        .child(text)
        .on_click({
            let label = label.clone();
            cx.listener(move |this, _, _, cx| this.toggle_expanded(&label, cx))
        });

    v_flex()
        .id(id("card"))
        .gap_1p5()
        .p_3()
        .rounded(theme.radius_lg)
        .border_1()
        .border_color(if state.in_prompt {
            theme.primary.opacity(0.6)
        } else {
            theme.border
        })
        .when(state.replying, |this| this.border_color(theme.primary))
        .bg(theme.background)
        .child(
            h_flex()
                .gap_2()
                .child(
                    div()
                        .flex_shrink_0()
                        .min_w_5()
                        .h_5()
                        .px_1()
                        .flex()
                        .items_center()
                        .justify_center()
                        .rounded(px(4.))
                        .bg(theme.muted)
                        .text_xs()
                        .font_weight(gpui_kit::FontWeight::SEMIBOLD)
                        .child(label.clone()),
                )
                .child(
                    div()
                        .flex_1()
                        .min_w_0()
                        .truncate()
                        .text_sm()
                        .font_weight(gpui_kit::FontWeight::MEDIUM)
                        .child(variant.title.clone()),
                )
                .child(if state.in_prompt {
                    h_flex()
                        .flex_shrink_0()
                        .gap_1()
                        .px_2()
                        .py_0p5()
                        .rounded_full()
                        .border_1()
                        .border_color(theme.primary.opacity(0.5))
                        .bg(theme.primary.opacity(0.15))
                        .text_xs()
                        .child(gpui_kit::component::Icon::new(IconName::Check).xsmall())
                        .child("In prompt")
                        .into_any_element()
                } else {
                    div()
                        .flex_shrink_0()
                        .text_xs()
                        .text_color(theme.muted_foreground)
                        .child(format!("{words} words"))
                        .into_any_element()
                }),
        )
        .when_some(variant.changes.clone(), |this, changes| {
            this.child(
                h_flex()
                    .flex_wrap()
                    .text_xs()
                    .child(div().text_color(theme.muted_foreground).child("Changed: "))
                    .child(changes),
            )
        })
        .when(!variant.summary.is_empty(), |this| {
            this.child(div().text_xs().child(variant.summary.clone()))
        })
        .child(prompt_box)
        .child(
            h_flex()
                .flex_wrap()
                .gap_1p5()
                .child(
                    Button::new(id("use"))
                        .small()
                        .when(state.in_prompt, |button| button.outline())
                        .when(!state.in_prompt, |button| button.primary())
                        .icon(IconName::CornerDownLeft)
                        .label(if state.in_prompt {
                            "Use again"
                        } else {
                            "Use this prompt"
                        })
                        .on_click({
                            let label = label.clone();
                            cx.listener(move |this, _, window, cx| this.insert(&label, window, cx))
                        }),
                )
                .child(
                    Button::new(id("refine"))
                        .small()
                        .when(state.replying, |button| button.primary())
                        .when(!state.replying, |button| button.outline())
                        .icon(IconName::PenLine)
                        .label("Refine")
                        .on_click({
                            let label = label.clone();
                            cx.listener(move |this, _, window, cx| this.refine(&label, window, cx))
                        }),
                )
                .when_some(state.parent, |row, parent| {
                    let label = label.clone();
                    row.child(
                        Button::new(id("changes"))
                            .small()
                            .ghost()
                            .label(if state.show_changes {
                                "Hide changes".to_string()
                            } else {
                                format!("Changes vs {}", parent.label)
                            })
                            .on_click(
                                cx.listener(move |this, _, _, cx| this.toggle_changes(&label, cx)),
                            ),
                    )
                })
                .child(div().flex_1())
                .child(
                    Button::new(id("copy"))
                        .small()
                        .ghost()
                        .icon(if state.copied {
                            IconName::Check
                        } else {
                            IconName::Copy
                        })
                        .tooltip("Copy the prompt")
                        .on_click({
                            let label = label.clone();
                            cx.listener(move |this, _, _, cx| this.copy(&label, cx))
                        }),
                ),
        )
        .into_any_element()
}

/// The user's message, right-aligned, with the variant it answers and its
/// `@imageN` tags marked (red for a tag past the references).
pub(super) fn user_bubble(
    id: SharedString,
    text: &str,
    reply_to: Option<&str>,
    references: &[Arc<RenderImage>],
    pending: bool,
    cx: &mut Context<PromptStudio>,
) -> AnyElement {
    let theme = cx.theme().clone();
    let highlights: Vec<(Range<usize>, HighlightStyle)> = reference_tags(text)
        .into_iter()
        .map(|(range, number)| {
            let known = (1..=references.len()).contains(&number);
            (
                range,
                HighlightStyle {
                    color: Some(if known { theme.primary } else { theme.danger }),
                    background_color: Some(if known {
                        theme.primary.opacity(0.15)
                    } else {
                        theme.danger.opacity(0.2)
                    }),
                    font_weight: Some(gpui_kit::FontWeight::MEDIUM),
                    ..Default::default()
                },
            )
        })
        .collect();
    h_flex()
        .id(id)
        .w_full()
        .justify_end()
        .child(
            v_flex()
                .max_w(relative(0.85))
                .gap_1()
                .px_3()
                .py_2()
                .rounded_xl()
                .bg(theme.muted)
                .text_sm()
                .when(pending, |this| this.opacity(0.7))
                .when_some(reply_to, |this, label| {
                    this.child(
                        h_flex()
                            .gap_1()
                            .pl_1p5()
                            .border_l_2()
                            .border_color(theme.primary.opacity(0.7))
                            .text_xs()
                            .text_color(theme.muted_foreground)
                            .child(gpui_kit::component::Icon::new(IconName::Reply).xsmall())
                            .child(format!("Variant {label}")),
                    )
                })
                .child(StyledText::new(text.to_string()).with_highlights(highlights)),
        )
        .into_any_element()
}

/// The `@imageN` / `@image N` tags in a message, by byte range, with N.
fn reference_tags(text: &str) -> Vec<(Range<usize>, usize)> {
    let lower = text.to_ascii_lowercase();
    let bytes = lower.as_bytes();
    let mut tags = Vec::new();
    let mut from = 0;
    while let Some(found) = lower[from..].find("@image") {
        let start = from + found;
        let mut end = start + "@image".len();
        if bytes.get(end) == Some(&b' ') {
            end += 1;
        }
        let digits = end;
        while bytes.get(end).is_some_and(u8::is_ascii_digit) {
            end += 1;
        }
        let boundary = bytes
            .get(end)
            .is_none_or(|next| !next.is_ascii_alphanumeric() && *next != b'_');
        match lower[digits..end].parse::<usize>() {
            Ok(number) if boundary => {
                tags.push((start..end, number));
                from = end;
            }
            _ => from = start + 1,
        }
    }
    tags
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_tags_like_the_web() {
        let text = "The woman from @image1 in the dress from @Image 2, not @imagex or @image3b";
        let tags = reference_tags(text);
        assert_eq!(tags.len(), 2);
        assert_eq!(&text[tags[0].0.clone()], "@image1");
        assert_eq!(tags[0].1, 1);
        assert_eq!(&text[tags[1].0.clone()], "@Image 2");
        assert_eq!(tags[1].1, 2);
    }

    #[test]
    fn keeps_byte_offsets_after_wide_characters() {
        let text = "Девушка с @image1";
        let tags = reference_tags(text);
        assert_eq!(&text[tags[0].0.clone()], "@image1");
    }
}
