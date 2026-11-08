//! The running pod's card: its state and progress, what it costs, and the
//! buttons that start, stop, refresh and destroy it.

use artsnack_backend::api::{
    runpod_backend_store::RunpodBackend,
    runpod_backends::{BackendState, Provider},
};
use gpui_kit::{
    AnyElement, Context, FontWeight, IntoElement, ParentElement as _, Styled as _,
    assets::IconName,
    component::{
        ActiveTheme as _, Disableable as _, Icon,
        alert::Alert,
        button::{Button, ButtonVariants as _},
        h_flex,
        tag::Tag,
        v_flex,
    },
    div,
    prelude::FluentBuilder as _,
};

use super::{Lifecycle, RunpodBackendPanel};
use crate::{
    controls::{card, destroy_confirmation, facts, progress_block, state_tag},
    format::{plain_number, usd},
};

impl RunpodBackendPanel {
    pub(super) fn render_pod(&self, pod: &RunpodBackend, cx: &mut Context<Self>) -> AnyElement {
        let video = self.is_video();
        let selected = !video
            && self
                .selection
                .read(cx)
                .data()
                .and_then(|selection| selection.as_ref().as_ref().map(|s| s.provider))
                == Some(Provider::Runpod);
        let ready = pod.state == BackendState::Ready;
        let stopped = pod.state == BackendState::Stopped;
        let has_pod_id = pod.pod_id.is_some();
        let num_gpus = pod.num_gpus.round() as u32;
        let mut subtitle = format!("RunPod #{}", pod.pod_id.as_deref().unwrap_or("\u{2026}"));
        if video && num_gpus > 1 && ready {
            let rendering = pod.instance_urls.as_ref().map_or(1, Vec::len);
            subtitle.push_str(&format!(
                " \u{b7} {rendering} of {num_gpus} GPUs rendering \u{2014} up to {rendering} clips at once"
            ));
        }
        let busy = self.lifecycle.is_some();
        let muted = cx.theme().muted_foreground;

        v_flex()
            .gap_4()
            .when_some(self.visible_error(), |this, error| {
                this.child(Alert::error("runpod-error", error))
            })
            .child(
                card(cx)
                    .child(
                        h_flex()
                            .items_start()
                            .justify_between()
                            .gap_4()
                            .child(
                                v_flex()
                                    .min_w_0()
                                    .gap_0p5()
                                    .child(
                                        div()
                                            .text_lg()
                                            .font_weight(FontWeight::SEMIBOLD)
                                            .child(format!("{num_gpus}\u{d7} {}", pod.gpu_name)),
                                    )
                                    .child(div().text_sm().text_color(muted).child(subtitle)),
                            )
                            .child(state_tag(pod.state)),
                    )
                    .child(progress_block("runpod-progress", &pod.message, pod.progress, cx))
                    .child(facts(
                        vec![
                            format!("{}/hr while running", usd(pod.hourly_usd)),
                            format!("{} GB container disk", plain_number(pod.container_disk_gb)),
                            format!("{} GB persistent volume", plain_number(pod.volume_disk_gb)),
                            pod.template_profile.as_str().to_string(),
                        ],
                        cx,
                    ))
                    .when(stopped, |this| {
                        this.child(Alert::warning(
                            "runpod-stopped",
                            "The container disk was wiped when this pod stopped. A configured volume remains and can continue billing until the pod is destroyed.",
                        ))
                    })
                    .child(
                        h_flex()
                            .flex_wrap()
                            .gap_2()
                            .when(!video && ready && !selected, |this| {
                                this.child(
                                    Button::new("use-runpod")
                                        .icon(IconName::CircleCheck)
                                        .label("Use for new generations")
                                        .loading(self.selecting)
                                        .disabled(self.selecting)
                                        .on_click(cx.listener(|this, _, _, cx| {
                                            this.use_for_generations(cx)
                                        })),
                                )
                            })
                            .when(ready && selected, |this| {
                                this.child(
                                    Tag::secondary()
                                        .child(Icon::new(IconName::CircleCheck).size_3())
                                        .child("Selected for generations"),
                                )
                            })
                            .map(|this| {
                                if stopped {
                                    this.child(
                                        Button::new("start-pod")
                                            .icon(IconName::Power)
                                            .label("Start")
                                            .loading(self.lifecycle == Some(Lifecycle::Start))
                                            .disabled(busy)
                                            .on_click(cx.listener(|this, _, _, cx| {
                                                this.control(Lifecycle::Start, cx)
                                            })),
                                    )
                                } else {
                                    this.child(
                                        Button::new("stop-pod")
                                            .outline()
                                            .icon(IconName::Power)
                                            .label("Stop GPU")
                                            .loading(self.lifecycle == Some(Lifecycle::Stop))
                                            .disabled(busy || pod.state == BackendState::Reserving)
                                            .on_click(cx.listener(|this, _, _, cx| {
                                                this.control(Lifecycle::Stop, cx)
                                            })),
                                    )
                                }
                            })
                            .child(
                                Button::new("refresh-pod")
                                    .outline()
                                    .icon(IconName::RefreshCw)
                                    .label("Refresh")
                                    .loading(self.refreshing)
                                    .disabled(self.refreshing || busy || !has_pod_id)
                                    .on_click(cx.listener(|this, _, _, cx| this.refresh_pod(cx))),
                            )
                            .child(
                                Button::new("destroy-pod")
                                    .danger()
                                    .icon(IconName::Trash)
                                    .label("Destroy and stop billing\u{2026}")
                                    .disabled(busy || !has_pod_id)
                                    .on_click(cx.listener(|this, _, _, cx| {
                                        this.confirm_destroy = true;
                                        cx.notify();
                                    })),
                            ),
                    ),
            )
            .when(self.confirm_destroy, |this| {
                this.child(destroy_confirmation(
                    "Permanently destroy this RunPod?",
                    format!(
                        "This deletes its {} GB container disk and any configured volume, then stops all billing.",
                        plain_number(pod.container_disk_gb)
                    ),
                    self.lifecycle == Some(Lifecycle::Destroy),
                    cx.listener(|this, _, _, cx| this.control(Lifecycle::Destroy, cx)),
                    cx.listener(|this, _, _, cx| {
                        this.confirm_destroy = false;
                        cx.notify();
                    }),
                    cx,
                ))
            })
            .into_any_element()
    }
}
