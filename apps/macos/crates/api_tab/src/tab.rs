//! The API tab as a whole: the switcher row, then the composer | results
//! split — or the Grok connection card when Grok is chosen and not connected,
//! or Image → Prompt, which brings its own split. Image → Prompt is built the
//! first time it is opened and kept, so its results survive a trip to a
//! provider and back.
//!
//! The composer and the results are drawn as cached views: each is laid out
//! again only when it is notified itself, so a clip playing in the grid, a
//! running job's progress or a keystroke in the form redraws its own pane and
//! not the other. The switcher row is this view's, and cheap.

use std::{rc::Rc, sync::Arc};

use artsnack_backend::{
    Backend,
    api::grok_generations::{self, ApiGeneration, IdArgs},
};
use artsnack_settings::{Preference, PreferenceFamily, Preferences};
use artsnack_ui::{DEFAULT_SPLIT_RATIO, SplitPane, ZoomControl, ZoomScale, pane_zoom};
use gpui_kit::{
    AnyElement, App, AppContext as _, Context, Entity, EventEmitter, InteractiveElement as _,
    IntoElement, KeyBinding, ParentElement as _, Render, SharedString, StyleRefinement,
    Styled as _, Subscription, Window,
    component::{ActiveTheme as _, WindowExt as _, h_flex, notification::Notification, v_flex},
    div,
};

use crate::{
    composer::{ApiComposer, ComposerEvent, GrokConnect, Submit, SwitcherAction},
    describe::DescribePanel,
    results::{ApiResults, ApiResultsEvent, VideoRole},
    studio::{PromptStudio, StudioEvent},
};

const CONTEXT: &str = "ApiTab";

pub(crate) fn init(cx: &mut App) {
    cx.bind_keys([KeyBinding::new("cmd-enter", Submit, Some(CONTEXT))]);
}

/// Image → Prompt was showing (`artsnack_api_describe` on the web).
const DESCRIBING: Preference<bool> = Preference::new("api.describe", || false);
/// Shared with the Generate screen's other composers, one member per tab.
const SPLIT: PreferenceFamily<f32> =
    PreferenceFamily::new("generate.split", || DEFAULT_SPLIT_RATIO);
const FORM_ZOOM: PreferenceFamily<f32> = PreferenceFamily::new("generate.formZoom", || 1.0);
const MEMBER: &str = "api";

/// Builds the Generate screen's backend switch (Self-hosted | video | API)
/// that the tab shows at the start of its first row.
pub type TabsBuilder = Rc<dyn Fn(&mut Window, &mut App) -> AnyElement>;

/// What the tab hands to the Generate screen.
#[derive(Clone, Debug)]
pub enum ApiTabEvent {
    /// Reproduce a self-hosted clip in the video tab.
    ReproduceVideo(Arc<ApiGeneration>),
    /// Use an image on the video tab in this role.
    SendToVideo {
        image_url: SharedString,
        role: VideoRole,
    },
    /// A hand-off to another screen or tab.
    Media(artsnack_library::MediaCommand),
}

pub struct ApiTab {
    composer: Entity<ApiComposer>,
    results: Entity<ApiResults>,
    connect: Entity<GrokConnect>,
    describe: Option<Entity<DescribePanel>>,
    describing: bool,
    /// Prompt Studio, built the first time it is opened and kept, so its
    /// draft and session survive a close.
    studio: Option<Entity<PromptStudio>>,
    /// Prompt Studio takes the results pane.
    studio_open: bool,
    /// The form zoom the composer was last drawn at: its cached view is not
    /// laid out again for a change of rem size alone, so it is told.
    form_zoom: f32,
    /// Whether the Generate screen shows this tab.
    visible: bool,
    tabs: TabsBuilder,
    _subscriptions: Vec<Subscription>,
}

impl EventEmitter<ApiTabEvent> for ApiTab {}

impl ApiTab {
    pub fn new(tabs: TabsBuilder, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let composer = cx.new(|cx| ApiComposer::new(window, cx));
        let results = cx.new(|cx| ApiResults::new(window, cx));
        let connect = cx.new(|cx| GrokConnect::new(window, cx));
        let subscriptions = vec![
            cx.observe(&composer, |_, _, cx| cx.notify()),
            // Only the keys this tab draws from: typing in a form elsewhere
            // or moving the window does not wake it.
            Preferences::observe_member(cx, &FORM_ZOOM, MEMBER, |this, cx| {
                let zoom = ZoomScale::PANE.clamp(Preferences::get_member(cx, &FORM_ZOOM, MEMBER));
                if zoom != this.form_zoom {
                    this.form_zoom = zoom;
                    this.composer.update(cx, |_, cx| cx.notify());
                }
                cx.notify()
            }),
            Preferences::observe_member(cx, &SPLIT, MEMBER, |_, cx| cx.notify()),
            Preferences::observe(cx, &DESCRIBING, |_, cx| cx.notify()),
            cx.subscribe_in(
                &composer,
                window,
                |this, _, event: &ComposerEvent, window, cx| match event {
                    ComposerEvent::ReproduceVideo(row) => {
                        cx.emit(ApiTabEvent::ReproduceVideo(row.clone()))
                    }
                    ComposerEvent::Started => {}
                    ComposerEvent::ToggleStudio => this.toggle_studio(window, cx),
                    ComposerEvent::Media(command) => cx.emit(ApiTabEvent::Media(command.clone())),
                },
            ),
            cx.subscribe(
                &results,
                |this, _, event: &ApiResultsEvent, cx| match event {
                    ApiResultsEvent::Reproduce(row) => {
                        this.set_describing(false, cx);
                        let row = row.clone();
                        this.composer
                            .update(cx, |composer, cx| composer.reproduce(row, cx));
                    }
                    ApiResultsEvent::UseAsReference {
                        image_url,
                        as_video,
                    } => {
                        this.set_describing(false, cx);
                        let (url, to_video) = (image_url.clone(), Some(*as_video));
                        this.composer.update(cx, |composer, cx| {
                            composer.attach_url(url, None, to_video, cx)
                        });
                    }
                    ApiResultsEvent::SendToVideo { image_url, role } => {
                        cx.emit(ApiTabEvent::SendToVideo {
                            image_url: image_url.clone(),
                            role: *role,
                        })
                    }
                    ApiResultsEvent::Media(command) => cx.emit(ApiTabEvent::Media(command.clone())),
                    ApiResultsEvent::UseAsSourceVideo { key, mode } => {
                        this.set_describing(false, cx);
                        let (key, mode) = (key.clone(), *mode);
                        this.composer
                            .update(cx, |composer, cx| composer.use_source_video(key, mode, cx));
                    }
                },
            ),
        ];
        let form_zoom = ZoomScale::PANE.clamp(Preferences::get_member(cx, &FORM_ZOOM, MEMBER));
        let mut this = Self {
            composer,
            results,
            connect,
            describe: None,
            describing: false,
            studio: None,
            studio_open: false,
            form_zoom,
            visible: true,
            tabs,
            _subscriptions: subscriptions,
        };
        if Preferences::get(cx, &DESCRIBING) {
            this.open_describe(window, cx);
        }
        this
    }

    fn set_describing(&mut self, describing: bool, cx: &mut Context<Self>) {
        if self.describing != describing {
            self.describing = describing;
            Preferences::set(cx, &DESCRIBING, describing);
            self.sync_results_visibility(cx);
            cx.notify();
        }
    }

    /// Shown or hidden by the Generate screen. Hidden, the results grid lets
    /// its clips go: an undrawn grid would otherwise keep up to four players
    /// decoding.
    pub fn set_visible(&mut self, visible: bool, cx: &mut Context<Self>) {
        if self.visible != visible {
            self.visible = visible;
            self.sync_results_visibility(cx);
        }
    }

    /// Opens Prompt Studio in the results pane, or closes it. The studio is
    /// made on first use.
    fn toggle_studio(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let open = !self.studio_open;
        if open && self.studio.is_none() {
            let composer = self.composer.clone();
            let studio = cx.new(|cx| PromptStudio::new(composer, window, cx));
            self._subscriptions.push(cx.subscribe_in(
                &studio,
                window,
                |this, _, event: &StudioEvent, window, cx| match event {
                    StudioEvent::Close => this.set_studio_open(false, window, cx),
                },
            ));
            self.studio = Some(studio);
        }
        self.set_studio_open(open, window, cx);
    }

    fn set_studio_open(&mut self, open: bool, window: &mut Window, cx: &mut Context<Self>) {
        if self.studio_open == open {
            return;
        }
        self.studio_open = open;
        self.composer
            .update(cx, |composer, cx| composer.set_studio_open(open, cx));
        if let Some(studio) = &self.studio {
            studio.update(cx, |studio, cx| studio.set_open(open, window, cx));
        }
        self.sync_results_visibility(cx);
        cx.notify();
    }

    /// The grid is on screen only with the tab, and not under Image → Prompt
    /// or Prompt Studio.
    fn sync_results_visibility(&mut self, cx: &mut Context<Self>) {
        let visible = self.visible && !self.describing && !self.studio_open;
        self.results
            .update(cx, |results, cx| results.set_visible(visible, cx));
    }

    fn open_describe(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.describe.is_none() {
            let tab = cx.entity().downgrade();
            let header: crate::describe::HeaderBuilder = Rc::new(move |window, cx| {
                tab.upgrade()
                    .map(|tab| tab.update(cx, |tab, cx| tab.render_header(window, cx)))
                    .unwrap_or_else(|| div().into_any_element())
            });
            self.describe = Some(cx.new(|cx| DescribePanel::new(header, window, cx)));
        }
        self.set_describing(true, cx);
    }

    /// "Send to API" from another screen: attaches to whichever media type is
    /// showing, and leaves Image → Prompt so the attachment is seen.
    pub fn attach_reference(&mut self, image_url: SharedString, cx: &mut Context<Self>) {
        self.set_describing(false, cx);
        self.composer
            .update(cx, |composer, cx| composer.queue_handoff(image_url, cx));
    }

    /// Reproduce from another screen (a favourite, search): the row is read
    /// fresh, so what is restored is what the record says now.
    pub fn reproduce_by_id(
        &mut self,
        generation_id: String,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.set_describing(false, cx);
        let task = Backend::global(cx).update(cx, |backend, cx| {
            backend.query(grok_generations::GET, &IdArgs { id: generation_id }, cx)
        });
        let window_handle = window.window_handle();
        cx.spawn(async move |this, cx| {
            let result = task.await;
            let _ = this.update(cx, |this, cx| match result {
                Ok(Some(row)) => {
                    let row = Arc::new(row);
                    this.composer
                        .update(cx, |composer, cx| composer.reproduce(row, cx));
                }
                Ok(None) => {
                    let _ = window_handle.update(cx, |_, window, cx| {
                        window.push_notification(
                            Notification::error("That generation is no longer available"),
                            cx,
                        )
                    });
                }
                Err(error) => {
                    let message = error.user_message();
                    let _ = window_handle.update(cx, |_, window, cx| {
                        window.push_notification(Notification::error(message), cx)
                    });
                }
            });
        })
        .detach();
    }

    /// The switcher row with the balance and the form zoom on its right.
    fn render_header(&mut self, window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        let tabs = (self.tabs)(window, cx);
        let zoom = ZoomScale::PANE.clamp(Preferences::get_member(cx, &FORM_ZOOM, MEMBER));
        let describing = self.describing;
        let tab = cx.entity().downgrade();
        let on_action = move |action: SwitcherAction, window: &mut Window, cx: &mut App| {
            let _ = tab.update(cx, |tab, cx| match action {
                SwitcherAction::Describe => tab.open_describe(window, cx),
                SwitcherAction::Provider => tab.set_describing(false, cx),
            });
        };
        let switcher = self.composer.update(cx, |composer, cx| {
            let balance = (!describing).then(|| composer.render_balance(cx)).flatten();
            let accessory = h_flex()
                .gap_2()
                .children(balance)
                .child(
                    ZoomControl::new("api-form-zoom", zoom, ZoomScale::PANE, "form").on_change(
                        |factor, _, cx| Preferences::set_member(cx, &FORM_ZOOM, MEMBER, factor),
                    ),
                )
                .into_any_element();
            composer.render_switcher(tabs, Some(accessory), describing, on_action, cx)
        });
        div()
            .p_3()
            .border_b_1()
            .border_color(cx.theme().border)
            .child(switcher)
            .into_any_element()
    }
}

impl Render for ApiTab {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        if self.describing
            && let Some(describe) = &self.describe
        {
            return div().size_full().child(describe.clone()).into_any_element();
        }
        let header = self.render_header(window, cx);
        let composer = self.composer.clone();
        if composer.read(cx).needs_grok_connection(cx) {
            return v_flex()
                .size_full()
                .child(header)
                .child(
                    v_flex()
                        .flex_1()
                        .items_center()
                        .pt_12()
                        .px_6()
                        .child(div().w_full().max_w(gpui_kit::rems(28.)).child(self.connect.clone()))
                        .child(
                            div()
                                .mt_4()
                                .text_sm()
                                .text_color(cx.theme().muted_foreground)
                                .child("Or pick another provider above — none of them needs you to sign in here."),
                        ),
                )
                .into_any_element();
        }
        let zoom = ZoomScale::PANE.clamp(Preferences::get_member(cx, &FORM_ZOOM, MEMBER));
        let ratio = Preferences::get_member(cx, &SPLIT, MEMBER);
        let left = v_flex().size_full().child(header).child(
            div().flex_1().min_h_0().child(pane_zoom(
                zoom,
                composer
                    .clone()
                    .cached(StyleRefinement::default().size_full()),
            )),
        );
        let composer_for_action = composer.clone();
        let right = match &self.studio {
            Some(studio) if self.studio_open => studio
                .clone()
                .cached(StyleRefinement::default().size_full())
                .into_any_element(),
            _ => self
                .results
                .clone()
                .cached(StyleRefinement::default().size_full())
                .into_any_element(),
        };
        div()
            .id("api-tab")
            .key_context(CONTEXT)
            .size_full()
            .on_action(move |action: &Submit, window, cx| {
                composer_for_action.update(cx, |composer, cx| composer.submit(action, window, cx))
            })
            .child(
                SplitPane::new("api-split", ratio, left, right)
                    .on_resize(|ratio, _, cx| Preferences::set_member(cx, &SPLIT, MEMBER, ratio)),
            )
            .into_any_element()
    }
}
