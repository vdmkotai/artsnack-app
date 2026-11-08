//! The pictures waiting on the left and the runs on the right: one card per
//! picture per Describe, with the settings it ran on.

use std::sync::Arc;

use artsnack_backend::api::image_to_prompt::Described;
use gpui_kit::{
    Context, Entity, ImageSource, InteractiveElement as _, IntoElement, ObjectFit,
    ParentElement as _, RenderImage, SharedString, StatefulInteractiveElement as _, Styled as _,
    StyledImage as _, Subscription,
    assets::IconName,
    component::{
        ActiveTheme as _, Disableable as _, Icon, Sizable as _,
        button::{Button, ButtonVariants as _},
        h_flex,
        input::{Textarea, TextareaState},
        spinner::Spinner,
        v_flex,
    },
    div, img,
    prelude::FluentBuilder as _,
    rems,
};

use super::{BatchSettings, DescribePanel};

/// A picture added to the panel. It stays until removed; each Describe runs
/// it again.
pub(super) struct InputImage {
    pub id: u64,
    pub name: SharedString,
    /// Shared with the runs made from it; dropped from the GPU when the last
    /// holder goes.
    pub preview: Arc<RenderImage>,
    pub data_url: Arc<str>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum ItemStatus {
    /// Queued, waiting for a free slot on its model.
    Waiting,
    Running,
    Done,
    Error,
}

/// One description of one picture.
pub(super) struct DescribeItem {
    pub id: u64,
    /// The picture on the left it was made from, which may since have been
    /// removed.
    pub input_id: u64,
    pub name: SharedString,
    pub preview: Arc<RenderImage>,
    pub data_url: Arc<str>,
    /// What it runs (or ran) with.
    pub batch: BatchSettings,
    /// "Kimi K3.1 Pro · Natural description".
    pub label: SharedString,
    pub status: ItemStatus,
    /// Bumped by every request, so an answer to an earlier one is dropped.
    pub attempt: u32,
    /// The prompt, editable once it has come back.
    pub text: Entity<TextareaState>,
    pub error: Option<SharedString>,
    /// "SD tags with weights · Grok 4.6 · $0.0018": how the text came to be.
    pub meta: Option<SharedString>,
    /// Why Grok did not answer, when Atlas did instead.
    pub fallback_reason: Option<SharedString>,
    /// The exact text last saved, so an edit after saving re-enables Save.
    pub saved_text: Option<String>,
    pub saving: bool,
    pub _text_changed: Subscription,
}

impl DescribeItem {
    /// Queued or in flight.
    pub fn is_active(&self) -> bool {
        matches!(self.status, ItemStatus::Waiting | ItemStatus::Running)
    }
}

/// The meta line under a prompt (the web's `describeMeta`). `model_label` is
/// the list's name for the model that answered.
pub(super) fn describe_meta(
    preset_label: &str,
    model_label: &str,
    described: &Described,
) -> String {
    let via = if described.model.provider == "atlas" {
        format!("Atlas · {model_label}")
    } else {
        model_label.to_string()
    };
    let cost = described
        .cost_usd
        .map(|cost| format!(" · ${cost:.4}"))
        .unwrap_or_default();
    format!("{preset_label} · {via}{cost}")
}

impl DescribePanel {
    /// A picture on the left, marked once it has run with the current
    /// settings.
    pub(super) fn render_input(
        &self,
        input: &InputImage,
        described: bool,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        let theme = cx.theme();
        let id = input.id;
        div()
            .id(("describe-input", id))
            .relative()
            .size(rems(5.))
            .flex_shrink_0()
            .child(
                img(ImageSource::Render(input.preview.clone()))
                    .size_full()
                    .rounded(theme.radius)
                    .border_1()
                    .border_color(theme.border)
                    .object_fit(ObjectFit::Cover),
            )
            .when(described, |this| {
                this.child(
                    div()
                        .id(("describe-input-done", id))
                        .absolute()
                        .bottom_1()
                        .left_1()
                        .size_4()
                        .flex()
                        .items_center()
                        .justify_center()
                        .rounded_full()
                        .bg(theme.primary)
                        .text_color(theme.primary_foreground)
                        .child(Icon::new(IconName::Check).xsmall())
                        .tooltip(|window, cx| {
                            gpui_kit::component::tooltip::Tooltip::new(
                                "Described with the current format, model and instructions",
                            )
                            .build(window, cx)
                        }),
                )
            })
            .child(
                div().absolute().top(rems(-0.5)).right(rems(-0.5)).child(
                    Button::new(("describe-input-remove", id))
                        .danger()
                        .xsmall()
                        .icon(IconName::X)
                        .tooltip("Remove")
                        .accessibility_label(format!("Remove {}", input.name))
                        .on_click(cx.listener(move |this, _, window, cx| {
                            this.remove_input(id, window, cx)
                        })),
                ),
            )
    }

    /// A run's card: the thumbnail, then what it runs on and its state or the
    /// editable prompt, then its commands.
    pub(super) fn render_card(
        &self,
        item: &DescribeItem,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        let theme = cx.theme();
        let muted = theme.muted_foreground;
        let id = item.id;
        let trimmed = item.text.read(cx).value().trim().to_string();
        let saved = item.saved_text.as_deref() == Some(trimmed.as_str());
        let done = item.status == ItemStatus::Done;
        let too_long = self.is_instructions_too_long();

        let status: Option<gpui_kit::AnyElement> = match item.status {
            ItemStatus::Waiting => Some(
                div()
                    .text_xs()
                    .text_color(muted)
                    .child("Waiting for a free slot on this model…")
                    .into_any_element(),
            ),
            ItemStatus::Running => Some(
                h_flex()
                    .gap_1p5()
                    .text_xs()
                    .text_color(muted)
                    .child(Spinner::new().xsmall())
                    .child("Looking at the image…")
                    .into_any_element(),
            ),
            ItemStatus::Error => Some(
                div()
                    .text_xs()
                    .text_color(theme.danger)
                    .child(
                        item.error
                            .clone()
                            .unwrap_or_else(|| "Description failed".into()),
                    )
                    .into_any_element(),
            ),
            ItemStatus::Done => None,
        };

        h_flex()
            .id(("describe-card", id))
            .items_start()
            .gap_3()
            .p_3()
            .rounded(theme.radius_lg)
            .border_1()
            .border_color(theme.border)
            .child(
                img(ImageSource::Render(item.preview.clone()))
                    .size_32()
                    .flex_shrink_0()
                    .rounded(theme.radius)
                    .object_fit(ObjectFit::Cover),
            )
            .child(
                v_flex()
                    .flex_1()
                    .min_w_0()
                    .gap_2()
                    .when(!done, |this| {
                        this.child(div().text_xs().text_color(muted).child(item.label.clone()))
                    })
                    .children(status)
                    .when(done, |this| {
                        this.child(
                            Textarea::new(&item.text)
                                .small()
                                .font_family(theme.mono_font_family.clone())
                                .text_xs()
                                .aria_label(format!("Prompt for {}", item.name)),
                        )
                        .when_some(item.meta.clone(), |this, meta| {
                            this.child(div().text_xs().text_color(muted).child(meta))
                        })
                        .when_some(item.fallback_reason.clone(), |this, reason| {
                            this.child(
                                div()
                                    .text_xs()
                                    .text_color(muted)
                                    .child(format!("Grok did not answer ({reason}), Atlas did.")),
                            )
                        })
                    })
                    .child(
                        h_flex()
                            .gap_1()
                            .flex_wrap()
                            .when(done, |this| {
                                this.child(
                                    Button::new("save")
                                        .ghost()
                                        .small()
                                        .icon(if saved {
                                            IconName::BookmarkCheck
                                        } else {
                                            IconName::BookmarkPlus
                                        })
                                        .label(if saved { "Saved" } else { "Save" })
                                        .loading(item.saving)
                                        .disabled(trimmed.is_empty() || saved)
                                        .on_click(cx.listener(move |this, _, window, cx| {
                                            this.save(id, window, cx)
                                        })),
                                )
                                .child(
                                    Button::new("copy")
                                        .ghost()
                                        .small()
                                        .icon(IconName::Copy)
                                        .label("Copy")
                                        .disabled(trimmed.is_empty())
                                        .on_click(cx.listener(move |this, _, window, cx| {
                                            this.copy(id, window, cx)
                                        })),
                                )
                                .child(
                                    Button::new("again")
                                        .ghost()
                                        .small()
                                        .icon(IconName::RotateCcw)
                                        .label("Again")
                                        .tooltip("Describe this picture again with the current format, model and instructions, as a new card")
                                        .disabled(too_long)
                                        .on_click(cx.listener(move |this, _, window, cx| {
                                            this.run_again(id, window, cx)
                                        })),
                                )
                            })
                            .when(item.status == ItemStatus::Error, |this| {
                                this.child(
                                    Button::new("retry")
                                        .ghost()
                                        .small()
                                        .icon(IconName::RotateCcw)
                                        .label("Retry")
                                        .tooltip("Try again with the current format, model and instructions")
                                        .disabled(too_long)
                                        .on_click(cx.listener(move |this, _, window, cx| {
                                            this.retry(id, window, cx)
                                        })),
                                )
                            })
                            .child(div().flex_1())
                            .child(
                                Button::new("remove")
                                    .ghost()
                                    .small()
                                    .icon(IconName::X)
                                    .tooltip(if item.is_active() {
                                        "Remove — a request already sent still finishes and is billed"
                                    } else {
                                        "Remove"
                                    })
                                    .accessibility_label(format!("Remove {}", item.name))
                                    .on_click(cx.listener(move |this, _, window, cx| {
                                        this.remove(id, window, cx)
                                    })),
                            ),
                    ),
            )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use artsnack_backend::api::image_to_prompt::DescribeModel;

    fn described(provider: &str, cost: Option<f64>) -> Described {
        Described {
            text: "x".into(),
            cost_usd: cost,
            model: DescribeModel {
                id: "grok:grok-4.6".into(),
                provider: provider.into(),
                label: "Grok 4.6".into(),
            },
            fell_back: provider == "atlas",
            reason: None,
        }
    }

    #[test]
    fn meta_names_the_format_the_model_and_the_cost() {
        assert_eq!(
            describe_meta("SD tags with weights", "Grok 4.6", &described("grok", None)),
            "SD tags with weights · Grok 4.6"
        );
        assert_eq!(
            describe_meta(
                "Natural description",
                "Grok 4.6",
                &described("atlas", Some(0.0018))
            ),
            "Natural description · Atlas · Grok 4.6 · $0.0018"
        );
    }
}
