//! App-level commands and their key bindings.
//!
//! Each command is one Action so the menu bar, key bindings and buttons all
//! dispatch the same thing. Bindings are registered before the menus are built:
//! `set_menus` reads the keymap when it runs.

use gpui_kit::{App, KeyBinding, actions};

use crate::window;

actions!(
    artsnack,
    [
        About,
        Quit,
        Hide,
        HideOthers,
        ShowAll,
        NewWindow,
        CloseWindow,
        Minimize,
        ZoomWindow,
        ToggleFullScreen,
        ZoomIn,
        ZoomOut,
        ActualSize,
        GoBack,
        GoForward,
        GoHome,
        OpenSettings,
        OpenInBrowser,
        SignOut,
        CopyCurrentUrl,
        BringAllToFront,
    ]
);

/// Opens destination `n` (Cmd-1 … Cmd-9), in tab-bar order.
#[derive(Clone, PartialEq, Eq, Debug, serde::Deserialize, gpui_kit::Action)]
#[action(namespace = artsnack, no_json)]
pub struct GoToDestination(pub usize);

pub fn init(cx: &mut App) {
    cx.bind_keys([
        KeyBinding::new("cmd-q", Quit, None),
        KeyBinding::new("cmd-h", Hide, None),
        KeyBinding::new("alt-cmd-h", HideOthers, None),
        KeyBinding::new("cmd-n", NewWindow, None),
        KeyBinding::new("cmd-w", CloseWindow, None),
        KeyBinding::new("cmd-m", Minimize, None),
        KeyBinding::new("ctrl-cmd-f", ToggleFullScreen, None),
        KeyBinding::new("cmd-=", ZoomIn, None),
        KeyBinding::new("cmd-+", ZoomIn, None),
        KeyBinding::new("cmd--", ZoomOut, None),
        KeyBinding::new("cmd-0", ActualSize, None),
        KeyBinding::new("cmd-[", GoBack, None),
        KeyBinding::new("cmd-]", GoForward, None),
        KeyBinding::new("shift-cmd-h", GoHome, None),
        KeyBinding::new("cmd-,", OpenSettings, None),
        KeyBinding::new("shift-cmd-c", CopyCurrentUrl, None),
    ]);
    cx.bind_keys(
        (1..=9).map(|n| KeyBinding::new(&format!("cmd-{n}"), GoToDestination(n - 1), None)),
    );

    cx.on_action(|_: &Quit, cx| cx.quit());
    cx.on_action(|_: &Hide, cx| cx.hide());
    cx.on_action(|_: &HideOthers, cx| cx.hide_other_apps());
    cx.on_action(|_: &ShowAll, cx| cx.unhide_other_apps());
    cx.on_action(|_: &NewWindow, cx| window::open_main_window(cx));
    cx.on_action(|_: &BringAllToFront, cx| {
        for window in cx.windows() {
            let _ = window.update(cx, |_, window, _| window.activate_window());
        }
    });
    cx.on_action(|_: &SignOut, cx| {
        artsnack_session::Session::global(cx).update(cx, |session, cx| session.sign_out(cx));
    });
}
