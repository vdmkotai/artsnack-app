//! Cmd +/−/0: zoom of the whole window.
//!
//! The Electron shell used Chromium's page zoom. Here the theme's base font is
//! the rem every size resolves against, so zooming is one theme edit; every
//! window re-renders at the new scale. One factor for the whole app, persisted,
//! as before.

use artsnack_settings::{Preference, Preferences};
use artsnack_ui::ZoomScale;
use gpui_kit::{
    Anchor, App,
    component::{Theme, WindowExt as _, notification::Notification},
    px,
};

use crate::commands::{ActualSize, ZoomIn, ZoomOut};

/// The base font at 100 %: the browser default the web app's rems resolve to.
const BASE_FONT_SIZE: f32 = 16.0;

pub const WINDOW_ZOOM: Preference<f32> = Preference::new("window.zoom", || 1.0);

pub fn init(cx: &mut App) {
    apply(current(cx), cx);

    cx.on_action(|_: &ZoomIn, cx| set(ZoomScale::WINDOW.zoom_in(current(cx)), cx));
    cx.on_action(|_: &ZoomOut, cx| set(ZoomScale::WINDOW.zoom_out(current(cx)), cx));
    cx.on_action(|_: &ActualSize, cx| set(1.0, cx));
}

/// The current window zoom factor.
pub fn current(cx: &App) -> f32 {
    ZoomScale::WINDOW.clamp(Preferences::get(cx, &WINDOW_ZOOM))
}

fn set(factor: f32, cx: &mut App) {
    let factor = ZoomScale::WINDOW.clamp(factor);
    Preferences::set(cx, &WINDOW_ZOOM, factor);
    apply(factor, cx);
    announce(factor, cx);
}

/// Marks the zoom notice, so a new one replaces the last.
struct ZoomNotice;

/// "Zoom 110%" at the bottom of the window, as the Electron shell showed it.
fn announce(factor: f32, cx: &mut App) {
    let Some(window) = cx.active_window() else {
        return;
    };
    let text = format!("Zoom {}%", (factor * 100.).round() as i32);
    let _ = window.update(cx, |_, window, cx| {
        window.push_notification(
            Notification::info(text)
                .id::<ZoomNotice>()
                .placement(Anchor::BottomCenter),
            cx,
        )
    });
}

fn apply(factor: f32, cx: &mut App) {
    // `Theme::update` refreshes every window.
    Theme::update(cx, |theme| theme.font_size = px(BASE_FONT_SIZE * factor));
}
