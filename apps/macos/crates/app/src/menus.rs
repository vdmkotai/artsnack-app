//! The macOS menu bar, mirroring the Electron shell's menus.

use gpui_kit::{App, Menu, MenuItem, OsAction, SystemMenuType, component::input};

use crate::{
    commands::{
        About, ActualSize, BringAllToFront, CloseWindow, CopyCurrentUrl, GoBack, GoForward, GoHome,
        GoToDestination, Hide, HideOthers, Minimize, NewWindow, OpenInBrowser, OpenSettings, Quit,
        ShowAll, ToggleFullScreen, ZoomIn, ZoomOut, ZoomWindow,
    },
    destination::Destination,
    environment::Environment,
};

pub fn init(environment: &Environment, cx: &mut App) {
    cx.set_menus(build(environment));
}

/// "ArtSnack 0.1.0", greyed out, at the foot of Help.
fn version_label() -> MenuItem {
    let mut item = MenuItem::action(format!("ArtSnack {}", env!("CARGO_PKG_VERSION")), About);
    if let MenuItem::Action { disabled, .. } = &mut item {
        *disabled = true;
    }
    item
}

fn build(environment: &Environment) -> Vec<Menu> {
    let web_host = environment.web_app.host_str().unwrap_or("the web app");
    vec![
        Menu::new("ArtSnack").items([
            MenuItem::action("About ArtSnack", About),
            MenuItem::separator(),
            MenuItem::action("Settings…", OpenSettings),
            MenuItem::separator(),
            MenuItem::os_submenu("Services", SystemMenuType::Services),
            MenuItem::separator(),
            MenuItem::action("Hide ArtSnack", Hide),
            MenuItem::action("Hide Others", HideOthers),
            MenuItem::action("Show All", ShowAll),
            MenuItem::separator(),
            MenuItem::action("Quit ArtSnack", Quit),
        ]),
        Menu::new("File").items([
            MenuItem::action("New Window", NewWindow),
            MenuItem::separator(),
            MenuItem::action("Close Window", CloseWindow),
        ]),
        Menu::new("Edit").items([
            MenuItem::os_action("Undo", input::Undo, OsAction::Undo),
            MenuItem::os_action("Redo", input::Redo, OsAction::Redo),
            MenuItem::separator(),
            MenuItem::os_action("Cut", input::Cut, OsAction::Cut),
            MenuItem::os_action("Copy", input::Copy, OsAction::Copy),
            MenuItem::os_action("Paste", input::Paste, OsAction::Paste),
            MenuItem::action("Delete", input::Delete),
            MenuItem::os_action("Select All", input::SelectAll, OsAction::SelectAll),
        ]),
        Menu::new("View").items([
            MenuItem::action("Actual Size", ActualSize),
            MenuItem::action("Zoom In", ZoomIn),
            MenuItem::action("Zoom Out", ZoomOut),
            MenuItem::separator(),
            MenuItem::action("Enter Full Screen", ToggleFullScreen),
        ]),
        Menu::new("Go").items(
            [
                MenuItem::action("Back", GoBack),
                MenuItem::action("Forward", GoForward),
                MenuItem::action("Home", GoHome),
                MenuItem::separator(),
            ]
            .into_iter()
            .chain(
                Destination::ALL
                    .iter()
                    .enumerate()
                    .map(|(ix, destination)| {
                        MenuItem::action(destination.label(), GoToDestination(ix))
                    }),
            ),
        ),
        Menu::new("Window").items([
            MenuItem::action("Minimize", Minimize),
            MenuItem::action("Zoom", ZoomWindow),
            MenuItem::separator(),
            MenuItem::action("Bring All to Front", BringAllToFront),
        ]),
        Menu::new("Help").items([
            MenuItem::action(format!("Open {web_host} in Browser"), OpenInBrowser),
            MenuItem::action("Copy Current URL", CopyCurrentUrl),
            MenuItem::separator(),
            version_label(),
        ]),
    ]
}
