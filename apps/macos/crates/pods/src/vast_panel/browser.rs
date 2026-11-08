//! The offer browser: the search filters, and one card per offer with what
//! it costs and how fast its disk and network are.

use artsnack_backend::api::vast_backends::{GpuType, Offer, OfferSort};
use gpui_kit::{
    AnyElement, Context, FontWeight, IntoElement, ParentElement as _, SharedString, Styled as _,
    assets::IconName,
    component::{
        ActiveTheme as _, Disableable as _, Icon, Selectable as _, Sizable as _,
        button::{Button, ButtonGroup},
        h_flex,
        input::NumberInput,
        scroll::ScrollableElement as _,
        select::Select,
        tag::Tag,
        v_flex,
    },
    div,
    prelude::FluentBuilder as _,
    rems,
};

use super::{
    ANY_GPU, DEFAULT_DISK_GB, FormBusy, GPU_COUNTS, MAX_DISK_GB, MAX_HOURLY_USD, MIN_DISK_GB,
    VastBackendPanel,
};
use crate::{
    controls::{GpuChoice, card, field, note, with_tooltip},
    format::{grouped, mb_per_second, plain_number, usd},
};

impl VastBackendPanel {
    pub(super) fn render_browser(&self, cx: &mut Context<Self>) -> AnyElement {
        let busy = self.form_busy.is_some();
        let searching = self.form_busy == Some(FormBusy::Search);
        let theme = cx.theme();
        let muted = theme.muted_foreground;

        let count_buttons = GPU_COUNTS.map(|count| {
            Button::new(("vast-gpu-count", count as usize))
                .label(format!("{count}\u{d7}"))
                .selected(self.num_gpus == count)
        });
        let sort_buttons = OfferSort::ALL.map(|sort| {
            Button::new(sort.label())
                .label(sort.label())
                .selected(self.sort == sort)
        });

        let filters = div()
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
                        .placeholder("Choose a GPU")
                        .search_placeholder("Search GPUs"),
                    cx,
                )
                .col_span(2),
            )
            .child(field(
                "Number of GPUs",
                ButtonGroup::new("vast-gpu-count")
                    .small()
                    .outline()
                    .children(count_buttons)
                    .on_click(cx.listener(|this, selected: &Vec<usize>, _, cx| {
                        if let Some(count) = selected.first().and_then(|ix| GPU_COUNTS.get(*ix)) {
                            this.num_gpus = *count;
                            cx.notify();
                        }
                    })),
                cx,
            ))
            .child(
                field("Local disk (GB)", NumberInput::new(&self.disk).small(), cx)
                    .child(note("Fixed at creation; destroy wipes it.", cx)),
            )
            .child(
                field(
                    "Minimum disk speed (MB/s)",
                    NumberInput::new(&self.min_disk_speed).small(),
                    cx,
                )
                .child(note("Set 0 to include every local disk.", cx)),
            )
            .child(field(
                "Minimum download (Mbps)",
                NumberInput::new(&self.min_download).small(),
                cx,
            ))
            .child(field(
                "Minimum reliability (%)",
                NumberInput::new(&self.min_reliability).small(),
                cx,
            ))
            .child(
                field(
                    "Maximum hourly rent: GPU + disk ($/hr)",
                    NumberInput::new(&self.max_price).small(),
                    cx,
                )
                .child(note(
                    format!("Server safety cap: {}/hr.", usd(MAX_HOURLY_USD)),
                    cx,
                )),
            )
            .child(
                field(
                    "Sort offers",
                    ButtonGroup::new("vast-sort")
                        .small()
                        .outline()
                        .children(sort_buttons)
                        .on_click(cx.listener(|this, selected: &Vec<usize>, _, cx| {
                            if let Some(sort) =
                                selected.first().and_then(|ix| OfferSort::ALL.get(*ix))
                            {
                                this.sort = *sort;
                                cx.notify();
                            }
                        })),
                    cx,
                )
                .col_span(2),
            )
            .child(
                div().col_span(2).flex().items_end().child(
                    Button::new("find-offers")
                        .small()
                        .w_full()
                        .icon(IconName::Search)
                        .label("Find current offers")
                        .loading(searching)
                        .disabled(busy)
                        .on_click(cx.listener(|this, _, window, cx| this.search(window, cx))),
                ),
            );

        let offers_count = self.offers.len();
        let summary = h_flex()
            .flex_wrap()
            .justify_between()
            .gap_2()
            .child(div().text_sm().text_color(muted).child(format!(
                "{offers_count} on-demand offer{}; hourly rent includes the searched {} GB disk. Bandwidth is listed separately.",
                if offers_count == 1 { "" } else { "s" },
                plain_number(self.offers_disk_gb)
            )))
            .child(
                h_flex()
                    .gap_3()
                    .text_xs()
                    .text_color(muted)
                    .when_some(self.credit, |this, credit| {
                        this.child(format!("Vast credit: {}", usd(credit)))
                    })
                    .child(
                        h_flex()
                            .gap_1()
                            .child(Icon::new(IconName::ShieldCheck).size_3p5())
                            .child("Verified hosts only"),
                    )
                    .child(
                        Button::new("refresh-offers")
                            .xsmall()
                            .outline()
                            .icon(IconName::RefreshCw)
                            .label("Refresh offers")
                            .loading(searching)
                            .disabled(busy)
                            .on_click(cx.listener(|this, _, window, cx| this.search(window, cx))),
                    ),
            );

        let cards: Vec<AnyElement> = self
            .offers
            .iter()
            .map(|offer| self.render_offer(offer, busy, cx))
            .collect();
        // Capped by a wrapper column, as in the launch dialog's model list:
        // `max_h` on the scrolled element itself clips it without scrolling.
        let list = v_flex()
            .flex_1()
            .gap_2()
            .children(cards)
            .when(!searching && self.offers.is_empty(), |this| {
                this.child(
                    div()
                        .p_8()
                        .rounded(cx.theme().radius_lg)
                        .border_1()
                        .border_dashed()
                        .border_color(cx.theme().border)
                        .text_center()
                        .text_sm()
                        .text_color(muted)
                        .child("No matching offers. Try \u{201c}Any GPU\u{201d}, a slower disk, or a higher price cap."),
                )
            })
            .overflow_y_scrollbar();

        v_flex()
            .gap_4()
            .child(filters)
            .child(summary)
            .child(v_flex().max_h(rems(26.)).child(list))
            .into_any_element()
    }

    fn render_offer(&self, offer: &Offer, busy: bool, cx: &mut Context<Self>) -> AnyElement {
        let muted = cx.theme().muted_foreground;
        let id = offer.id.round() as u64;
        let compatible = offer.compatible;
        let chosen = offer.clone();
        card(cx)
            .gap_3()
            .when(!compatible, |this| this.opacity(0.6))
            .child(
                h_flex()
                    .items_start()
                    .justify_between()
                    .gap_4()
                    .child(
                        v_flex()
                            .min_w_0()
                            .gap_1p5()
                            .child(div().font_weight(FontWeight::SEMIBOLD).child(format!(
                                "{}\u{d7} {}",
                                offer.num_gpus.round() as u32,
                                offer.gpu_name
                            )))
                            .child(
                                h_flex()
                                    .flex_wrap()
                                    .gap_1p5()
                                    .child(Tag::secondary().outline().small().child(format!(
                                        "{} GB VRAM",
                                        (offer.gpu_ram_mb / 1024.0).round() as u64
                                    )))
                                    .child(
                                        if compatible {
                                            Tag::secondary()
                                        } else {
                                            Tag::danger()
                                        }
                                        .small()
                                        .child(
                                            if offer.cuda_max > 0.0 {
                                                format!("CUDA {}", plain_number(offer.cuda_max))
                                            } else {
                                                "CUDA ?".to_string()
                                            },
                                        ),
                                    )
                                    .child(Tag::secondary().outline().small().child(format!(
                                        "{:.1}% reliable",
                                        offer.reliability * 100.0
                                    ))),
                            ),
                    )
                    .child(
                        v_flex()
                            .flex_shrink_0()
                            .items_end()
                            .child(
                                div()
                                    .text_lg()
                                    .font_weight(FontWeight::SEMIBOLD)
                                    .child(format!("{}/hr", usd(offer.hourly_usd))),
                            )
                            .child(note(
                                format!(
                                    "including {} GB disk; traffic separate",
                                    plain_number(self.offers_disk_gb)
                                ),
                                cx,
                            )),
                    ),
            )
            .child(
                div()
                    .grid()
                    .grid_cols(4)
                    .gap_x_4()
                    .gap_y_1()
                    .text_sm()
                    .text_color(muted)
                    .child(with_tooltip(
                        ("offer-disk", id as usize),
                        offer.disk_name.clone(),
                        offer_fact(
                            IconName::HardDrive,
                            mb_per_second(offer.disk_bandwidth_mbps),
                        ),
                    ))
                    .child(offer_fact(
                        IconName::Network,
                        format!(
                            "\u{2193} {} \u{b7} \u{2191} {} Mbps",
                            grouped(offer.download_mbps),
                            grouped(offer.upload_mbps)
                        ),
                    ))
                    .child(offer_fact(IconName::MapPin, offer.location.clone()))
                    .child(offer_fact(
                        IconName::Zap,
                        format!(
                            "{:.1} DLPerf \u{b7} {:.1}/$",
                            offer.dlperf, offer.dlperf_per_dollar
                        ),
                    )),
            )
            .when_some(
                offer.incompatibility_reason.clone().filter(|_| !compatible),
                |this, reason| {
                    this.child(div().text_sm().text_color(cx.theme().danger).child(reason))
                },
            )
            .child(
                h_flex()
                    .justify_between()
                    .gap_3()
                    .pt_3()
                    .border_t_1()
                    .border_color(cx.theme().border)
                    .child(
                        v_flex()
                            .text_xs()
                            .text_color(muted)
                            .child(format!(
                                "Disk: {} \u{b7} {} GB available \u{b7} storage portion {}/hr",
                                offer.disk_name,
                                offer.disk_space_gb.round() as u64,
                                usd(offer.storage_hourly_usd)
                            ))
                            .child(format!(
                                "Bandwidth: \u{2193} {}/TB \u{b7} \u{2191} {}/TB",
                                usd(offer.download_cost_per_tb_usd),
                                usd(offer.upload_cost_per_tb_usd)
                            )),
                    )
                    .child(
                        // One per offer: a list of primary buttons would leave no
                        // default commit to see.
                        Button::new(("rent-offer", id as usize))
                            .small()
                            .label("Rent\u{2026}")
                            .disabled(busy || !compatible)
                            .on_click(cx.listener(move |this, _, window, cx| {
                                this.choose(chosen.clone(), window, cx)
                            })),
                    ),
            )
            .into_any_element()
    }
}

fn offer_fact(icon: IconName, text: String) -> impl IntoElement {
    h_flex()
        .min_w_0()
        .gap_1p5()
        .child(Icon::new(icon).size_3p5().flex_shrink_0())
        .child(div().truncate().child(text))
}

/// `clampVastDiskGb`: what the server will actually allocate.
pub(super) fn clamp_disk_gb(value: f64) -> f64 {
    if value.is_finite() {
        value.round().clamp(MIN_DISK_GB, MAX_DISK_GB)
    } else {
        DEFAULT_DISK_GB
    }
}

/// "Any GPU" and every type, with "Datacenter · 80 GB VRAM · …" under each.
/// `current` is kept as a choice even before the catalogue lists it.
pub(super) fn gpu_choices(types: &[GpuType], current: &str) -> Vec<GpuChoice> {
    let mut choices = vec![GpuChoice {
        value: ANY_GPU.into(),
        name: "Any GPU".into(),
        description: "Search every GPU model".into(),
    }];
    choices.extend(types.iter().map(|gpu| GpuChoice {
        value: gpu.name.clone().into(),
        name: gpu.name.clone().into(),
        description: gpu_description(gpu).into(),
    }));
    if current != ANY_GPU && !types.iter().any(|gpu| gpu.name == current) {
        choices.push(GpuChoice {
            value: current.to_string().into(),
            name: current.to_string().into(),
            description: SharedString::default(),
        });
    }
    choices
}

fn gpu_description(gpu: &GpuType) -> String {
    let mut parts = Vec::new();
    let mut category = gpu.category.chars();
    if let Some(first) = category.next() {
        parts.push(first.to_uppercase().chain(category).collect::<String>());
    }
    if gpu.gpu_ram_mb > 0.0 {
        parts.push(format!(
            "{} GB VRAM",
            (gpu.gpu_ram_mb / 1024.0).round() as u64
        ));
    }
    if gpu.compute_capability > 0.0 {
        parts.push(format!("Compute capability {:.1}", gpu.compute_capability));
    }
    if gpu.cuda_cores > 0.0 {
        parts.push(format!("{} CUDA cores", grouped(gpu.cuda_cores)));
    }
    if let Some(watts) = gpu.max_power_watts.filter(|watts| *watts > 0.0) {
        parts.push(format!("{} W", plain_number(watts)));
    }
    parts.join(" \u{b7} ")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clamps_the_searched_disk_like_the_server() {
        assert_eq!(clamp_disk_gb(12.0), MIN_DISK_GB);
        assert_eq!(clamp_disk_gb(300.4), 300.0);
        assert_eq!(clamp_disk_gb(5000.0), MAX_DISK_GB);
        assert_eq!(clamp_disk_gb(f64::NAN), DEFAULT_DISK_GB);
    }

    #[test]
    fn describes_a_gpu_type() {
        let gpu = GpuType {
            name: "H100 SXM".into(),
            gpu_ram_mb: 81920.0,
            compute_capability: 9.0,
            cuda_cores: 16896.0,
            max_power_watts: Some(700.0),
            architecture: "Hopper".into(),
            category: "datacenter".into(),
        };
        assert_eq!(
            gpu_description(&gpu),
            "Datacenter \u{b7} 80 GB VRAM \u{b7} Compute capability 9.0 \u{b7} 16,896 CUDA cores \u{b7} 700 W"
        );
        assert_eq!(gpu_description(&GpuType::named("A40".into())), "");
    }

    #[test]
    fn keeps_the_current_gpu_before_the_catalogue_lists_it() {
        let choices = gpu_choices(&[], "H100 SXM");
        assert_eq!(choices.len(), 2);
        assert_eq!(choices[0].value.as_ref(), ANY_GPU);
        assert_eq!(choices[1].value.as_ref(), "H100 SXM");
        assert_eq!(gpu_choices(&[], ANY_GPU).len(), 1);
    }
}
