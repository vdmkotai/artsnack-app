use artsnack_settings::{Preference, Preferences};
use gpui_kit::{
    App, AppContext as _, Bounds, DisplayId, Pixels, TitlebarOptions, Window, WindowBounds,
    WindowOptions, component::TitleBar, point, px, size,
};
use serde::{Deserialize, Serialize};

use crate::shell::{Shell, TITLE_BAR_HEIGHT};

/// Where the window was and whether it was full screen, kept between launches
/// (the Electron shell's `window-state.json`).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SavedWindow {
    /// The position is relative to the display the window was on.
    x: f32,
    y: f32,
    width: f32,
    height: f32,
    full_screen: bool,
    /// That display's UUID, which survives restarts and reconnection (a
    /// `DisplayId` does not). Absent in places saved before it was kept.
    #[serde(default)]
    display: Option<String>,
}

/// Quiet: it changes on every frame of a drag, and no form renders from it.
const SAVED_WINDOW: Preference<Option<SavedWindow>> =
    Preference::new("window.state", || None).quiet();
/// Each further window opens this far down and right of the last one.
const CASCADE: f32 = 24.;

/// Opens a main window: the title bar with the tabs, and the current screen.
pub fn open_main_window(cx: &mut App) {
    let others = cx.windows().len();
    let (window_bounds, display_id) =
        restored_bounds(others, cx).unwrap_or_else(|| (default_bounds(cx), None));

    // The traffic lights are 12 pt circles in a 14 pt frame; centre them on our
    // taller title bar.
    let traffic_light_y = (TITLE_BAR_HEIGHT - px(14.)) / 2.;
    let options = WindowOptions {
        window_bounds: Some(window_bounds),
        display_id,
        window_min_size: Some(size(px(880.), px(560.))),
        titlebar: Some(TitlebarOptions {
            title: Some("ArtSnack".into()),
            appears_transparent: true,
            traffic_light_position: Some(point(px(16.), traffic_light_y)),
        }),
        ..TitleBar::window_options()
    };

    let opened = gpui_kit::open_window(options, cx, |window, cx| {
        let shell = cx.new(|cx| Shell::new(window, cx));
        let focus = shell.read(cx).focus_handle().clone();
        window.defer(cx, move |window, cx| {
            if window.focused(cx).is_none() {
                focus.focus(window, cx);
            }
        });
        shell
    });
    if let Err(error) = opened {
        tracing::error!(?error, "could not open the main window");
    }
}

/// `min(1440, 90 %)` × `min(960, 90 %)` of the main display, centred.
fn default_bounds(cx: &App) -> WindowBounds {
    let mut window_size = size(px(1440.), px(960.));
    if let Some(display) = cx.primary_display() {
        let display_size = display.bounds().size;
        window_size.width = window_size.width.min(display_size.width * 0.9);
        window_size.height = window_size.height.min(display_size.height * 0.9);
    }
    WindowBounds::Windowed(Bounds::centered(None, window_size, cx))
}

/// The saved place, on the display it was on, and that display. A place that
/// no longer fits (a smaller display, a changed resolution) is moved and
/// shrunk into the display's visible area; when the display is gone, the
/// window opens centred on the main display, no larger than it.
fn restored_bounds(others: usize, cx: &App) -> Option<(WindowBounds, Option<DisplayId>)> {
    let saved = Preferences::get(cx, &SAVED_WINDOW)?;
    let offset = CASCADE * others as f32;
    let saved_size = size(px(saved.width), px(saved.height));
    let on_display = match saved.display.as_deref() {
        Some(uuid) => cx.displays().into_iter().find(|display| {
            display
                .uuid()
                .is_ok_and(|display_uuid| display_uuid.to_string() == uuid)
        }),
        // Saved before displays were recorded: it was placed on the main one.
        None => cx.primary_display(),
    };
    let (bounds, display_id) = match on_display {
        Some(display) => {
            let origin = point(px(saved.x + offset), px(saved.y + offset));
            let bounds = fit(Bounds::new(origin, saved_size), display.visible_bounds());
            (bounds, Some(display.id()))
        }
        None => {
            let area = cx.primary_display()?.visible_bounds();
            let bounds = fit(
                Bounds::centered(None, saved_size, cx),
                inset(area, MISSING_DISPLAY_FILL),
            );
            (bounds, None)
        }
    };
    // A second window never opens full screen over the first, nor does one
    // whose display is gone.
    Some(
        if saved.full_screen && others == 0 && display_id.is_some() {
            (WindowBounds::Fullscreen(bounds), display_id)
        } else {
            (WindowBounds::Windowed(bounds), display_id)
        },
    )
}

/// How much of the main display a window from a vanished display may take.
const MISSING_DISPLAY_FILL: f32 = 0.9;

/// `bounds` moved, and shrunk where it must be, to lie within `area`.
fn fit(bounds: Bounds<Pixels>, area: Bounds<Pixels>) -> Bounds<Pixels> {
    let width = bounds.size.width.as_f32().min(area.size.width.as_f32());
    let height = bounds.size.height.as_f32().min(area.size.height.as_f32());
    let x = bounds
        .origin
        .x
        .as_f32()
        .min(area.right().as_f32() - width)
        .max(area.left().as_f32());
    let y = bounds
        .origin
        .y
        .as_f32()
        .min(area.bottom().as_f32() - height)
        .max(area.top().as_f32());
    Bounds::new(point(px(x), px(y)), size(px(width), px(height)))
}

/// `area` scaled by `fraction` about its centre.
fn inset(area: Bounds<Pixels>, fraction: f32) -> Bounds<Pixels> {
    let width = area.size.width.as_f32() * fraction;
    let height = area.size.height.as_f32() * fraction;
    let x = area.origin.x.as_f32() + (area.size.width.as_f32() - width) / 2.;
    let y = area.origin.y.as_f32() + (area.size.height.as_f32() - height) / 2.;
    Bounds::new(point(px(x), px(y)), size(px(width), px(height)))
}

/// Called whenever the window moves, resizes or changes full screen.
pub fn save_bounds(window: &Window, cx: &mut App) {
    let (bounds, full_screen): (Bounds<Pixels>, bool) = match window.window_bounds() {
        WindowBounds::Windowed(bounds) | WindowBounds::Maximized(bounds) => (bounds, false),
        WindowBounds::Fullscreen(bounds) => (bounds, true),
    };
    let display = window
        .display(cx)
        .and_then(|display| display.uuid().ok())
        .map(|uuid| uuid.to_string());
    let saved = SavedWindow {
        x: bounds.origin.x.as_f32(),
        y: bounds.origin.y.as_f32(),
        width: bounds.size.width.as_f32(),
        height: bounds.size.height.as_f32(),
        full_screen,
        display,
    };
    if saved.width > 0. && saved.height > 0. {
        Preferences::set(cx, &SAVED_WINDOW, Some(saved));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rect(x: f32, y: f32, width: f32, height: f32) -> Bounds<Pixels> {
        Bounds::new(point(px(x), px(y)), size(px(width), px(height)))
    }

    #[test]
    fn a_place_that_fits_is_kept() {
        let area = rect(0., 25., 1440., 875.);
        assert_eq!(
            fit(rect(100., 100., 800., 600.), area),
            rect(100., 100., 800., 600.)
        );
    }

    #[test]
    fn a_place_off_the_edge_moves_in_and_shrinks() {
        let area = rect(0., 25., 1440., 875.);
        assert_eq!(
            fit(rect(1200., 700., 800., 600.), area),
            rect(640., 300., 800., 600.)
        );
        assert_eq!(
            fit(rect(-50., 0., 2000., 1200.), area),
            rect(0., 25., 1440., 875.)
        );
    }

    #[test]
    fn the_inset_area_is_centred() {
        assert_eq!(
            inset(rect(0., 0., 1000., 500.), 0.9),
            rect(50., 25., 900., 450.)
        );
    }
}
