//! ArtSnack for macOS.
//!
//! The shell owns windows, menus, key bindings and navigation; every screen
//! lives in a feature crate. Data comes straight from Convex and media straight
//! from the CDN — there is no web view and no Next.js in between.

mod about;
mod account;
mod commands;
mod destination;
mod environment;
mod menus;
mod screens;
mod setup;
mod shell;
mod theme;
mod window;
mod window_zoom;

use futures::channel::mpsc;
use gpui_kit::App;

/// The bundle identity macOS notifications and the Keychain attribute items
/// to; script/install.sh writes the same one into Info.plist. A placeholder
/// unless the build sets `ARTSNACK_BUNDLE_ID`.
const BUNDLE_ID: &str = match option_env!("ARTSNACK_BUNDLE_ID") {
    Some(id) => id,
    None => "com.example.artsnack",
};

fn main() {
    init_logging();
    // Read while the platform starts up rather than on the main thread after.
    let preferences = artsnack_settings::load_in_background();
    let environment = environment::Environment::load();

    let app = gpui_kit::application().with_assets(gpui_kit::assets::AllAssets);

    // Not configured: say what is missing, and start nothing that would call
    // a backend.
    let environment = match environment {
        Ok(environment) => environment,
        Err(problem) => {
            tracing::error!("{problem}");
            app.run(move |cx: &mut App| setup::run(problem, cx));
            return;
        }
    };
    tracing::info!(environment = environment.name, "starting");

    // macOS delivers opened URLs (the sign-in link) through the application,
    // possibly before `run` has started; queue them until the session exists.
    let (open_urls, opened_urls) = mpsc::unbounded();
    app.on_open_urls(move |urls| {
        let _ = open_urls.unbounded_send(urls);
    });
    app.on_reopen(|cx| {
        if cx.windows().is_empty() {
            window::open_main_window(cx);
        }
    });

    app.run(move |cx: &mut App| {
        gpui_kit::init(cx);
        artsnack_runtime::init(cx);
        artsnack_settings::init_loaded(preferences, cx);
        theme::init(cx);
        window_zoom::init(cx);

        artsnack_rules::init(cx);
        artsnack_media::init(&environment.media_origin, cx);
        artsnack_ui::init(cx);
        artsnack_generate::init(cx);
        artsnack_library::init(cx);
        artsnack_search::init(cx);
        // After `artsnack_generate`: its Cmd+Enter in the Enhance popover's
        // instruction box must win over the composers' Cmd+Enter-in-a-field.
        artsnack_prompts::init(cx);
        commands::init(cx);
        menus::init(&environment, cx);
        account::init(&environment, opened_urls, cx);
        cx.set_global(environment);

        cx.set_app_identity(BUNDLE_ID, "ArtSnack Native");
        cx.activate(true);
        window::open_main_window(cx);
    });
}

fn init_logging() {
    use tracing_subscriber::{EnvFilter, prelude::*};

    let filter = EnvFilter::try_from_env("ARTSNACK_LOG")
        .unwrap_or_else(|_| EnvFilter::new("warn,artsnack=info"));
    tracing_subscriber::registry()
        .with(filter)
        .with(never_log_credentials())
        .with(tracing_subscriber::fmt::layer())
        .init();
}

/// Caps the targets that would record credentials, whatever `ARTSNACK_LOG`
/// asks for: convex-rs logs every message it sends over the socket at debug
/// (`Sending {message:?}`), and the Authenticate message carries the user's
/// JWT in a derived `Debug`; tungstenite logs each frame's payload at trace.
fn never_log_credentials() -> tracing_subscriber::filter::Targets {
    use tracing_subscriber::filter::{LevelFilter, Targets};

    Targets::new()
        .with_default(LevelFilter::TRACE)
        .with_target("convex::sync::web_socket_manager", LevelFilter::INFO)
        .with_target("tungstenite", LevelFilter::DEBUG)
}

#[cfg(test)]
mod tests {
    use tracing::Level;

    #[test]
    fn socket_traffic_is_never_logged() {
        let filter = super::never_log_credentials();
        assert!(!filter.would_enable("convex::sync::web_socket_manager", &Level::DEBUG));
        assert!(filter.would_enable("convex::sync::web_socket_manager", &Level::INFO));
        assert!(!filter.would_enable("tungstenite::protocol", &Level::TRACE));
        assert!(filter.would_enable("convex::base_client", &Level::DEBUG));
        assert!(filter.would_enable("artsnack_backend", &Level::TRACE));
    }
}
