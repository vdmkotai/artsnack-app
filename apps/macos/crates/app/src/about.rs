//! ArtSnack › About ArtSnack: the name, version and website (the Electron
//! shell's About panel). The website is the configured web app.

use gpui_kit::{
    App, IntoElement, ParentElement as _, Styled as _, Window,
    assets::IconName,
    component::{
        ActiveTheme as _, Sizable as _, WindowExt as _,
        button::{Button, ButtonVariants as _},
        v_flex,
    },
    div, px,
};

pub fn open(window: &mut Window, cx: &mut App) {
    let website = cx
        .global::<crate::environment::Environment>()
        .web_app
        .clone();
    let label = website.host_str().unwrap_or(website.as_str()).to_string();
    window.open_dialog(cx, move |dialog, _, cx| {
        let muted = cx.theme().muted_foreground;
        dialog.w(px(360.)).child(
            v_flex()
                .items_center()
                .gap_2()
                .py_4()
                .child(
                    div()
                        .text_2xl()
                        .font_weight(gpui_kit::FontWeight::SEMIBOLD)
                        .child("ArtSnack"),
                )
                .child(
                    div()
                        .text_sm()
                        .text_color(muted)
                        .child(format!("Version {}", env!("CARGO_PKG_VERSION"))),
                )
                .child(
                    div()
                        .text_xs()
                        .text_color(muted)
                        .child("The native macOS client, built with Rust and GPUI."),
                )
                .child(
                    Button::new("about-website")
                        .ghost()
                        .small()
                        .icon(IconName::ExternalLink)
                        .label(label.clone())
                        .on_click({
                            let website = website.clone();
                            move |_, _, cx| cx.open_url(website.as_str())
                        }),
                )
                .into_any_element(),
        )
    });
}
