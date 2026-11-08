//! The "Search syntax" dialog: what the query language means, by example.

use gpui_kit::{
    App, FontWeight, IntoElement, ParentElement as _, Styled as _,
    component::{ActiveTheme as _, h_flex, v_flex},
    div,
    prelude::FluentBuilder as _,
    rems,
};

const EXAMPLES: [(&str, &str); 6] = [
    ("dog, beach, scarf", "All three broad terms"),
    ("dog|fox, beach", "dog or fox, plus beach"),
    (
        "dog, beach, -scarf",
        "Excludes scarf, silkscarf and the like",
    ),
    ("\"dog\"", "Exact word; does not match 2dogs"),
    ("\"red dress\"", "Exact phrase, after normalising"),
    ("-\"scarf\"", "Excludes only the exact word"),
];

const NOTES: [(&str, &str); 3] = [
    (
        "Ranking",
        "Exact phrase, then exact word, then broad match, then a one-letter typo. Newer only breaks ties.",
    ),
    (
        "Filters",
        "Provider, model, checkpoint and LoRA values come from your own history, so retired ones stay findable.",
    ),
    (
        "Invalid syntax",
        "An unclosed quote or a dangling | shows an error and keeps the previous results.",
    ),
];

pub fn content(cx: &App) -> impl IntoElement {
    let theme = cx.theme();
    v_flex()
        .gap_4()
        .child(
            div()
                .text_sm()
                .text_color(theme.muted_foreground)
                .child(
                    "Search looks at positive prompts. Commas and spaces both mean AND; punctuation and underscores in prompts are ignored.",
                ),
        )
        .child(
            v_flex()
                .rounded(theme.radius)
                .border_1()
                .border_color(theme.border)
                .children(EXAMPLES.iter().enumerate().map(|(ix, (query, meaning))| {
                    h_flex()
                        .gap_3()
                        .px_3()
                        .py_2()
                        // Each row owns the hairline above it.
                        .when(ix > 0, |row| row.border_t_1().border_color(theme.border))
                        .child(
                            div()
                                .w(rems(10.))
                                .flex_shrink_0()
                                .font_family(theme.mono_font_family.clone())
                                .text_sm()
                                .text_color(theme.primary)
                                .child(*query),
                        )
                        .child(
                            div()
                                .flex_1()
                                .text_sm()
                                .text_color(theme.muted_foreground)
                                .child(*meaning),
                        )
                })),
        )
        .child(v_flex().gap_2().children(NOTES.iter().map(|(title, body)| {
            v_flex()
                .gap_0p5()
                .child(
                    div()
                        .text_sm()
                        .font_weight(FontWeight::MEDIUM)
                        .child(*title),
                )
                .child(
                    div()
                        .text_sm()
                        .text_color(theme.muted_foreground)
                        .child(*body),
                )
        })))
}
