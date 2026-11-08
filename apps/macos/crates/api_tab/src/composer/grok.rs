//! "Connect your Grok account": xAI's device authorization. The sign-in page
//! opens in the default browser — xAI, like Google, does not sign in inside an
//! app window — and this card shows the code and polls until the user has
//! confirmed it there (the web's grok-connect.tsx).

use std::time::Duration;

use artsnack_backend::{
    Backend, NoArgs,
    api::grok_auth::{self, DeviceAuth, DevicePoll},
};
use gpui_kit::{
    Context, IntoElement, ParentElement as _, Render, SharedString, Styled as _, Task, Window,
    assets::IconName,
    component::{
        ActiveTheme as _, Sizable as _, WindowExt as _,
        button::{Button, ButtonVariants as _},
        h_flex,
        notification::Notification,
        spinner::Spinner,
        v_flex,
    },
    div,
};

enum Phase {
    Idle,
    Starting,
    Waiting {
        code: SharedString,
        url: SharedString,
        _poll: Task<()>,
    },
}

pub struct GrokConnect {
    phase: Phase,
}

impl GrokConnect {
    pub fn new(_: &mut Window, _: &mut Context<Self>) -> Self {
        Self { phase: Phase::Idle }
    }

    fn start(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.phase = Phase::Starting;
        cx.notify();
        let task = Backend::global(cx).update(cx, |backend, cx| {
            backend.act(grok_auth::START_DEVICE_AUTH, &NoArgs {}, cx)
        });
        let window_handle = window.window_handle();
        cx.spawn(async move |this, cx| {
            let started: Result<DeviceAuth, _> = task.await;
            let _ = this.update(cx, |this, cx| match started {
                Ok(auth) => {
                    let url: SharedString = auth
                        .verification_uri_complete
                        .clone()
                        .unwrap_or_else(|| auth.verification_uri.clone())
                        .into();
                    cx.open_url(&url);
                    let interval = Duration::from_secs_f64(auth.interval.max(1.));
                    let poll = this_poll(interval, window_handle, cx);
                    this.phase = Phase::Waiting {
                        code: auth.user_code.into(),
                        url,
                        _poll: poll,
                    };
                    cx.notify();
                }
                Err(error) => {
                    this.phase = Phase::Idle;
                    let message = error.user_message();
                    let _ = window_handle.update(cx, |_, window, cx| {
                        window.push_notification(Notification::error(message), cx)
                    });
                    cx.notify();
                }
            });
        })
        .detach();
    }

    fn cancel(&mut self, cx: &mut Context<Self>) {
        self.phase = Phase::Idle;
        cx.notify();
    }
}

/// Polls every `interval` until xAI answers something other than "pending".
fn this_poll(
    interval: Duration,
    window: gpui_kit::AnyWindowHandle,
    cx: &mut Context<GrokConnect>,
) -> Task<()> {
    cx.spawn(async move |this, cx| {
        loop {
            cx.background_executor().timer(interval).await;
            let task = cx.update(|cx| {
                Backend::global(cx).update(cx, |backend, cx| {
                    backend.act(grok_auth::POLL_DEVICE_AUTH, &NoArgs {}, cx)
                })
            });
            let outcome = match task.await {
                Ok(DevicePoll::Pending) => continue,
                Ok(DevicePoll::Done { email }) => Notification::success(match email {
                    Some(email) => format!("Grok connected as {email}"),
                    None => "Grok connected".to_string(),
                }),
                Ok(DevicePoll::Denied) => Notification::error("Grok sign-in was denied"),
                Ok(DevicePoll::Expired) => {
                    Notification::error("The sign-in code expired. Try again.")
                }
                Err(error) => Notification::error(error.user_message()),
            };
            let _ = this.update(cx, |this, cx| {
                this.phase = Phase::Idle;
                cx.notify();
            });
            let _ = window.update(cx, |_, window, cx| window.push_notification(outcome, cx));
            return;
        }
    })
}

impl Render for GrokConnect {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = cx.theme().clone();
        let body = match &self.phase {
            Phase::Idle | Phase::Starting => v_flex()
                .gap_3()
                .child(
                    div()
                        .text_sm()
                        .text_color(theme.muted_foreground)
                        .child("Grok generations run on your SuperGrok subscription. Sign in with xAI once; the connection is kept on the server."),
                )
                .child(
                    Button::new("grok-connect")
                        .primary()
                        .icon(IconName::LogIn)
                        .label("Connect Grok")
                        .loading(matches!(self.phase, Phase::Starting))
                        .on_click(cx.listener(|this, _, window, cx| this.start(window, cx))),
                ),
            Phase::Waiting { code, url, .. } => {
                let url = url.clone();
                v_flex()
                    .gap_3()
                    .child(
                        div()
                            .text_sm()
                            .text_color(theme.muted_foreground)
                            .child("Confirm this code on the xAI page that opened in your browser:"),
                    )
                    .child(
                        div()
                            .text_3xl()
                            .font_family(theme.mono_font_family.clone())
                            .font_weight(gpui_kit::FontWeight::BOLD)
                            .child(code.clone()),
                    )
                    .child(
                        h_flex()
                            .gap_2()
                            .child(Spinner::new().small())
                            .child(div().text_sm().text_color(theme.muted_foreground).child("Waiting for confirmation…")),
                    )
                    .child(
                        h_flex()
                            .gap_2()
                            .child(
                                Button::new("grok-open")
                                    .outline()
                                    .small()
                                    .icon(IconName::ExternalLink)
                                    .label("Open xAI sign-in")
                                    .on_click(move |_, _, cx| cx.open_url(&url)),
                            )
                            .child(
                                Button::new("grok-cancel")
                                    .ghost()
                                    .small()
                                    .label("Cancel")
                                    .on_click(cx.listener(|this, _, _, cx| this.cancel(cx))),
                            ),
                    )
            }
        };
        v_flex()
            .gap_4()
            .p_6()
            .rounded(theme.radius_lg)
            .border_1()
            .border_color(theme.border)
            .child(
                div()
                    .text_lg()
                    .font_weight(gpui_kit::FontWeight::SEMIBOLD)
                    .child("Connect your Grok account"),
            )
            .child(body)
    }
}
