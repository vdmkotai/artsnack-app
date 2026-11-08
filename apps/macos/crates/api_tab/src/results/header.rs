//! The grid's chrome: the header (spend, running jobs, Remove all failed,
//! selection, preview size, filters), the fal billing banner, the empty and
//! loading states, and the selection bar.

use artsnack_backend::PaginationStatus;
use artsnack_settings::Preferences;
use artsnack_ui::{ZoomControl, ZoomScale};
use gpui_kit::{
    AnyElement, App, Context, FontWeight, InteractiveElement as _, IntoElement, ParentElement as _,
    SharedString, StatefulInteractiveElement as _, Styled as _,
    assets::IconName,
    component::{
        ActiveTheme as _, Disableable as _, Selectable as _, Sizable as _,
        alert::Alert,
        button::{Button, ButtonGroup, ButtonVariants as _, Toggle, ToggleVariants as _},
        h_flex,
        skeleton::Skeleton,
        spinner::Spinner,
        text::TextView,
        tooltip::Tooltip,
        v_flex,
    },
    div,
    prelude::FluentBuilder as _,
    rems,
};

use super::{
    ApiResults, PREVIEW_SCALE,
    content::{Filters, MediaFilter, ModelFilter},
    meta::{format_credits, format_usd},
};

/// Shapes for the first page's placeholder.
const SKELETON_ASPECTS: [f32; 8] = [1.0, 0.75, 1.33, 1.0, 0.56, 1.0, 0.75, 1.33];

/// Muted figures with an explanation on hover.
fn figure(id: &'static str, text: String, tip: &'static str, cx: &App) -> impl IntoElement {
    div()
        .id(id)
        .text_xs()
        .text_color(cx.theme().muted_foreground)
        .child(text)
        .tooltip(move |window, cx| Tooltip::new(tip).build(window, cx))
}

impl ApiResults {
    pub(super) fn render_header(&self, scale: f32, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = cx.theme();
        let content = self.content.clone();
        let totals = content.totals;
        let selecting = self.is_selecting();
        // Every selected row is on screen: a selection is made from the rows
        // shown, and a change of what is shown drops the rest (`rebuild`).
        let selected = self.selection.len();
        let view = cx.entity().downgrade();

        let running = (content.pending > 0).then(|| {
            let mut text = format!("{} generating", content.pending);
            if totals.pending_usd > 0.0 {
                text.push_str(&format!(" · {}", format_usd(totals.pending_usd)));
            }
            if totals.pending_credits > 0.0 {
                text.push_str(&format!(
                    " · {} credits",
                    format_credits(totals.pending_credits)
                ));
            }
            h_flex()
                .gap_1p5()
                .text_xs()
                .text_color(theme.muted_foreground)
                .child(Spinner::new().xsmall())
                .child(text)
        });

        let top = h_flex()
            .flex_wrap()
            .justify_between()
            .gap_3()
            .child(
                h_flex()
                    .gap_2()
                    .child(
                        div()
                            .text_lg()
                            .font_weight(FontWeight::SEMIBOLD)
                            .child("Results"),
                    )
                    .when(totals.spent_usd > 0.0, |this| {
                        this.child(figure(
                            "spent-usd",
                            format!("{} spent", format_usd(totals.spent_usd)),
                            "Spent on the fal and Atlas results loaded here",
                            cx,
                        ))
                    })
                    .when(totals.spent_credits > 0.0, |this| {
                        this.child(figure(
                            "spent-credits",
                            format!("{} credits", format_credits(totals.spent_credits)),
                            "Higgsfield credits for the results loaded here",
                            cx,
                        ))
                    }),
            )
            .child(
                h_flex()
                    .flex_wrap()
                    .gap_2()
                    .children(running)
                    .when(content.failed_loaded > 0, |this| {
                        this.child(
                            Button::new("remove-failed")
                                .small()
                                .outline()
                                .text_color(theme.danger)
                                .icon(IconName::Trash)
                                .label("Remove all failed")
                                .loading(self.removing_failed)
                                .disabled(self.removing_failed)
                                .on_click(cx.listener(|this, _, window, cx| {
                                    this.remove_all_failed(window, cx)
                                })),
                        )
                    })
                    .when(selecting && selected < content.rows.len(), |this| {
                        this.child(
                            Button::new("select-all")
                                .small()
                                .ghost()
                                .icon(IconName::CheckCheck)
                                .label(format!("Select all {}", content.rows.len()))
                                .on_click(cx.listener(|this, _, _, cx| this.select_all(cx))),
                        )
                    })
                    .when(!content.rows.is_empty(), |this| {
                        this.child(
                            Button::new("select")
                                .small()
                                .when(selecting, |button| button.secondary())
                                .when(!selecting, |button| button.outline())
                                .label(if selecting { "Cancel" } else { "Select" })
                                .on_click(cx.listener(|this, _, window, cx| {
                                    this.toggle_selection_mode(window, cx)
                                })),
                        )
                    })
                    .child(
                        ZoomControl::new("preview-zoom", scale, ZoomScale::TILES, "previews")
                            .on_change(move |factor, _, cx| {
                                Preferences::set(cx, &PREVIEW_SCALE, factor);
                                let _ = view.update(cx, |_, cx| cx.notify());
                            }),
                    ),
            );

        v_flex()
            .gap_2()
            .px_4()
            .py_3()
            .border_b_1()
            .border_color(theme.border)
            .child(top)
            .when(!self.rows.is_empty(), |this| {
                this.child(self.render_filters(cx))
            })
    }

    /// Liked, media and model. Client-side over the loaded rows, not saved.
    fn render_filters(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let filters = self.filters.clone();
        let content = self.content.clone();

        let media = [
            (MediaFilter::All, "All"),
            (MediaFilter::Images, "Images"),
            (MediaFilter::Videos, "Videos"),
        ];
        let media_group = ButtonGroup::new("media-filter")
            .small()
            .outline()
            .children(media.iter().map(|(filter, label)| {
                Button::new(*label)
                    .label(*label)
                    .selected(filters.media == *filter)
            }))
            .on_click(cx.listener(move |this, selected: &Vec<usize>, _, cx| {
                let media = selected
                    .first()
                    .and_then(|ix| media.get(*ix))
                    .map(|(filter, _)| *filter)
                    .unwrap_or_default();
                let filters = Filters {
                    media,
                    ..this.filters.clone()
                };
                this.set_filters(filters, cx);
            }));

        // Chips for the models in the loaded rows only: the whole registry
        // would offer chips that can only come back empty. The active chip
        // stays, so a filter never becomes unclearable when its last row goes.
        let mut models: Vec<(ModelFilter, SharedString)> =
            vec![(ModelFilter::All, "All models".into())];
        for chip in self.model_chips.iter() {
            let filter = ModelFilter::Model(chip.id.clone());
            if content.models_present.contains(&chip.id) || filters.model == filter {
                models.push((filter, chip.badge.clone().into()));
            }
        }
        if content.has_atlas || filters.model == ModelFilter::Atlas {
            models.push((ModelFilter::Atlas, "Atlas".into()));
        }
        if content.has_self_hosted_video || filters.model == ModelFilter::SelfHostedVideo {
            models.push((ModelFilter::SelfHostedVideo, "Self-hosted video".into()));
        }
        let model_group = ButtonGroup::new("model-filter")
            .small()
            .outline()
            .flex_wrap()
            .children(models.iter().enumerate().map(|(ix, (filter, label))| {
                Button::new(("model", ix))
                    .label(label.clone())
                    .selected(filters.model == *filter)
            }))
            .on_click(cx.listener(move |this, selected: &Vec<usize>, _, cx| {
                let model = selected
                    .first()
                    .and_then(|ix| models.get(*ix))
                    .map(|(filter, _)| filter.clone())
                    .unwrap_or_default();
                let filters = Filters {
                    model,
                    ..this.filters.clone()
                };
                this.set_filters(filters, cx);
            }));

        h_flex()
            .flex_wrap()
            .gap_2()
            .child(
                Toggle::new("liked")
                    .small()
                    .outline()
                    .icon(IconName::Heart)
                    .label("Liked")
                    .checked(filters.liked)
                    .tooltip(if filters.liked {
                        "Show all results"
                    } else {
                        "Show only liked results"
                    })
                    .on_click(cx.listener(|this, liked: &bool, _, cx| {
                        let filters = Filters {
                            liked: *liked,
                            ..this.filters.clone()
                        };
                        this.set_filters(filters, cx);
                    })),
            )
            .child(media_group)
            .child(model_group)
    }

    /// A drained fal balance fails every later fal request, so it is called
    /// out above the grid rather than left on one tile.
    pub(super) fn render_billing_banner(&self) -> Option<AnyElement> {
        self.content.billing_failure.then(|| {
            div()
                .px_4()
                .pt_3()
                .child(
                    Alert::error(
                        "fal-billing",
                        TextView::markdown(
                            "fal-billing-text",
                            "Top up at [fal.ai/dashboard/billing](https://fal.ai/dashboard/billing) \u{2014} \
                             Seedream and Seedance requests will keep failing until you do. Grok is unaffected.",
                        ),
                    )
                    .title("fal balance exhausted"),
                )
                .into_any_element()
        })
    }

    /// No tiles: loading, failed, nothing yet, or nothing the filters let
    /// through.
    pub(super) fn render_empty(&self, cx: &mut Context<Self>) -> AnyElement {
        let theme = cx.theme();
        if self.rows.is_empty() && self.status == PaginationStatus::LoadingFirstPage {
            return h_flex()
                .flex_1()
                .min_h_0()
                .px_4()
                .pt_3()
                .flex_wrap()
                .content_start()
                .items_start()
                .gap_1p5()
                .overflow_hidden()
                .children(SKELETON_ASPECTS.iter().map(|aspect| {
                    Skeleton::new()
                        .w(rems(13.75))
                        .h(rems(13.75 / aspect))
                        .rounded(theme.radius)
                }))
                .into_any_element();
        }
        let filtered = self.filters.is_active();
        let (title, body): (&str, SharedString) = if self.status == PaginationStatus::Failed {
            (
                "Couldn\u{2019}t load the results",
                self.generations
                    .read(cx)
                    .error()
                    .cloned()
                    .unwrap_or_default(),
            )
        } else if filtered {
            // Filtering covers the loaded rows only, so an empty grid usually
            // means "not loaded yet", not "never made".
            let more = matches!(
                self.status,
                PaginationStatus::CanLoadMore | PaginationStatus::LoadingMore
            );
            (
                "Nothing here matches",
                if more {
                    "Older results are still loading.".into()
                } else {
                    "No loaded result matches these filters.".into()
                },
            )
        } else {
            ("No results yet", "Generated media will appear here".into())
        };
        let loading = filtered && self.status == PaginationStatus::LoadingMore;
        v_flex()
            .flex_1()
            .items_center()
            .justify_center()
            .gap_1()
            .child(
                div()
                    .text_lg()
                    .font_weight(FontWeight::SEMIBOLD)
                    .child(title),
            )
            .child(
                h_flex()
                    .gap_2()
                    .text_sm()
                    .text_color(theme.muted_foreground)
                    .when(loading, |this| this.child(Spinner::new().small()))
                    .child(body),
            )
            .when(filtered, |this| {
                this.child(
                    div().pt_2().child(
                        Button::new("clear-filters")
                            .small()
                            .outline()
                            .label("Clear filters")
                            .on_click(cx.listener(|this, _, _, cx| {
                                this.set_filters(Filters::default(), cx)
                            })),
                    ),
                )
            })
            .into_any_element()
    }

    /// The floating bar while rows are selected: the count, Delete, clear.
    pub(super) fn render_selection_bar(&self, cx: &mut Context<Self>) -> Option<AnyElement> {
        if self.selection.is_empty() {
            return None;
        }
        let theme = cx.theme();
        let count = self.selection.len();
        Some(
            h_flex()
                .absolute()
                .bottom_4()
                .left_0()
                .right_0()
                .justify_center()
                .child(
                    h_flex()
                        .gap_2()
                        .px_3()
                        .py_1p5()
                        .rounded_full()
                        .border_1()
                        .border_color(theme.border)
                        .bg(theme.popover)
                        .shadow_lg()
                        .child(div().text_sm().child(format!("{count} selected")))
                        .child(
                            Button::new("delete-selection")
                                .small()
                                .danger()
                                .icon(IconName::Trash)
                                .label("Delete")
                                .loading(self.deleting)
                                .on_click(cx.listener(|this, _, window, cx| {
                                    this.confirm_delete_selection(window, cx)
                                })),
                        )
                        .child(
                            Button::new("clear-selection")
                                .small()
                                .ghost()
                                .icon(IconName::X)
                                .tooltip("Clear selection")
                                .on_click(cx.listener(|this, _, _, cx| this.exit_selection(cx))),
                        ),
                )
                .into_any_element(),
        )
    }
}
