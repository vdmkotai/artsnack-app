//! The switcher rows above the form: media type and balance, providers (and
//! Image → Prompt), then the model row — in the order the choices depend on
//! each other (the web's model-switcher.tsx).

use gpui_kit::{
    AnyElement, App, Context, Entity, InteractiveElement as _, IntoElement, ParentElement as _,
    SharedString, StatefulInteractiveElement as _, Styled as _, Window,
    assets::IconName,
    component::{
        ActiveTheme as _, Icon, Sizable as _,
        button::{Button, ButtonVariants as _},
        h_flex,
        spinner::Spinner,
        tooltip::Tooltip,
        v_flex,
    },
    div,
    prelude::FluentBuilder as _,
};

use super::{
    ApiComposer,
    engine::{Edit, ModelRow},
    picker,
};
use artsnack_backend::api::higgsfield::HiggsfieldAccount;

/// What the switcher reports that is not a form edit.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SwitcherAction {
    /// "Image → Prompt" was pressed.
    Describe,
    /// A provider was pressed (leaves Image → Prompt).
    Provider,
}

impl ApiComposer {
    /// The rows; `tabs` is the Generate screen's backend switch, which shares
    /// the first row. `describing` shows Image → Prompt pressed and hides the
    /// media and model rows, which would configure nothing.
    pub fn render_switcher(
        &self,
        tabs: AnyElement,
        accessory: Option<AnyElement>,
        describing: bool,
        on_action: impl Fn(SwitcherAction, &mut Window, &mut App) + Clone + 'static,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let Some(view) = self.view.clone() else {
            return h_flex().gap_2().child(tabs).into_any_element();
        };
        let theme = cx.theme().clone();
        let video = view.is_video();
        let media = (!describing).then(|| {
            let segment = |id: &'static str,
                           icon: IconName,
                           label: &'static str,
                           active: bool,
                           to_video: bool| {
                Button::new(id)
                    .xsmall()
                    .when(active, |button| button.primary())
                    .when(!active, |button| button.ghost())
                    .icon(icon)
                    .label(label)
                    .on_click(cx.listener(move |this, _, _, cx| {
                        this.edit_choice(
                            "mediaType",
                            Edit::field("mediaType", if to_video { "video" } else { "image" }),
                            (if to_video { "video" } else { "image" }).into(),
                            cx,
                        )
                    }))
            };
            h_flex()
                .gap_0p5()
                .p_0p5()
                .rounded(theme.radius)
                .border_1()
                .border_color(theme.border)
                .bg(theme.secondary)
                .child(segment(
                    "media-image",
                    IconName::Image,
                    "Image",
                    !video,
                    false,
                ))
                .child(segment("media-video", IconName::Film, "Video", video, true))
        });

        let provider_now = self
            .optimistic
            .get("provider")
            .and_then(|value| value.as_str().map(str::to_string))
            .unwrap_or_else(|| view.provider.clone());
        let providers = view
            .providers
            .iter()
            .map(|entry| {
                let active = !describing && entry.id == provider_now;
                let id = entry.id.clone();
                let on_action = on_action.clone();
                Button::new(SharedString::from(format!("provider-{}", entry.id)))
                    .xsmall()
                    .when(active, |button| button.primary())
                    .when(!active, |button| button.ghost())
                    .label(entry.label.clone())
                    .on_click(cx.listener(move |this, _, window, cx| {
                        on_action(SwitcherAction::Provider, window, cx);
                        this.edit_choice(
                            "provider",
                            Edit::Provider {
                                provider: id.clone(),
                            },
                            id.clone().into(),
                            cx,
                        );
                    }))
            })
            .collect::<Vec<_>>();
        let describe = {
            let on_action = on_action.clone();
            Button::new("provider-describe")
                .xsmall()
                .when(describing, |button| button.primary())
                .when(!describing, |button| button.ghost())
                .icon(IconName::ScanText)
                .label("Image → Prompt")
                .tooltip("Describe an image as a prompt")
                .on_click(move |_, window, cx| on_action(SwitcherAction::Describe, window, cx))
        };

        let model_row = (!describing)
            .then(|| self.render_model_row(view.model_row.as_ref(), cx))
            .flatten();

        v_flex()
            .gap_1p5()
            .child(
                h_flex()
                    .flex_wrap()
                    .gap_1p5()
                    .child(tabs)
                    .children(media)
                    .when_some(accessory, |this, accessory| {
                        this.child(div().ml_auto().child(accessory))
                    }),
            )
            .child(
                h_flex()
                    .flex_wrap()
                    .gap_0p5()
                    .p_0p5()
                    .rounded(theme.radius)
                    .border_1()
                    .border_color(theme.border)
                    .bg(theme.secondary)
                    .children(providers)
                    .child(div().mx_0p5().h_4().w_px().bg(theme.border))
                    .child(describe),
            )
            .children(model_row)
            .into_any_element()
    }

    fn render_model_row(
        &self,
        row: Option<&ModelRow>,
        cx: &mut Context<Self>,
    ) -> Option<AnyElement> {
        let theme = cx.theme().clone();
        match row? {
            ModelRow::Registry { models, selected } => {
                let selected = self
                    .optimistic
                    .get("model")
                    .and_then(|value| value.as_str().map(str::to_string))
                    .unwrap_or_else(|| selected.clone());
                let buttons = models.iter().map(|model| {
                    let active = model.id == selected;
                    let id = model.id.clone();
                    Button::new(SharedString::from(format!("model-{}", model.id)))
                        .xsmall()
                        .when(active, |button| button.secondary())
                        .when(!active, |button| button.ghost())
                        .label(model.label.clone())
                        .on_click(cx.listener(move |this, _, _, cx| {
                            this.edit_choice(
                                "model",
                                Edit::Model { id: id.clone() },
                                id.clone().into(),
                                cx,
                            )
                        }))
                });
                Some(
                    h_flex()
                        .flex_wrap()
                        .gap_0p5()
                        .p_0p5()
                        .rounded(theme.radius)
                        .border_1()
                        .border_color(theme.border)
                        .children(buttons)
                        .into_any_element(),
                )
            }
            ModelRow::Video { label } => Some(
                h_flex()
                    .gap_1()
                    .px_0p5()
                    .text_xs()
                    .text_color(theme.muted_foreground)
                    .child("Video model:")
                    .child(
                        div()
                            .font_weight(gpui_kit::FontWeight::MEDIUM)
                            .text_color(theme.foreground)
                            .child(label.clone()),
                    )
                    .into_any_element(),
            ),
            ModelRow::Atlas { model, starred } => {
                let media = self
                    .view
                    .as_ref()
                    .map(|view| view.media_type.clone())
                    .unwrap_or_default();
                let current = model.id.clone();
                let view = cx.entity().downgrade();
                let picker_button = Button::new("atlas-model")
                    .outline()
                    .small()
                    .w_full()
                    .tooltip(model.id.clone())
                    .child(
                        h_flex()
                            .w_full()
                            .justify_between()
                            .gap_2()
                            .child(
                                h_flex().min_w_0().gap_1p5().child(
                                    div()
                                        .truncate()
                                        .text_xs()
                                        .font_weight(gpui_kit::FontWeight::MEDIUM)
                                        .child(model.label.clone()),
                                ),
                            )
                            .child(
                                h_flex()
                                    .gap_1()
                                    .child(badge(
                                        "atlas-rate",
                                        &model.rate,
                                        &model.rate_tooltip,
                                        cx,
                                    ))
                                    .child(Icon::new(IconName::ChevronDown).xsmall()),
                            ),
                    )
                    .on_click(move |_, window, cx| {
                        let view = view.clone();
                        picker::open(
                            media.clone(),
                            current.clone(),
                            window,
                            cx,
                            move |id, _, cx| {
                                let _ = view.update(cx, |this, cx| {
                                    this.edit(Edit::AtlasModel { id: id.clone() }, cx)
                                });
                            },
                        );
                    });
                let chips = starred.iter().map(|row| {
                    let active = row.id == model.id || row.key == model.id;
                    let id = row.id.clone();
                    Button::new(SharedString::from(format!("starred-{}", row.key)))
                        .xsmall()
                        .when(active, |button| button.primary())
                        .when(!active, |button| button.outline())
                        .icon(IconName::Star)
                        .label(row.label.clone())
                        .tooltip(row.id.clone())
                        .when(row.price_text != "—", |button| {
                            button.child(div().ml_1p5().opacity(0.7).child(row.price_text.clone()))
                        })
                        .on_click(cx.listener(move |this, _, _, cx| {
                            this.edit(Edit::AtlasModel { id: id.clone() }, cx)
                        }))
                });
                Some(
                    v_flex()
                        .gap_1p5()
                        .child(picker_button)
                        .child(h_flex().flex_wrap().gap_1p5().children(chips))
                        .into_any_element(),
                )
            }
        }
    }

    /// The balance on the right of the first row: Higgsfield credits or the
    /// Atlas balance, depending on the provider.
    pub fn render_balance(&self, cx: &mut Context<Self>) -> Option<AnyElement> {
        let theme = cx.theme().clone();
        match self.provider()? {
            "higgsfield" => {
                let account: Option<HiggsfieldAccount> = self
                    .hf_account
                    .read(cx)
                    .data()
                    .and_then(|account| account.as_ref().clone());
                let loading = self.hf_account.read(cx).is_loading();
                if !loading && account.is_none() {
                    return None;
                }
                let tooltip = account
                    .as_ref()
                    .map(|account| match &account.plan_type {
                        Some(plan) => format!("Higgsfield plan · {plan}"),
                        None => "Higgsfield plan".to_string(),
                    })
                    .unwrap_or_default();
                Some(
                    h_flex()
                        .id("hf-credits")
                        .gap_1()
                        .px_2()
                        .py_0p5()
                        .rounded(theme.radius)
                        .border_1()
                        .border_color(theme.border)
                        .text_xs()
                        .map(|this| match &account {
                            Some(account) => this
                                .child(
                                    div()
                                        .font_weight(gpui_kit::FontWeight::MEDIUM)
                                        .child(format!("{}", account.credits.round() as i64)),
                                )
                                .child(div().text_color(theme.muted_foreground).child("credits")),
                            None => this.child(Spinner::new().xsmall()),
                        })
                        .tooltip(move |window, cx| Tooltip::new(tooltip.clone()).build(window, cx))
                        .into_any_element(),
                )
            }
            "atlas" => {
                let balance = self.balances.atlas.clone();
                let loading = self.balances.atlas_fetch == super::Fetch::Loading;
                if !loading
                    && balance
                        .as_ref()
                        .and_then(|balance| balance.available)
                        .is_none()
                {
                    return None;
                }
                let low = balance
                    .as_ref()
                    .and_then(|balance| balance.available)
                    .is_some_and(|available| available < 2.);
                let tooltip = balance
                    .as_ref()
                    .map(|balance| {
                        let cash = format_usd(balance.cash.unwrap_or_default());
                        match balance.frozen.filter(|frozen| *frozen > 0.) {
                            Some(frozen) => format!(
                                "Atlas balance {cash}; {} held by active generations",
                                format_usd(frozen)
                            ),
                            None => format!("Atlas balance {cash}"),
                        }
                    })
                    .unwrap_or_default();
                Some(
                    h_flex()
                        .id("atlas-balance")
                        .gap_1()
                        .px_2()
                        .py_0p5()
                        .rounded(theme.radius)
                        .border_1()
                        .border_color(if low {
                            theme.warning.opacity(0.5)
                        } else {
                            theme.border
                        })
                        .when(low, |this| this.text_color(theme.warning))
                        .text_xs()
                        .map(
                            |this| match balance.as_ref().and_then(|balance| balance.available) {
                                Some(available) => this
                                    .child(
                                        div()
                                            .font_weight(gpui_kit::FontWeight::MEDIUM)
                                            .child(format!("{} available", format_usd(available))),
                                    )
                                    .when_some(
                                        balance
                                            .as_ref()
                                            .and_then(|balance| balance.frozen)
                                            .filter(|frozen| *frozen > 0.),
                                        |this, frozen| {
                                            this.child(
                                                div().text_color(theme.muted_foreground).child(
                                                    format!("· {} held", format_usd(frozen)),
                                                ),
                                            )
                                        },
                                    ),
                                None => this.child(Spinner::new().xsmall()),
                            },
                        )
                        .tooltip(move |window, cx| Tooltip::new(tooltip.clone()).build(window, cx))
                        .into_any_element(),
                )
            }
            _ => None,
        }
    }
}

fn badge(id: &'static str, text: &str, tooltip: &str, cx: &App) -> AnyElement {
    let theme = cx.theme();
    let tooltip: SharedString = tooltip.to_string().into();
    div()
        .id(id)
        .px_1p5()
        .rounded(theme.radius)
        .border_1()
        .border_color(theme.border)
        .text_xs()
        .text_color(theme.muted_foreground)
        .child(text.to_string())
        .tooltip(move |window, cx| Tooltip::new(tooltip.clone()).build(window, cx))
        .into_any_element()
}

/// `formatUsd` from api-pricing.ts.
pub(crate) fn format_usd(value: f64) -> String {
    if value <= 0. {
        "$0".into()
    } else if value < 0.01 {
        let text = format!("{value:.4}");
        format!("${}", text.trim_end_matches('0').trim_end_matches('.'))
    } else if value < 1. {
        let text = format!("{value:.3}");
        format!("${}", text.strip_suffix('0').unwrap_or(&text))
    } else {
        format!("${value:.2}")
    }
}

/// Stars or unstars an Atlas model at once, then reports how the server took
/// it when `composer` is given (see [`super::stars`]).
pub(crate) fn toggle_star(
    model_id: String,
    label: String,
    composer: Option<Entity<ApiComposer>>,
    cx: &mut App,
) {
    let stars = super::stars::AtlasStars::global(cx);
    stars.update(cx, |stars, cx| stars.toggle(model_id, label, composer, cx));
}

#[cfg(test)]
mod tests {
    use super::format_usd;

    #[test]
    fn formats_dollars_like_the_web() {
        assert_eq!(format_usd(0.), "$0");
        assert_eq!(format_usd(0.0045), "$0.0045");
        assert_eq!(format_usd(0.04), "$0.04");
        assert_eq!(format_usd(0.125), "$0.125");
        assert_eq!(format_usd(12.5), "$12.50");
    }
}
