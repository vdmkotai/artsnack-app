//! The self-hosted backend's status button (the web's `BackendStatus`).
//!
//! Which provider is in use, and how it is: grey while checking, green when the
//! pod answers, red when it does not, amber and filling up with the reported
//! progress while a pod boots. Health is asked only when what decides it
//! changes — the backend row, its state, its address — never on every progress
//! write, and an older answer is dropped if a newer check started.
//!
//! [`BackendReady`] fires whenever the backend in use is ready and is not the
//! one last seen: a pod that came up, but also another that took over while
//! both were ready (RunPod to Vast) or a new address — each is another model
//! list.

use artsnack_backend::{
    Backend, LiveQuery, NoArgs,
    api::{
        pod_catalog,
        runpod_backends::{self, BackendRow, BackendState, Provider, RunpodCurrentArgs, Selection},
    },
};
use gpui_kit::{
    Context, Entity, EventEmitter, Hsla, InteractiveElement as _, IntoElement, ParentElement as _,
    Render, SharedString, StatefulInteractiveElement as _, Styled as _, Subscription, Task, Window,
    component::{ActiveTheme as _, Sizable as _, h_flex, spinner::Spinner},
    div,
    prelude::FluentBuilder as _,
    relative,
};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Health {
    Checking,
    Online,
    Offline,
}

/// The button was clicked: open the backend manager.
#[derive(Clone, Debug)]
pub struct OpenBackendManager;

pub struct BackendStatus {
    runpod: Entity<LiveQuery<Option<BackendRow>>>,
    vast: Entity<LiveQuery<Option<BackendRow>>>,
    selection: Entity<LiveQuery<Option<Selection>>>,
    health: Health,
    /// What the last health check was for: (row id, state, address).
    checked_for: Option<(Option<String>, Option<BackendState>, Option<String>)>,
    health_task: Option<Task<()>>,
    _subscriptions: Vec<Subscription>,
}

impl EventEmitter<OpenBackendManager> for BackendStatus {}

/// Emitted when a backend is ready that was not before: it came up, or it
/// replaced the one in use (to refresh the model lists).
#[derive(Clone, Debug)]
pub struct BackendReady;

impl EventEmitter<BackendReady> for BackendStatus {}

impl BackendStatus {
    pub fn new(cx: &mut Context<Self>) -> Self {
        let runpod = LiveQuery::new(
            runpod_backends::RUNPOD_CURRENT,
            &RunpodCurrentArgs::default(),
            cx,
        );
        let vast = LiveQuery::new(runpod_backends::VAST_CURRENT, &NoArgs {}, cx);
        let selection = LiveQuery::new(runpod_backends::SELECTION, &NoArgs {}, cx);
        let subscriptions = vec![
            cx.observe(&runpod, |this, _, cx| this.changed(cx)),
            cx.observe(&vast, |this, _, cx| this.changed(cx)),
            cx.observe(&selection, |this, _, cx| this.changed(cx)),
        ];
        Self {
            runpod,
            vast,
            selection,
            health: Health::Checking,
            checked_for: None,
            health_task: None,
            _subscriptions: subscriptions,
        }
    }

    /// The backend new generations use: the selected provider's, else Vast's,
    /// else RunPod's — as the web chooses.
    fn backend(&self, cx: &gpui_kit::App) -> Option<BackendRow> {
        let runpod = self.runpod.read(cx).data().and_then(|row| (**row).clone());
        let vast = self.vast.read(cx).data().and_then(|row| (**row).clone());
        let selected = self
            .selection
            .read(cx)
            .data()
            .and_then(|selection| selection.as_ref().as_ref().map(|s| s.provider));
        match selected {
            Some(Provider::Runpod) => runpod,
            Some(Provider::Vast) => vast,
            _ => vast.or(runpod),
        }
    }

    fn loaded(&self, cx: &gpui_kit::App) -> bool {
        self.runpod.read(cx).data().is_some() && self.vast.read(cx).data().is_some()
    }

    fn changed(&mut self, cx: &mut Context<Self>) {
        let backend = self.backend(cx);
        let key = (
            backend.as_ref().map(|row| row.id.clone()),
            backend.as_ref().map(|row| row.state),
            backend.as_ref().map(|row| row.public_url.clone()),
        );
        if self.checked_for.as_ref() != Some(&key) {
            // The key moved, so a ready backend now is either newly ready or
            // another backend (or address) than the ready one before.
            let became_ready = key.1 == Some(BackendState::Ready);
            self.checked_for = Some(key.clone());
            match key.1 {
                // No managed backend: a legacy pod may still answer.
                None | Some(BackendState::Ready) => self.check_health(cx),
                Some(_) => {
                    self.health_task = None;
                    self.health = if self.loaded(cx) {
                        Health::Offline
                    } else {
                        Health::Checking
                    };
                }
            }
            if became_ready {
                cx.emit(BackendReady);
            }
        }
        cx.notify();
    }

    fn check_health(&mut self, cx: &mut Context<Self>) {
        self.health = Health::Checking;
        let request = Backend::global(cx).update(cx, |backend, cx| {
            backend.act(pod_catalog::HEALTH, &NoArgs {}, cx)
        });
        // Replacing the task drops (and so ignores) the previous check.
        self.health_task = Some(cx.spawn(async move |this, cx| {
            let online = matches!(request.await, Ok(health) if health.online);
            let _ = this.update(cx, |this, cx| {
                this.health = if online {
                    Health::Online
                } else {
                    Health::Offline
                };
                cx.notify();
            });
        }));
    }
}

impl Render for BackendStatus {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let backend = self.backend(cx);
        let booting = backend.as_ref().is_some_and(|row| row.state.is_booting());
        let progress = booting.then(|| {
            backend
                .as_ref()
                .map(|row| row.progress.clamp(0.0, 100.0))
                .unwrap_or(0.0)
        });

        let label: SharedString = match &backend {
            Some(row) if row.state == BackendState::Ready => {
                format!("{} ready", row.provider_label()).into()
            }
            Some(row) => format!("{} · {}", row.provider_label(), row.state.label()).into(),
            None if self.health == Health::Online => "Self-hosted ready".into(),
            None => "Start backend".into(),
        };
        let theme = cx.theme();
        let dot: Hsla = if booting {
            theme.warning
        } else {
            match self.health {
                Health::Checking => theme.muted_foreground,
                Health::Online => theme.success,
                Health::Offline => theme.danger,
            }
        };
        let tooltip = booting.then(|| {
            backend
                .as_ref()
                .map(|row| row.message.clone())
                .unwrap_or_default()
        });

        h_flex()
            .id("backend-status")
            .relative()
            .overflow_hidden()
            .gap_2()
            .px_3()
            .py_1p5()
            .rounded(theme.radius)
            .border_1()
            .border_color(theme.border)
            .cursor_pointer()
            .hover(|style| style.bg(cx.theme().accent))
            .on_click(cx.listener(|_, _, _, cx| cx.emit(OpenBackendManager)))
            .when_some(tooltip, |this, message| {
                this.tooltip(move |window, cx| {
                    gpui_kit::component::tooltip::Tooltip::new(message.clone()).build(window, cx)
                })
            })
            .when_some(progress, |this, progress| {
                // The fill behind the label and the bar along the bottom edge
                // track the same number the manager shows.
                this.child(
                    div()
                        .absolute()
                        .top_0()
                        .bottom_0()
                        .left_0()
                        .w(relative((progress / 100.0) as f32))
                        .bg(cx.theme().primary.opacity(0.2)),
                )
                .child(
                    div()
                        .absolute()
                        .bottom_0()
                        .left_0()
                        .h_0p5()
                        .w(relative((progress.max(2.0) / 100.0) as f32))
                        .bg(cx.theme().primary),
                )
            })
            .child(div().size_2().rounded_full().bg(dot))
            .child(div().text_sm().child(label))
            .when_some(progress, |this, progress| {
                this.child(
                    div()
                        .px_1p5()
                        .rounded(cx.theme().radius)
                        .bg(cx.theme().primary.opacity(0.3))
                        .text_xs()
                        .child(format!("{}%", progress.round() as i64)),
                )
            })
            .when(self.health == Health::Checking && !booting, |this| {
                this.child(Spinner::new().xsmall())
            })
    }
}
