//! The results column. The self-hosted grid arrives with the generations
//! query; until then the column says so.

use gpui_kit::{
    AnyElement, App, IntoElement, ParentElement as _, Styled as _,
    component::{ActiveTheme as _, v_flex},
};

pub fn placeholder(cx: &App) -> AnyElement {
    v_flex()
        .size_full()
        .items_center()
        .justify_center()
        .gap_1()
        .text_color(cx.theme().muted_foreground)
        .child("No results yet")
        .child("Generated images will appear here")
        .into_any_element()
}
