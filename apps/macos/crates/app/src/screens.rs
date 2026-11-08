//! Builds the view for each destination and routes commands between screens.
//! Each screen comes from its feature crate.

use artsnack_generate::{EnhanceEvent, EnhanceView, GenerateEvent, GenerateView};
use artsnack_library::{
    FavoritesView, GalleryView, HistoryEvent, HistoryView, MediaCommand, ReproduceSource,
};
use artsnack_prompts::PromptsView;
use artsnack_search::SearchView;
use artsnack_settings_screen::SettingsView;
use gpui_kit::{AnyView, App, AppContext as _, Context, Entity, Window};

use crate::{destination::Destination, shell::Shell};

/// Generate and Enhance come in already built when routing built them before
/// their tab was first opened.
pub fn build(
    destination: Destination,
    generate: Option<Entity<GenerateView>>,
    enhance: Option<Entity<EnhanceView>>,
    window: &mut Window,
    cx: &mut Context<Shell>,
) -> AnyView {
    match destination {
        Destination::Generate => generate_view(generate, window, cx).into(),
        Destination::Enhance => enhance_view(enhance, window, cx).into(),
        Destination::Favorites => {
            let view = cx.new(|cx| FavoritesView::new(window, cx));
            cx.subscribe_in(&view, window, |shell, _, command, window, cx| {
                shell.route_command(command, window, cx)
            })
            .detach();
            view.into()
        }
        Destination::Gallery => {
            let view = cx.new(|cx| GalleryView::new(window, cx));
            cx.subscribe_in(&view, window, |shell, _, command, window, cx| {
                shell.route_command(command, window, cx)
            })
            .detach();
            view.into()
        }
        Destination::History => {
            let view = cx.new(|cx| HistoryView::new(window, cx));
            cx.subscribe_in(
                &view,
                window,
                |shell, _, command: &MediaCommand, window, cx| {
                    shell.route_command(command, window, cx)
                },
            )
            .detach();
            cx.subscribe(&view, |shell, _, _: &HistoryEvent, cx| {
                shell.navigate(Destination::Generate, cx)
            })
            .detach();
            view.into()
        }
        Destination::Search => {
            let view = cx.new(|cx| SearchView::new(window, cx));
            cx.subscribe_in(&view, window, |shell, _, command, window, cx| {
                shell.route_command(command, window, cx)
            })
            .detach();
            view.into()
        }
        Destination::Settings => cx.new(|cx| SettingsView::new(window, cx)).into(),
        Destination::Prompts => cx.new(|cx| PromptsView::new(window, cx)).into(),
    }
}

/// Tells a kept screen whether it is on screen; the shell calls this on every
/// switch, and a screen starts on screen when it is built. Hidden, a screen
/// keeps its state and stops the live work it can resume — subscriptions,
/// observers, polling, clip playback.
///
/// Prompts and Settings take no such call yet; they hold a few small live
/// queries.
pub(crate) fn set_active(destination: Destination, screen: &AnyView, active: bool, cx: &mut App) {
    match destination {
        Destination::Generate => {
            if let Ok(view) = screen.clone().downcast::<GenerateView>() {
                view.update(cx, |view, cx| view.set_active(active, cx));
            }
        }
        Destination::Enhance => {
            if let Ok(view) = screen.clone().downcast::<EnhanceView>() {
                view.update(cx, |view, cx| view.set_active(active, cx));
            }
        }
        Destination::Gallery => {
            if let Ok(view) = screen.clone().downcast::<GalleryView>() {
                view.update(cx, |view, cx| view.set_active(active, cx));
            }
        }
        Destination::History => {
            if let Ok(view) = screen.clone().downcast::<HistoryView>() {
                view.update(cx, |view, cx| view.set_active(active, cx));
            }
        }
        Destination::Favorites => {
            if let Ok(view) = screen.clone().downcast::<FavoritesView>() {
                view.update(cx, |view, cx| view.set_active(active, cx));
            }
        }
        Destination::Search => {
            if let Ok(view) = screen.clone().downcast::<SearchView>() {
                view.update(cx, |view, cx| view.set_active(active, cx));
            }
        }
        Destination::Prompts | Destination::Settings => {}
    }
}

/// The Generate screen, built once per window and shared with the routing
/// below, which hands it reproduced forms.
fn generate_view(
    existing: Option<Entity<GenerateView>>,
    window: &mut Window,
    cx: &mut Context<Shell>,
) -> Entity<GenerateView> {
    if let Some(view) = existing {
        return view;
    }
    let view = cx.new(|cx| GenerateView::new(window, cx));
    cx.subscribe_in(&view, window, |shell, _, event, window, cx| match event {
        GenerateEvent::OpenBackendManager => artsnack_pods::open_backend_manager(window, cx),
        GenerateEvent::Media(command) => shell.route_command(command, window, cx),
    })
    .detach();
    view
}

/// The Enhance screen, built once per window; "Send to Enhance" hands it images.
fn enhance_view(
    existing: Option<Entity<EnhanceView>>,
    window: &mut Window,
    cx: &mut Context<Shell>,
) -> Entity<EnhanceView> {
    if let Some(view) = existing {
        return view;
    }
    let view = cx.new(|cx| EnhanceView::new(window, cx));
    cx.subscribe_in(&view, window, |shell, _, event, window, cx| match event {
        EnhanceEvent::OpenBackendManager => artsnack_pods::open_backend_manager(window, cx),
        EnhanceEvent::UseAsReference { image_url } => shell.route_command(
            &MediaCommand::UseAsReference {
                image_url: image_url.clone(),
            },
            window,
            cx,
        ),
    })
    .detach();
    view
}

impl Shell {
    /// Shows the Enhance screen, building it first if needed, and returns it.
    fn open_enhance(&mut self, window: &mut Window, cx: &mut Context<Self>) -> Entity<EnhanceView> {
        let view = enhance_view(self.enhance.clone(), window, cx);
        self.enhance = Some(view.clone());
        self.show_screen(Destination::Enhance, view.clone().into(), cx);
        view
    }

    /// Routes a command from a library screen to the screen that handles it.
    pub fn route_command(
        &mut self,
        command: &MediaCommand,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let saved = match command {
            MediaCommand::Reproduce(ReproduceSource::SelfHosted { form_state }) => {
                Some(form_state.clone())
            }
            MediaCommand::Reproduce(ReproduceSource::Api { generation_id }) => {
                let view = generate_view(self.generate.clone(), window, cx);
                self.generate = Some(view.clone());
                self.show_screen(Destination::Generate, view.clone().into(), cx);
                let id = generation_id.clone();
                view.update(cx, |view, cx| view.reproduce_api(id, window, cx));
                None
            }
            MediaCommand::UseAsReference { image_url } => {
                let view = generate_view(self.generate.clone(), window, cx);
                self.generate = Some(view.clone());
                self.show_screen(Destination::Generate, view.clone().into(), cx);
                let url = image_url.clone();
                view.update(cx, |view, cx| view.attach_api_reference(url, window, cx));
                None
            }
            MediaCommand::Reproduce(ReproduceSource::Enhancement { enhancement_id }) => {
                let view = self.open_enhance(window, cx);
                let id = enhancement_id.clone();
                view.update(cx, |view, cx| view.reproduce_by_id(id, window, cx));
                None
            }
            MediaCommand::Enhance {
                image_url,
                form_state,
            } => {
                let view = self.open_enhance(window, cx);
                view.update(cx, |view, cx| {
                    view.set_source_url(image_url.clone(), form_state.as_ref(), window, cx)
                });
                None
            }
        };
        if let Some(saved) = saved {
            let view = generate_view(self.generate.clone(), window, cx);
            self.generate = Some(view.clone());
            self.show_screen(Destination::Generate, view.clone().into(), cx);
            view.update(cx, |view, cx| {
                view.reproduce_self_hosted(&saved, window, cx)
            });
        }
    }
}
