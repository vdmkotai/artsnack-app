//! The tab as a whole: the switcher row with the form zoom and the video pods'
//! chip, then the form | results split.

use std::{rc::Rc, sync::Arc};

use artsnack_api_tab::{ApiResults, ApiResultsEvent, VideoRole};
use artsnack_backend::{
    Backend, LiveQuery, NoArgs,
    api::{
        grok_generations::{self, ApiGeneration, IdArgs},
        runpod_backend_store,
    },
};
use artsnack_library::MediaCommand;
use artsnack_settings::{PreferenceFamily, Preferences};
use artsnack_ui::{DEFAULT_SPLIT_RATIO, SplitPane, ZoomControl, ZoomScale, pane_zoom};
use gpui_kit::{
    AnyElement, App, AppContext as _, Context, Entity, EventEmitter, InteractiveElement as _,
    IntoElement, ParentElement as _, Render, SharedString, StyleRefinement, Styled as _,
    Subscription, Window,
    component::{ActiveTheme as _, WindowExt as _, h_flex, notification::Notification, v_flex},
    div,
};

use crate::{
    composer::VideoComposer,
    pods::{self, VideoPods},
    rules::VideoRules,
};

/// Shared with the Generate screen's other composers, one member per tab.
const SPLIT: PreferenceFamily<f32> =
    PreferenceFamily::new("generate.split", || DEFAULT_SPLIT_RATIO);
const FORM_ZOOM: PreferenceFamily<f32> = PreferenceFamily::new("generate.formZoom", || 1.0);
const MEMBER: &str = "video";

/// What a results tile says when its row has no settings to restore.
const LEGACY_CLIP: &str = "Legacy Wan clips cannot be reproduced on H3";

/// Builds the Generate screen's backend switch for the tab's header row.
pub type TabsBuilder = Rc<dyn Fn(&mut Window, &mut App) -> AnyElement>;

/// What the tab hands to the Generate screen.
#[derive(Clone, Debug)]
pub enum VideoTabEvent {
    /// A result's hand-off to another screen, from a clip's reference viewer:
    /// Reproduce a reference's own generation, Send to Enhance.
    Media(MediaCommand),
}

/// The Self-hosted video tab: MiniMax H3 and LTX 2.3 on the video pods.
pub struct VideoTab {
    tabs: TabsBuilder,
    pods: VideoPods,
    /// `Err` only when the shared rules failed to load, a build bug.
    composer: Result<Entity<VideoComposer>, SharedString>,
    results: Entity<ApiResults>,
    _subscriptions: Vec<Subscription>,
}

impl VideoTab {
    pub fn new(tabs: TabsBuilder, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let pods = LiveQuery::new(runpod_backend_store::VIDEO_PODS, &NoArgs {}, cx);
        let composer = match VideoRules::load(cx) {
            Ok(rules) => {
                let pods = pods.clone();
                Ok(cx.new(|cx| VideoComposer::new(pods, Rc::new(rules), window, cx)))
            }
            Err(error) => {
                tracing::error!(?error, "could not read the video form's rules");
                Err("The video form could not load its rules. This build is broken.".into())
            }
        };
        let results = cx.new(|cx| ApiResults::self_hosted_video(window, cx));
        let subscriptions = vec![
            // The chip follows the pods; the split and zoom live in preferences.
            cx.observe(&pods, |_, _, cx| cx.notify()),
            // The form is a cached view: a zoom change does not change its
            // bounds, so it has to be told to lay out again.
            Preferences::observe_member(cx, &FORM_ZOOM, MEMBER, |this, cx| {
                if let Ok(composer) = &this.composer {
                    composer.update(cx, |_, cx| cx.notify());
                }
                cx.notify()
            }),
            Preferences::observe_member(cx, &SPLIT, MEMBER, |_, cx| cx.notify()),
            cx.subscribe_in(
                &results,
                window,
                |this, _, event: &ApiResultsEvent, window, cx| match event {
                    ApiResultsEvent::Reproduce(row) => {
                        this.restore(row.clone(), LEGACY_CLIP, window, cx)
                    }
                    ApiResultsEvent::UseAsReference { image_url, .. } => {
                        if let Ok(composer) = &this.composer {
                            let url = image_url.clone();
                            composer
                                .update(cx, |composer, cx| composer.use_result(url, window, cx));
                        }
                    }
                    ApiResultsEvent::Media(command) => {
                        cx.emit(VideoTabEvent::Media(command.clone()))
                    }
                    // Not offered on this grid: the clip is already here, and
                    // Grok's Edit/Extend belongs to the API tab's form.
                    ApiResultsEvent::SendToVideo { .. }
                    | ApiResultsEvent::UseAsSourceVideo { .. } => {}
                },
            ),
        ];
        Self {
            tabs,
            pods,
            composer,
            results,
            _subscriptions: subscriptions,
        }
    }

    /// Whether the tab is on screen. The pods' model lists are read only while
    /// it is, and at once when it opens; a new tab starts on screen. "On
    /// screen" means both that it is Generate's open tab and that Generate is
    /// the window's open screen: the owner calls this for either change.
    pub fn set_active(&mut self, active: bool, cx: &mut Context<Self>) {
        if let Ok(composer) = &self.composer {
            composer.update(cx, |composer, cx| composer.set_active(active, cx));
        }
        // Hidden, the grid's clips stop and let go of their players.
        self.results
            .update(cx, |results, cx| results.set_visible(active, cx));
    }

    /// Restores a clip's settings and input images (Reproduce on a clip).
    pub fn reproduce(
        &mut self,
        row: Arc<ApiGeneration>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.restore(row, LEGACY_CLIP, window, cx);
    }

    fn restore(
        &mut self,
        row: Arc<ApiGeneration>,
        missing: &'static str,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if let Ok(composer) = &self.composer {
            composer.update(cx, |composer, cx| {
                composer.reproduce(row, missing, window, cx)
            });
        }
    }

    /// Reproduce from another screen (Favorites, Search, the viewer): the row
    /// is read fresh, so what is restored is what the record says now.
    pub fn reproduce_by_id(
        &mut self,
        generation_id: String,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let task = Backend::global(cx).update(cx, |backend, cx| {
            backend.query(grok_generations::GET, &IdArgs { id: generation_id }, cx)
        });
        let window_handle = window.window_handle();
        cx.spawn(async move |this, cx| {
            let result = task.await;
            let _ = window_handle.update(cx, |_, window, cx| {
                let _ = this.update(cx, |this, cx| match result {
                    Ok(Some(row)) => this.restore(
                        Arc::new(row),
                        "This clip has no settings to reproduce",
                        window,
                        cx,
                    ),
                    Ok(None) => {
                        window.push_notification(Notification::error("That clip is gone"), cx)
                    }
                    Err(error) => {
                        window.push_notification(Notification::error(error.user_message()), cx)
                    }
                });
            });
        })
        .detach();
    }

    /// An image sent from the API tab's results ("Send to video").
    pub fn receive_handoff(
        &mut self,
        image_url: SharedString,
        role: VideoRole,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if let Ok(composer) = &self.composer {
            composer.update(cx, |composer, cx| {
                composer.receive_handoff(image_url, role, window, cx)
            });
        }
    }

    /// The switcher row with the form zoom and the pods' chip on its right.
    fn render_header(
        &self,
        zoom: f32,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        let tabs = (self.tabs)(window, cx);
        let pods = self.pods.clone();
        let list = self.pods.read(cx).data().cloned();
        h_flex()
            .p_3()
            .gap_2()
            .justify_between()
            .border_b_1()
            .border_color(cx.theme().border)
            .child(tabs)
            .child(
                h_flex()
                    .gap_2()
                    .child(
                        ZoomControl::new("video-form-zoom", zoom, ZoomScale::PANE, "form")
                            .on_change(|factor, _, cx| {
                                Preferences::set_member(cx, &FORM_ZOOM, MEMBER, factor)
                            }),
                    )
                    .child(pods::render_chip(
                        list.as_deref().map(Vec::as_slice),
                        move |_, window, cx| pods::open_dialog(pods.clone(), window, cx),
                        cx,
                    )),
            )
    }
}

impl EventEmitter<VideoTabEvent> for VideoTab {}

impl Render for VideoTab {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let zoom = ZoomScale::PANE.clamp(Preferences::get_member(cx, &FORM_ZOOM, MEMBER));
        let ratio = Preferences::get_member(cx, &SPLIT, MEMBER);
        let form: AnyElement = match &self.composer {
            // Cached: the grid's clips redraw the results on every frame, and
            // nothing of the form changes with them.
            Ok(composer) => pane_zoom(
                zoom,
                composer
                    .clone()
                    .cached(StyleRefinement::default().size_full()),
            )
            .into_any_element(),
            Err(message) => div()
                .p_4()
                .text_sm()
                .text_color(cx.theme().danger)
                .child(message.clone())
                .into_any_element(),
        };
        let left = v_flex()
            .size_full()
            .child(self.render_header(zoom, window, cx))
            .child(div().flex_1().min_h_0().child(form));
        div().id("video-tab").size_full().child(
            SplitPane::new(
                "video-split",
                ratio,
                left,
                self.results
                    .clone()
                    .cached(StyleRefinement::default().size_full()),
            )
            .on_resize(|ratio, _, cx| Preferences::set_member(cx, &SPLIT, MEMBER, ratio)),
        )
    }
}
