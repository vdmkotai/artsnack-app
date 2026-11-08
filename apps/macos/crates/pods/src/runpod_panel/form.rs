//! The rent form: the GPU and where it runs, the disks, the price ceiling,
//! and the summary of what "Rent…" would rent.

use artsnack_backend::api::runpod_backend_store::{CloudType, TemplateProfile};
use gpui_kit::{
    AnyElement, Context, FontWeight, IntoElement, ParentElement as _, Styled as _,
    assets::IconName,
    component::{
        ActiveTheme as _, Disableable as _, Icon, Selectable as _, Sizable as _,
        alert::Alert,
        button::{Button, ButtonGroup, ButtonVariants as _},
        h_flex,
        input::NumberInput,
        select::Select,
        tag::Tag,
        v_flex,
    },
    div,
    prelude::FluentBuilder as _,
};

use super::{
    FormBusy, GPU_COUNTS, MAX_HOURLY_USD, RunpodBackendPanel,
    catalog::{is_offered, is_rentable},
};
use crate::{
    controls::{card, field, note, number_value},
    format::{plain_number, usd},
};

impl RunpodBackendPanel {
    pub(super) fn render_form(&self, cx: &mut Context<Self>) -> AnyElement {
        let video = self.is_video();
        let gpu = self.selected_gpu();
        let availability = self.availability();
        let hourly = self.hourly_usd();
        let counts: Vec<u32> = availability
            .map(|availability| {
                availability
                    .available_gpu_counts
                    .iter()
                    .map(|count| count.round() as u32)
                    .collect()
            })
            .unwrap_or_default();
        let busy = self.form_busy.is_some();
        let theme = cx.theme();
        let (muted, danger) = (theme.muted_foreground, theme.danger);

        let cloud_buttons = [CloudType::Secure, CloudType::Community].map(|cloud| {
            let unsold = gpu.filter(|gpu| !is_offered(gpu.availability(cloud)));
            let tooltip = match (unsold, cloud) {
                (Some(gpu), _) => {
                    format!("No {} for rent in this cloud right now", gpu.display_name)
                }
                (None, CloudType::Secure) => {
                    "RunPod\u{2019}s own Tier 3/4 datacenters: steadier, a bit pricier".into()
                }
                (None, CloudType::Community) => {
                    "Vetted third-party hosts: cheaper, more variable".into()
                }
            };
            Button::new(match cloud {
                CloudType::Secure => "cloud-secure",
                CloudType::Community => "cloud-community",
            })
            .label(cloud.label())
            .selected(self.cloud == cloud)
            .disabled(unsold.is_some())
            .tooltip(tooltip)
        });
        let count_buttons = GPU_COUNTS.map(|count| {
            Button::new(("gpu-count", count as usize))
                .label(format!("{count}\u{d7}"))
                .selected(self.gpu_count == count)
                .disabled(!counts.is_empty() && !counts.contains(&count))
                .when(video, |this| {
                    this.tooltip(format!(
                        "{count} GPU{}, one clip each",
                        if count > 1 { "s" } else { "" }
                    ))
                })
        });
        let template_buttons =
            [TemplateProfile::Cuda13_0, TemplateProfile::Cuda12_8].map(|profile| {
                Button::new(profile.as_str())
                    .label(format!("CUDA {}", profile.cuda_version()))
                    .selected(self.template == profile)
            });

        // Four columns; the refresh button takes what is left of the last row.
        let cells_before_refresh = 4 + if video { 5 } else { 6 };
        let refresh_span = (4 - cells_before_refresh % 4) as u16;

        let form = div()
            .grid()
            .grid_cols(4)
            .gap_3()
            .p_4()
            .rounded(theme.radius_lg)
            .border_1()
            .border_color(theme.border)
            .child(
                field(
                    "GPU model",
                    Select::new(&self.gpu_select)
                        .placeholder(if self.form_busy == Some(FormBusy::Catalog) {
                            "Loading current GPUs\u{2026}"
                        } else {
                            "Choose a GPU"
                        })
                        .search_placeholder("Search GPUs"),
                    cx,
                )
                .col_span(2),
            )
            .child(
                field(
                    "Cloud",
                    ButtonGroup::new("cloud")
                        .small()
                        .outline()
                        .children(cloud_buttons)
                        .on_click(cx.listener(|this, selected: &Vec<usize>, _, cx| {
                            if let Some(ix) = selected.first() {
                                this.cloud = if *ix == 0 {
                                    CloudType::Secure
                                } else {
                                    CloudType::Community
                                };
                                cx.notify();
                            }
                        })),
                    cx,
                )
                .when_some(gpu.filter(|gpu| !is_rentable(gpu)), |this, gpu| {
                    this.child(div().text_xs().text_color(danger).child(format!(
                        "RunPod has no free {} in either cloud right now \u{2014} pick another GPU or refresh later.",
                        gpu.display_name
                    )))
                }),
            )
            .child(
                field(
                    if video { "Clips at once" } else { "Number of GPUs" },
                    ButtonGroup::new("gpu-count")
                        .small()
                        .outline()
                        .children(count_buttons)
                        .on_click(cx.listener(|this, selected: &Vec<usize>, _, cx| {
                            if let Some(count) = selected.first().and_then(|ix| GPU_COUNTS.get(*ix))
                            {
                                this.gpu_count = *count;
                                cx.notify();
                            }
                        })),
                    cx,
                )
                .when(video, |this| {
                    let pace = if self.gpu_count > 1 {
                        format!("{} clips render side by side", self.gpu_count)
                    } else {
                        "clips render one after another".to_string()
                    };
                    let total = if hourly > 0.0 {
                        format!(" \u{b7} {}/hr in total", usd(hourly))
                    } else {
                        String::new()
                    };
                    this.child(note(
                        format!("One GPU per clip: {pace}{total}. A single clip is not faster."),
                        cx,
                    ))
                }),
            )
            .when(!video, |this| {
                this.child(field(
                    "ComfyUI image",
                    ButtonGroup::new("template")
                        .small()
                        .outline()
                        .children(template_buttons)
                        .on_click(cx.listener(|this, selected: &Vec<usize>, _, cx| {
                            if let Some(ix) = selected.first() {
                                this.template = if *ix == 0 {
                                    TemplateProfile::Cuda13_0
                                } else {
                                    TemplateProfile::Cuda12_8
                                };
                                cx.notify();
                            }
                        })),
                    cx,
                ))
            })
            .child(
                field(
                    "Disposable container disk (GB)",
                    NumberInput::new(&self.container_disk).small(),
                    cx,
                )
                .child(note("Fast local disk; stop or destroy wipes it.", cx)),
            )
            .child(
                field(
                    "Persistent volume disk (GB)",
                    NumberInput::new(&self.volume_disk).small(),
                    cx,
                )
                .child(note("0 means no volume, matching your current workflow.", cx)),
            )
            .child(field(
                "Minimum disk speed (MB/s)",
                NumberInput::new(&self.min_disk_speed).small(),
                cx,
            ))
            .child(field(
                "Minimum download (Mbps)",
                NumberInput::new(&self.min_download).small(),
                cx,
            ))
            .child(
                field(
                    "Maximum total GPU price ($/hr)",
                    NumberInput::new(&self.max_price).small(),
                    cx,
                )
                .child(note(
                    format!("Server safety cap: {}/hr.", usd(MAX_HOURLY_USD)),
                    cx,
                )),
            )
            .child(
                div().col_span(refresh_span).flex().items_end().child(
                    Button::new("refresh-catalog")
                        .outline()
                        .small()
                        .w_full()
                        .icon(IconName::RefreshCw)
                        .label("Refresh current availability and prices")
                        .loading(self.form_busy == Some(FormBusy::Catalog))
                        .disabled(busy)
                        .on_click(cx.listener(|this, _, window, cx| {
                            this.load_catalog(None, window, cx)
                        })),
                ),
            );

        let summary = gpu.zip(availability).map(|(gpu, availability)| {
            let offered = is_offered(availability);
            let rentable = !busy && self.rent_blocker(cx).is_none();
            card(cx)
                .child(
                    h_flex()
                        .items_start()
                        .justify_between()
                        .gap_4()
                        .child(
                            v_flex()
                                .min_w_0()
                                .gap_1p5()
                                .child(
                                    div()
                                        .text_lg()
                                        .font_weight(FontWeight::SEMIBOLD)
                                        .child(gpu.display_name.clone()),
                                )
                                .child(
                                    h_flex()
                                        .flex_wrap()
                                        .gap_1p5()
                                        .child(Tag::secondary().outline().small().child(format!(
                                            "{} GB VRAM",
                                            plain_number(gpu.memory_in_gb)
                                        )))
                                        .child(Tag::secondary().outline().small().child(format!(
                                            "{} stock",
                                            availability.stock_status
                                        )))
                                        .child(Tag::secondary().small().child(self.cloud.label())),
                                ),
                        )
                        .child(if offered {
                            v_flex()
                                .flex_shrink_0()
                                .items_end()
                                .child(
                                    div()
                                        .text_lg()
                                        .font_weight(FontWeight::SEMIBOLD)
                                        .child(format!("{}/hr", usd(hourly))),
                                )
                                .child(note(
                                    format!(
                                        "{}/GPU/hr; disk adjustments shown by RunPod after placement",
                                        usd(hourly / self.gpu_count as f64)
                                    ),
                                    cx,
                                ))
                                .into_any_element()
                        } else {
                            div()
                                .flex_shrink_0()
                                .text_color(danger)
                                .child("Unavailable")
                                .into_any_element()
                        }),
                )
                .child(
                    h_flex()
                        .justify_between()
                        .gap_3()
                        .child(
                            h_flex()
                                .gap_2()
                                .text_sm()
                                .text_color(muted)
                                .child(Icon::new(IconName::HardDrive).size_4())
                                .child(format!(
                                    "{} GB disposable + {} GB persistent",
                                    plain_number(number_value(&self.container_disk, cx)),
                                    plain_number(number_value(&self.volume_disk, cx)),
                                )),
                        )
                        .child(
                            Button::new("rent-runpod")
                                .primary()
                                .label("Rent\u{2026}")
                                .disabled(!rentable)
                                .on_click(cx.listener(|this, _, window, cx| {
                                    this.open_launch(window, cx)
                                })),
                        ),
                )
        });

        v_flex()
            .gap_4()
            .when_some(self.visible_error(), |this, error| {
                this.child(Alert::error("runpod-error", error))
            })
            .child(form)
            .children(summary)
            .child(
                h_flex()
                    .justify_between()
                    .gap_3()
                    .text_xs()
                    .text_color(muted)
                    .child(format!(
                        "{} GPU types \u{b7} prices are live starting prices and rechecked before launch",
                        self.gpus.len()
                    ))
                    .when_some(self.balance, |this, balance| {
                        this.child(format!("RunPod credit: {}", usd(balance)))
                    }),
            )
            .into_any_element()
    }
}
