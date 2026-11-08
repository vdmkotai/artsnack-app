//! The ArtSnack palette, translated from the web app's dark theme
//! (`apps/web/app/globals.css`, oklch values converted to sRGB hex).

use gpui_kit::{
    App,
    component::{Theme, ThemeMode, ThemeRegistry},
};

const THEME_SET: &str = include_str!("../themes/artsnack.json");
const THEME_NAME: &str = "ArtSnack Dark";

/// Registers the ArtSnack theme and makes it the dark theme. The app is dark
/// only, like the web app.
pub fn init(cx: &mut App) {
    if let Err(error) = ThemeRegistry::global_mut(cx).load_themes_from_str(THEME_SET) {
        tracing::error!(
            ?error,
            "the bundled theme does not parse; using the default"
        );
        Theme::change(ThemeMode::Dark, None, cx);
        return;
    }
    let config = ThemeRegistry::global(cx).themes().get(THEME_NAME).cloned();
    match config {
        Some(config) => Theme::update(cx, |theme| {
            theme.mode = ThemeMode::Dark;
            theme.apply_config(&config);
        }),
        None => Theme::change(ThemeMode::Dark, None, cx),
    }
}
