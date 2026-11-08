//! The Generate screen: three composers behind one switch, each a resizable
//! settings | results split.
//!
//! Composers are built on first open and then kept, so a form keeps its state
//! across switches (the web keeps them mounted and hidden). The split ratio is
//! remembered per composer, as `generate-split-<tab>` was on the web. The API
//! tab draws its own split and header (`artsnack_api_tab::ApiTab`), with this
//! screen's switch handed to it.
//!
//! Only the composer on screen keeps its live feeds: a switch, or the shell
//! hiding the screen ([`GenerateView::set_active`]), tells the others they
//! are hidden, and they let go after their grace period.
//!
//! The self-hosted form is drawn as a cached view. The results beside it
//! redraw on every frame a job's spinner turns, and the form — the largest
//! element tree on the screen — then reuses its last paint instead of being
//! built again. Everything the form shows notifies the form (its own state,
//! its fields, which are views); the one input from outside, the pane zoom,
//! notifies it when it changes.

use std::rc::Rc;

use artsnack_api_tab::{ApiTab, ApiTabEvent, VideoRole};
use artsnack_library::{GalleryView, MediaCommand, ReproduceSource};
use artsnack_settings::{Preference, PreferenceFamily, Preferences};
use artsnack_ui::{DEFAULT_SPLIT_RATIO, SplitPane, ZoomControl, ZoomScale, pane_zoom};
use artsnack_video_tab::{VideoTab, VideoTabEvent};
use gpui_kit::{
    AnyElement, App, AppContext as _, Context, Entity, EventEmitter, IntoElement,
    ParentElement as _, Render, SharedString, StyleRefinement, Styled as _, Subscription,
    WeakEntity, Window,
    component::{
        ActiveTheme as _, Selectable as _, Sizable as _,
        button::{Button, ButtonGroup},
        h_flex, v_flex,
    },
    div,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::{
    backend_status::{BackendReady, BackendStatus, OpenBackendManager},
    self_hosted::{ComposerKind, SelfHostedComposer},
};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum GenerateTab {
    SelfHosted,
    SelfHostedVideo,
    Api,
}

impl GenerateTab {
    const ALL: [Self; 3] = [Self::SelfHosted, Self::SelfHostedVideo, Self::Api];

    fn label(self) -> &'static str {
        match self {
            Self::SelfHosted => "Self-hosted",
            Self::SelfHostedVideo => "Self-hosted video",
            Self::Api => "API",
        }
    }

    /// The member name of the per-composer preferences (the web's key suffix).
    fn key(self) -> &'static str {
        match self {
            Self::SelfHosted => "models",
            Self::SelfHostedVideo => "video",
            Self::Api => "api",
        }
    }
}

const TAB: Preference<GenerateTab> = Preference::new("generate.tab", || GenerateTab::SelfHosted);
const SPLIT: PreferenceFamily<f32> =
    PreferenceFamily::new("generate.split", || DEFAULT_SPLIT_RATIO);
/// Zoom of the settings (form) pane; the owner asked for one per side.
const FORM_ZOOM: PreferenceFamily<f32> = PreferenceFamily::new("generate.formZoom", || 1.0);

/// Asks the shell to show another screen with something.
#[derive(Clone, Debug)]
pub enum GenerateEvent {
    OpenBackendManager,
    /// A result's hand-off to another screen (Enhance, the API tab).
    Media(MediaCommand),
}

pub struct GenerateView {
    tab: GenerateTab,
    self_hosted: Option<Entity<SelfHostedComposer>>,
    /// The self-hosted tab's results column, built with its composer.
    self_hosted_results: Option<Entity<GalleryView>>,
    api: Option<Entity<ApiTab>>,
    video: Option<Entity<VideoTab>>,
    backend_status: Entity<BackendStatus>,
    /// Whether the screen is shown; the shell says so.
    active: bool,
    /// The self-hosted form's pane zoom as last drawn (see the module docs).
    form_zoom: f32,
    _subscriptions: Vec<Subscription>,
}

impl EventEmitter<GenerateEvent> for GenerateView {}

impl GenerateView {
    pub fn new(window: &mut Window, cx: &mut Context<Self>) -> Self {
        let backend_status = cx.new(BackendStatus::new);
        let subscriptions = vec![
            cx.subscribe(&backend_status, |_, _, _: &OpenBackendManager, cx| {
                cx.emit(GenerateEvent::OpenBackendManager)
            }),
            cx.subscribe_in(
                &backend_status,
                window,
                |this, _, _: &BackendReady, window, cx| {
                    if let Some(composer) = &this.self_hosted {
                        composer.update(cx, |composer, cx| composer.refresh_catalog(window, cx));
                    }
                },
            ),
            // The split ratio and the pane zooms live in preferences; only
            // they wake this view, not every preference written elsewhere.
            Preferences::observe_family(cx, &FORM_ZOOM, |this, cx| {
                this.redraw_zoomed_form(cx);
                cx.notify()
            }),
            Preferences::observe_family(cx, &SPLIT, |_, cx| cx.notify()),
        ];
        let mut this = Self {
            tab: Preferences::get(cx, &TAB),
            self_hosted: None,
            self_hosted_results: None,
            api: None,
            video: None,
            backend_status,
            active: true,
            form_zoom: 0.0,
            _subscriptions: subscriptions,
        };
        this.form_zoom = this.self_hosted_zoom(cx);
        this.ensure_composer(window, cx);
        this
    }

    fn ensure_composer(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.tab == GenerateTab::SelfHosted && self.self_hosted.is_none() {
            self.self_hosted =
                Some(cx.new(|cx| SelfHostedComposer::new(ComposerKind::Generate, window, cx)));
            let results = cx.new(|cx| GalleryView::results(window, cx));
            self._subscriptions.push(cx.subscribe_in(
                &results,
                window,
                |this, _, command, window, cx| this.results_command(command, window, cx),
            ));
            self.self_hosted_results = Some(results);
        }
        if self.tab == GenerateTab::Api && self.api.is_none() {
            let view = cx.entity().downgrade();
            let tabs: artsnack_api_tab::TabsBuilder =
                Rc::new(move |_, cx| tab_switch(GenerateTab::Api, view.clone(), cx));
            let api = cx.new(|cx| ApiTab::new(tabs, window, cx));
            self._subscriptions.push(cx.subscribe_in(
                &api,
                window,
                |this, _, event: &ApiTabEvent, window, cx| match event {
                    ApiTabEvent::ReproduceVideo(row) => {
                        this.switch(GenerateTab::SelfHostedVideo, window, cx);
                        if let Some(video) = &this.video {
                            let row = row.clone();
                            video.update(cx, |video, cx| video.reproduce(row, window, cx));
                        }
                    }
                    ApiTabEvent::SendToVideo { image_url, role } => {
                        this.send_to_video(image_url.clone(), *role, window, cx)
                    }
                    // A self-hosted reproduce switches to that tab's form.
                    ApiTabEvent::Media(command) => this.results_command(command, window, cx),
                },
            ));
            self.api = Some(api);
        }
        if self.tab == GenerateTab::SelfHostedVideo && self.video.is_none() {
            let view = cx.entity().downgrade();
            let tabs: artsnack_video_tab::TabsBuilder =
                Rc::new(move |_, cx| tab_switch(GenerateTab::SelfHostedVideo, view.clone(), cx));
            let video = cx.new(|cx| VideoTab::new(tabs, window, cx));
            self._subscriptions.push(cx.subscribe_in(
                &video,
                window,
                |this, _, event: &VideoTabEvent, window, cx| match event {
                    VideoTabEvent::Media(command) => this.results_command(command, window, cx),
                },
            ));
            self.video = Some(video);
        }
    }

    /// An API result handed to the video tab as a frame or a reference.
    fn send_to_video(
        &mut self,
        image_url: SharedString,
        role: VideoRole,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.switch(GenerateTab::SelfHostedVideo, window, cx);
        if let Some(video) = &self.video {
            video.update(cx, |video, cx| {
                video.receive_handoff(image_url, role, window, cx)
            });
        }
    }

    /// Reproduce a self-hosted clip from another screen.
    pub fn reproduce_video(
        &mut self,
        generation_id: String,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.switch(GenerateTab::SelfHostedVideo, window, cx);
        if let Some(video) = &self.video {
            video.update(cx, |video, cx| {
                video.reproduce_by_id(generation_id, window, cx)
            });
        }
    }

    /// "Send to API" from another screen: attaches the image as a reference.
    pub fn attach_api_reference(
        &mut self,
        image_url: SharedString,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.switch(GenerateTab::Api, window, cx);
        if let Some(api) = &self.api {
            api.update(cx, |api, cx| api.attach_reference(image_url, cx));
        }
    }

    /// Reproduce an API-tab job from another screen.
    pub fn reproduce_api(
        &mut self,
        generation_id: String,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.switch(GenerateTab::Api, window, cx);
        if let Some(api) = &self.api {
            api.update(cx, |api, cx| api.reproduce_by_id(generation_id, window, cx));
        }
    }

    /// Reproduce lands in this screen's own form; every other hand-off goes
    /// to the shell.
    fn results_command(
        &mut self,
        command: &MediaCommand,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        match command {
            MediaCommand::Reproduce(ReproduceSource::SelfHosted { form_state }) => {
                self.reproduce_self_hosted(form_state, window, cx)
            }
            other => cx.emit(GenerateEvent::Media(other.clone())),
        }
    }

    fn switch(&mut self, tab: GenerateTab, window: &mut Window, cx: &mut Context<Self>) {
        if tab == self.tab {
            return;
        }
        self.tab = tab;
        Preferences::set(cx, &TAB, tab);
        self.ensure_composer(window, cx);
        self.sync_activity(cx);
        cx.notify();
    }

    /// Whether the screen is shown (the shell says so). Hidden, every
    /// composer is told it is hidden too; shown, the current one is told it
    /// is back.
    pub fn set_active(&mut self, active: bool, cx: &mut Context<Self>) {
        if active == self.active {
            return;
        }
        self.active = active;
        self.sync_activity(cx);
    }

    /// Tells each composer built so far whether it is on screen: the
    /// self-hosted results keep their feed, the video tab reads the pods'
    /// model lists, only while they are.
    fn sync_activity(&mut self, cx: &mut Context<Self>) {
        let shown = |tab: GenerateTab| self.active && self.tab == tab;
        let (results_shown, video_shown, api_shown) = (
            shown(GenerateTab::SelfHosted),
            shown(GenerateTab::SelfHostedVideo),
            shown(GenerateTab::Api),
        );
        if let Some(api) = &self.api {
            api.update(cx, |api, cx| api.set_visible(api_shown, cx));
        }
        if let Some(results) = &self.self_hosted_results {
            results.update(cx, |results, cx| results.set_active(results_shown, cx));
        }
        if let Some(video) = &self.video {
            video.update(cx, |video, cx| video.set_active(video_shown, cx));
        }
    }

    fn self_hosted_zoom(&self, cx: &App) -> f32 {
        ZoomScale::PANE.clamp(Preferences::get_member(
            cx,
            &FORM_ZOOM,
            GenerateTab::SelfHosted.key(),
        ))
    }

    /// The self-hosted form is a cached view inside the pane zoom, which it
    /// cannot see change: a new zoom must redraw it.
    fn redraw_zoomed_form(&mut self, cx: &mut Context<Self>) {
        let zoom = self.self_hosted_zoom(cx);
        if zoom != self.form_zoom {
            self.form_zoom = zoom;
            if let Some(composer) = &self.self_hosted {
                composer.update(cx, |_, cx| cx.notify());
            }
        }
    }

    /// Restores a self-hosted form (Reproduce from elsewhere in the app).
    pub fn reproduce_self_hosted(
        &mut self,
        saved: &Value,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.switch(GenerateTab::SelfHosted, window, cx);
        self.ensure_composer(window, cx);
        if let Some(composer) = &self.self_hosted {
            composer.update(cx, |composer, cx| composer.reproduce(saved, window, cx));
        }
    }

    fn render_left(&self, composer: AnyElement, cx: &mut Context<Self>) -> impl IntoElement {
        let key = self.tab.key();
        let zoom = ZoomScale::PANE.clamp(Preferences::get_member(cx, &FORM_ZOOM, key));
        v_flex()
            .size_full()
            .child(
                h_flex()
                    .p_3()
                    .gap_2()
                    .justify_between()
                    .border_b_1()
                    .border_color(cx.theme().border)
                    .child(tab_switch(self.tab, cx.entity().downgrade(), cx))
                    .child(
                        h_flex()
                            .gap_2()
                            .child(
                                ZoomControl::new("form-zoom", zoom, ZoomScale::PANE, "form")
                                    .on_change(move |factor, _, cx| {
                                        Preferences::set_member(cx, &FORM_ZOOM, key, factor)
                                    }),
                            )
                            .child(self.backend_status.clone()),
                    ),
            )
            .child(div().flex_1().min_h_0().child(pane_zoom(zoom, composer)))
    }

    fn render_not_yet(&self, cx: &mut Context<Self>) -> AnyElement {
        v_flex()
            .size_full()
            .items_center()
            .justify_center()
            .text_color(cx.theme().muted_foreground)
            .child(format!("{} is not rebuilt natively yet.", self.tab.label()))
            .into_any_element()
    }
}

/// The Self-hosted | Self-hosted video | API switch.
fn tab_switch(current: GenerateTab, view: WeakEntity<GenerateView>, _: &mut App) -> AnyElement {
    ButtonGroup::new("generate-tab")
        .small()
        .outline()
        .children(GenerateTab::ALL.iter().map(|tab| {
            Button::new(tab.key())
                .label(tab.label())
                .selected(*tab == current)
        }))
        .on_click(move |selected: &Vec<usize>, window, cx| {
            if let Some(tab) = selected.first().and_then(|ix| GenerateTab::ALL.get(*ix)) {
                let tab = *tab;
                let _ = view.update(cx, |this, cx| this.switch(tab, window, cx));
            }
        })
        .into_any_element()
}

impl Render for GenerateView {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        if self.tab == GenerateTab::Api
            && let Some(api) = &self.api
        {
            return api.clone().into_any_element();
        }
        if self.tab == GenerateTab::SelfHostedVideo
            && let Some(video) = &self.video
        {
            return video.clone().into_any_element();
        }
        let key = self.tab.key();
        let ratio = Preferences::get_member(cx, &SPLIT, key);
        let composer: AnyElement = match (&self.tab, &self.self_hosted) {
            // Cached: see the module docs. The pane gives it a definite size.
            (GenerateTab::SelfHosted, Some(composer)) => composer
                .clone()
                .cached(StyleRefinement::default().size_full())
                .into_any_element(),
            _ => self.render_not_yet(cx),
        };
        let results = match (&self.tab, &self.self_hosted_results) {
            (GenerateTab::SelfHosted, Some(results)) => results.clone().into_any_element(),
            _ => crate::results::placeholder(cx),
        };

        SplitPane::new(
            "generate-split",
            ratio,
            self.render_left(composer, cx),
            results,
        )
        .on_resize(move |ratio, _, cx| Preferences::set_member(cx, &SPLIT, key, ratio))
        .into_any_element()
    }
}
