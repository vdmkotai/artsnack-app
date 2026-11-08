//! The running instance's card: its state and progress, what it costs, and
//! the buttons that start, stop, release and destroy it.

use artsnack_backend::api::{
    runpod_backends::{BackendState, Provider},
    vast_backends::VastBackend,
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

use super::{Lifecycle, VastBackendPanel};
use crate::{
    controls::{card, destroy_confirmation, facts, progress_block, state_tag},
    format::{mb_per_second, plain_number, usd},
};

impl VastBackendPanel {
    pub(super) fn render_instance(
        &self,
        instance: &VastBackend,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let selected = self
            .selection
            .read(cx)
            .data()
            .and_then(|selection| selection.as_ref().as_ref().map(|s| s.provider))
            == Some(Provider::Vast);
        let ready = instance.state == BackendState::Ready;
        let stopped = instance.state == BackendState::Stopped;
        let busy = self.lifecycle.is_some();
        let muted = cx.theme().muted_foreground;
        let instance_id = instance
            .instance_id
            .map(|id| format!("{}", id.round() as u64))
            .unwrap_or_else(|| "\u{2026}".into());

        v_flex()
            .gap_4()
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
                                    .child(div().text_lg().font_weight(FontWeight::SEMIBOLD).child(
                                        format!(
                                            "{}\u{d7} {}",
                                            instance.num_gpus.round() as u32,
                                            instance.gpu_name
                                        ),
                                    ))
                                    .child(
                                        div()
                                            .text_sm()
                                            .text_color(muted)
                                            .child(format!("Vast instance #{instance_id}")),
                                    ),
                            )
                            .child(state_tag(instance.state)),
                    )
                    .child(progress_block(
                        "vast-progress",
                        &instance.message,
                        instance.progress,
                        cx,
                    ))
                    .child(facts(
                        vec![
                            format!("{}/hr while running", usd(instance.hourly_usd)),
                            format!("{} GB local disk", plain_number(instance.disk_gb)),
                            format!("{} disk", mb_per_second(instance.disk_bandwidth_mbps)),
                            instance.location.clone(),
                        ],
                        cx,
                    ))
                    .when(stopped, |this| {
                        this.child(Alert::warning(
                            "vast-stopped",
                            format!(
                                "Stopping preserves the local disk, so storage continues to cost roughly {}/hr. Destroy stops all billing and permanently deletes the models.",
                                usd(instance.storage_hourly_usd)
                            ),
                        ))
                    })
                    .when(instance.state == BackendState::Error, |this| {
                        this.child(Alert::error(
                            "vast-cleanup",
                            "Automatic cleanup is retrying in the background. Until this row says destroyed, verify billing in Vast.ai or destroy the instance here.",
                        ))
                    })
                    .child(
                        h_flex()
                            .flex_wrap()
                            .gap_2()
                            .when(ready && !selected, |this| {
                                this.child(
                                    Button::new("use-vast")
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
                            .when(instance.is_launch_uncertain(), |this| {
                                this.child(
                                    Button::new("release-lock")
                                        .outline()
                                        .icon(IconName::Search)
                                        .label("Check Vast.ai and release lock")
                                        .loading(self.lifecycle == Some(Lifecycle::Clear))
                                        .disabled(busy)
                                        .on_click(cx.listener(|this, _, _, cx| {
                                            this.control(Lifecycle::Clear, cx)
                                        })),
                                )
                            })
                            .map(|this| {
                                if stopped {
                                    this.child(
                                        Button::new("start-instance")
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
                                        Button::new("stop-instance")
                                            .outline()
                                            .icon(IconName::Power)
                                            .label("Stop GPU")
                                            .loading(self.lifecycle == Some(Lifecycle::Stop))
                                            .disabled(
                                                busy || instance.state == BackendState::Reserving,
                                            )
                                            .on_click(cx.listener(|this, _, _, cx| {
                                                this.control(Lifecycle::Stop, cx)
                                            })),
                                    )
                                }
                            })
                            .child(
                                Button::new("destroy-instance")
                                    .danger()
                                    .icon(IconName::Trash)
                                    .label("Destroy and stop billing\u{2026}")
                                    .disabled(busy || instance.instance_id.is_none())
                                    .on_click(cx.listener(|this, _, _, cx| {
                                        this.confirm_destroy = true;
                                        cx.notify();
                                    })),
                            ),
                    ),
            )
            .when(self.confirm_destroy, |this| {
                this.child(destroy_confirmation(
                    "Permanently destroy this instance?",
                    format!(
                        "Vast deletes the {} GB local disk immediately. Downloaded models cannot be recovered, and all compute and storage billing stops.",
                        plain_number(instance.disk_gb)
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
