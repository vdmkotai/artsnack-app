//! The window's content: the title bar with the tabs, and the current screen.
//!
//! Screens are created on first visit and kept for the life of the window, so
//! returning to a tab is instant and keeps its scroll position, form state and
//! subscriptions — the native version of the web app's "tabs stay mounted".
//! A kept screen is told when it leaves the window and when it comes back
//! ([`crate::screens::set_active`]), so a hidden one can stop its live work.
//! Screens belong to the signed-in user: signing out or in as someone else
//! drops all of them.

use std::collections::HashMap;

use artsnack_session::{Session, SessionStatus, SignInView};
use artsnack_settings::{Preference, Preferences};
use artsnack_ui::pane_zoom;
use gpui_kit::{
    AnyElement, AnyView, App, AppContext as _, Context, Entity, FocusHandle, Focusable, FontWeight,
    InteractiveElement as _, IntoElement, ParentElement as _, Pixels, Render, SharedString,
    Styled as _, Subscription, Window,
    assets::IconName,
    component::{
        ActiveTheme as _, Selectable as _, Sizable as _, TitleBar,
        button::{Button, ButtonVariants as _},
        h_flex,
        menu::DropdownMenu as _,
        v_flex,
    },
    div,
    prelude::FluentBuilder as _,
    px,
};

use crate::{
    commands::{
        CloseWindow, GoBack, GoForward, GoHome, GoToDestination, Minimize, OpenInBrowser,
        OpenSettings, SignOut, ToggleFullScreen, ZoomWindow,
    },
    destination::Destination,
    environment::Environment,
    window_zoom,
};

/// Taller than GPUI Kit's default 34 px so the tabs fit, the height of the web
/// app's header minus its padding. A physical size: the title bar is window
/// chrome, and the traffic lights it is centred on do not zoom.
pub const TITLE_BAR_HEIGHT: Pixels = px(44.);

/// Quiet: switching tabs must not wake every form observing preferences.
const LAST_DESTINATION: Preference<Destination> =
    Preference::new("shell.destination", || Destination::Generate).quiet();

pub struct Shell {
    focus_handle: FocusHandle,
    session: Entity<Session>,
    sign_in: Entity<SignInView>,
    destination: Destination,
    /// Visited destinations for Back/Forward; `cursor` is the current one.
    history: Vec<Destination>,
    cursor: usize,
    /// Screens built so far. Dropped on sign-out and when another user signs
    /// in, which also ends their subscriptions, so nothing of one account
    /// outlives it on screen.
    screens: HashMap<Destination, AnyView>,
    /// The user the screens were built for.
    user_id: Option<String>,
    /// Whether the window is presented; hidden (minimised, fully covered),
    /// the open screen is told it is off screen too.
    window_visible: bool,
    /// The Generate screen's typed handle, for handing it reproduced forms.
    pub(crate) generate: Option<Entity<artsnack_generate::GenerateView>>,
    /// The Enhance screen's, for "Send to Enhance".
    pub(crate) enhance: Option<Entity<artsnack_generate::EnhanceView>>,
    _observe_session: Subscription,
    _observe_bounds: Subscription,
    _observe_visibility: Subscription,
}

impl Shell {
    pub fn new(window: &mut Window, cx: &mut Context<Self>) -> Self {
        let destination = Preferences::get(cx, &LAST_DESTINATION);
        let session = Session::global(cx);
        let user_id = session
            .read(cx)
            .account()
            .map(|account| account.user_id().to_string());
        let sign_in = cx.new(|cx| SignInView::new(session.clone(), cx));
        let observe_session = cx.observe(&session, |this, session, cx| {
            let user_id = session
                .read(cx)
                .account()
                .map(|account| account.user_id().to_string());
            if user_id != this.user_id {
                // Signed out, or a different user: nothing built for the
                // previous one survives.
                this.screens.clear();
                this.generate = None;
                this.enhance = None;
                this.user_id = user_id;
            }
            cx.notify();
        });
        Self {
            focus_handle: cx.focus_handle(),
            session,
            sign_in,
            destination,
            history: vec![destination],
            cursor: 0,
            screens: HashMap::new(),
            user_id,
            generate: None,
            enhance: None,
            _observe_session: observe_session,
            _observe_bounds: cx.observe_window_bounds(window, |_, window, cx| {
                crate::window::save_bounds(window, cx)
            }),
            // Clips, polls and live feeds of the open screen stop while no
            // part of the window is shown.
            _observe_visibility: cx.observe_window_visibility(window, |this, visibility, _, cx| {
                let visible = visibility.is_visible();
                if visible != this.window_visible {
                    this.window_visible = visible;
                    this.set_screen_active(this.destination, visible, cx);
                }
            }),
            window_visible: true,
        }
    }

    pub fn focus_handle(&self) -> &FocusHandle {
        &self.focus_handle
    }

    pub(crate) fn navigate(&mut self, destination: Destination, cx: &mut Context<Self>) {
        if destination == self.destination {
            return;
        }
        self.history.truncate(self.cursor + 1);
        self.history.push(destination);
        self.cursor = self.history.len() - 1;
        self.show(destination, cx);
    }

    fn go_back(&mut self, _: &GoBack, _: &mut Window, cx: &mut Context<Self>) {
        if self.cursor > 0 {
            self.cursor -= 1;
            self.show(self.history[self.cursor], cx);
        }
    }

    fn go_forward(&mut self, _: &GoForward, _: &mut Window, cx: &mut Context<Self>) {
        if self.cursor + 1 < self.history.len() {
            self.cursor += 1;
            self.show(self.history[self.cursor], cx);
        }
    }

    fn show(&mut self, destination: Destination, cx: &mut Context<Self>) {
        let previous = std::mem::replace(&mut self.destination, destination);
        Preferences::set(cx, &LAST_DESTINATION, destination);
        if previous != destination {
            // A screen not built yet starts on screen when it is.
            self.set_screen_active(previous, false, cx);
            self.set_screen_active(destination, self.window_visible, cx);
        }
        cx.notify();
    }

    /// Tells the screen for `destination`, if it was built, whether it is on
    /// screen.
    fn set_screen_active(&self, destination: Destination, active: bool, cx: &mut Context<Self>) {
        if let Some(screen) = self.screens.get(&destination) {
            crate::screens::set_active(destination, screen, active, cx);
        }
    }

    fn screen(&mut self, window: &mut Window, cx: &mut Context<Self>) -> AnyView {
        let destination = self.destination;
        if let Some(screen) = self.screens.get(&destination) {
            return screen.clone();
        }
        let screen = crate::screens::build(
            destination,
            self.generate.clone(),
            self.enhance.clone(),
            window,
            cx,
        );
        match destination {
            Destination::Generate => {
                self.generate = screen
                    .clone()
                    .downcast::<artsnack_generate::GenerateView>()
                    .ok();
            }
            Destination::Enhance => {
                self.enhance = screen
                    .clone()
                    .downcast::<artsnack_generate::EnhanceView>()
                    .ok();
            }
            _ => {}
        }
        self.screens.insert(destination, screen.clone());
        screen
    }

    /// Shows the Prompts screen on `tab` (the composers' "Manage all prompts"
    /// and "Edit recipes").
    fn open_prompts(
        &mut self,
        tab: artsnack_prompts::PromptsTab,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let screen = match self.screens.get(&Destination::Prompts) {
            Some(screen) => screen.clone(),
            None => crate::screens::build(Destination::Prompts, None, None, window, cx),
        };
        if let Ok(prompts) = screen.clone().downcast::<artsnack_prompts::PromptsView>() {
            prompts.update(cx, |prompts, cx| prompts.show(tab, window, cx));
        }
        self.show_screen(Destination::Prompts, screen, cx);
    }

    /// Shows `destination` with an already-built screen (routing from another
    /// screen builds the target first).
    pub(crate) fn show_screen(
        &mut self,
        destination: Destination,
        screen: AnyView,
        cx: &mut Context<Self>,
    ) {
        self.screens.entry(destination).or_insert(screen);
        self.navigate(destination, cx);
    }

    fn render_title_bar(&self, signed_in: bool, cx: &mut Context<Self>) -> impl IntoElement {
        let tabs = Destination::TABS
            .iter()
            .filter(|_| signed_in)
            .map(|destination| {
                let destination = *destination;
                Button::new(format!("tab-{}", destination.id()))
                    .ghost()
                    .small()
                    .icon(destination.icon())
                    .label(destination.label())
                    .selected(destination == self.destination)
                    .on_click(cx.listener(move |this, _, _, cx| this.navigate(destination, cx)))
            });
        let utility = |destination: Destination, cx: &mut Context<Self>| {
            Button::new(format!("utility-{}", destination.id()))
                .ghost()
                .small()
                .icon(destination.icon())
                .tooltip(destination.label())
                .selected(destination == self.destination)
                .on_click(cx.listener(move |this, _, _, cx| this.navigate(destination, cx)))
        };

        // The title bar is chrome: undo the window zoom so it keeps its size,
        // like a native toolbar, while everything below it scales.
        let unzoom = 1.0 / window_zoom::current(cx);
        let wordmark: SharedString = "ArtSnack".into();

        TitleBar::new().h(TITLE_BAR_HEIGHT).child(pane_zoom(
            unzoom,
            h_flex()
                .w_full()
                .h_full()
                .pr_3()
                .justify_between()
                .child(
                    h_flex()
                        .gap_1()
                        .child(
                            div()
                                .pr_3()
                                .text_sm()
                                .font_weight(FontWeight::MEDIUM)
                                .text_color(cx.theme().muted_foreground)
                                .child(wordmark),
                        )
                        .children(tabs),
                )
                .when(signed_in, |this| {
                    this.child(
                        h_flex()
                            .gap_1()
                            .child(utility(Destination::Search, cx))
                            .child(utility(Destination::Settings, cx))
                            .child(self.render_account_menu(cx)),
                    )
                }),
        ))
    }

    fn render_account_menu(&self, cx: &mut Context<Self>) -> AnyElement {
        let account = self.session.read(cx).account().cloned();
        let Some(account) = account else {
            return div().into_any_element();
        };
        let name = account.display_name();
        let email = account.email();
        Button::new("account")
            .ghost()
            .small()
            .icon(IconName::CircleUser)
            .tooltip(name.clone())
            .dropdown_menu_with_anchor(gpui_kit::Anchor::TopRight, move |menu, _, _| {
                let menu = menu.label(name.clone());
                let menu = match &email {
                    Some(email) => menu.label(email.clone()),
                    None => menu,
                };
                menu.separator().menu("Sign Out", Box::new(SignOut))
            })
            .into_any_element()
    }
}

impl Focusable for Shell {
    fn focus_handle(&self, _: &App) -> FocusHandle {
        self.focus_handle.clone()
    }
}

impl Render for Shell {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let signed_in = matches!(self.session.read(cx).status(), SessionStatus::SignedIn(_));
        let content: AnyView = if signed_in {
            self.screen(window, cx)
        } else {
            self.sign_in.clone().into()
        };

        v_flex()
            .id("shell")
            .key_context("Shell")
            .track_focus(&self.focus_handle)
            .size_full()
            .bg(cx.theme().background)
            .text_color(cx.theme().foreground)
            .on_action(cx.listener(Self::go_back))
            .on_action(cx.listener(Self::go_forward))
            .on_action(
                cx.listener(|this, _: &GoHome, _, cx| this.navigate(Destination::Generate, cx)),
            )
            .on_action(
                cx.listener(|this, _: &OpenSettings, _, cx| {
                    this.navigate(Destination::Settings, cx)
                }),
            )
            .on_action(cx.listener(|this, action: &GoToDestination, _, cx| {
                if let Some(destination) = Destination::ALL.get(action.0) {
                    this.navigate(*destination, cx);
                }
            }))
            .on_action(|_: &crate::commands::About, window, cx| crate::about::open(window, cx))
            .on_action(
                cx.listener(|this, _: &crate::commands::CopyCurrentUrl, window, cx| {
                    let mut url = cx.global::<Environment>().web_app.clone();
                    url.set_path(this.destination.web_path());
                    cx.write_to_clipboard(gpui_kit::ClipboardItem::new_string(url.to_string()));
                    gpui_kit::component::WindowExt::push_notification(
                        window,
                        gpui_kit::component::notification::Notification::success("Link copied"),
                        cx,
                    );
                }),
            )
            .on_action(cx.listener(|this, _: &OpenInBrowser, _, cx| {
                let mut url = cx.global::<Environment>().web_app.clone();
                url.set_path(this.destination.web_path());
                cx.open_url(url.as_str());
            }))
            .on_action(
                cx.listener(|this, _: &artsnack_prompts::OpenSavedPrompts, window, cx| {
                    this.open_prompts(artsnack_prompts::PromptsTab::Saved, window, cx)
                }),
            )
            .on_action(
                cx.listener(|this, _: &artsnack_prompts::OpenRecipes, window, cx| {
                    this.open_prompts(artsnack_prompts::PromptsTab::Recipes, window, cx)
                }),
            )
            .on_action(|_: &CloseWindow, window, _| window.remove_window())
            .on_action(|_: &Minimize, window, _| window.minimize_window())
            .on_action(|_: &ZoomWindow, window, _| window.zoom_window())
            .on_action(|_: &ToggleFullScreen, window, _| window.toggle_fullscreen())
            .child(self.render_title_bar(signed_in, cx))
            .child(div().flex_1().min_h_0().child(content))
    }
}
