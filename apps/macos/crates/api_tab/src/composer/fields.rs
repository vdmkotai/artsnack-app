//! Draws the controls the rules describe (`Field`), in the web's dense
//! two-column grid: each control takes half a row or the whole of one, and a
//! later half-row control fills the hole an earlier one left (CSS
//! `grid-flow-row-dense`), so the vendor's order holds and the rows stay full.
//!
//! Text and number boxes keep their own state between frames, keyed by the
//! field; they commit as the user types, and take the value back from the
//! rules only while they are not focused, so a clamp never fights the caret —
//! leaving a box shows what the rules made of it. A number caught mid-typing
//! ("3.") is committed when the box is left or Generate is pressed.

use std::collections::HashSet;

use gpui_kit::{
    AnyElement, App, AppContext as _, Context, Entity, InteractiveElement as _, IntoElement,
    ObjectFit, ParentElement as _, SharedString, StatefulInteractiveElement as _, Styled as _,
    StyledImage as _, Subscription, Window,
    assets::IconName,
    component::{
        ActiveTheme as _, Disableable as _, Icon, Sizable as _,
        button::{Button, ButtonVariants as _},
        h_flex,
        input::{Input, InputEvent, InputState, Textarea, TextareaState},
        menu::{DropdownMenu as _, PopupMenuItem},
        slider::{Slider, SliderEvent, SliderState},
        switch::Switch,
        tooltip::Tooltip,
        v_flex,
    },
    div, img,
    prelude::FluentBuilder as _,
    px, rems,
};

/// The source clip's poster is drawn ~10 rem wide; decoded at twice that.
const SOURCE_POSTER_PIXELS: u32 = 400;
use serde_json::Value;

use artsnack_media::{ImageRequest, Media, media_image};

use super::{
    ApiComposer,
    engine::{
        ChoiceOption, ChoiceStyle, Common, ComposerView, DimensionTier, Edit, Field,
        GrokSourceView, Matched, Size, SizeGroup, SizeLabel, Target, TencentView, Tone,
    },
};

/// The editable state a control keeps between frames.
pub(crate) enum ControlState {
    Input {
        input: Entity<InputState>,
        _subscriptions: [Subscription; 2],
    },
    Number {
        input: Entity<InputState>,
        target: Target,
        unsettable: bool,
        _subscriptions: [Subscription; 2],
    },
    Area {
        input: Entity<TextareaState>,
        _subscriptions: [Subscription; 2],
    },
    Slider {
        slider: Entity<SliderState>,
        input: Entity<InputState>,
        target: Target,
        _subscriptions: [Subscription; 3],
    },
    Dimensions(Box<DimensionsState>),
}

/// A dimensions control: the Custom and tier choices are this side's, the
/// size is the form's.
pub(crate) struct DimensionsState {
    /// The Atlas parameter it edits.
    param: String,
    /// Width and height boxes shown instead of the ratio's preset size.
    custom: bool,
    tier: String,
    /// The value the choices above were last worked out for.
    value: String,
    /// The value changed by this control's own edit, whose choices (Custom
    /// picked, a tier) stand; a change from elsewhere — a Reproduce, a
    /// clamp, another model — works them out again.
    own_edit: bool,
    width: Entity<InputState>,
    height: Entity<InputState>,
    _subscriptions: [Subscription; 4],
}

/// The text a value shows in a box.
fn value_text(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        Value::Number(number) => number.to_string(),
        Value::Array(items) => items
            .iter()
            .filter_map(Value::as_str)
            .collect::<Vec<_>>()
            .join("\n"),
        _ => String::new(),
    }
}

/// A number box's text as it stands when the box is left or the form is
/// sent: "3." is 3; "-" and "" are still nothing.
fn parse_draft(text: &str) -> Option<Value> {
    let text = text.trim();
    text.strip_suffix('.')
        .unwrap_or(text)
        .parse::<f64>()
        .ok()
        .filter(|number| number.is_finite())
        .map(Value::from)
}

/// The value a number box's text commits, or none while it is mid-typing
/// ("", "-", "3.").
fn parse_number(text: &str, unsettable: bool) -> Option<Value> {
    let text = text.trim();
    if text.is_empty() {
        return unsettable.then(|| Value::String(String::new()));
    }
    if text == "-" || text.ends_with('.') {
        return None;
    }
    text.parse::<f64>()
        .ok()
        .filter(|number| number.is_finite())
        .map(Value::from)
}

enum Slot<'a> {
    Wide(&'a Field),
    Pair(&'a Field, Option<&'a Field>),
}

/// Dense packing: a half-width control fills the first open half row.
fn pack(fields: &[Field]) -> Vec<Slot<'_>> {
    let mut slots: Vec<Slot> = Vec::new();
    for field in fields {
        if field.is_wide() {
            slots.push(Slot::Wide(field));
            continue;
        }
        let open = slots
            .iter_mut()
            .find(|slot| matches!(slot, Slot::Pair(_, None)));
        match open {
            Some(Slot::Pair(_, second)) => *second = Some(field),
            _ => slots.push(Slot::Pair(field, None)),
        }
    }
    slots
}

impl ApiComposer {
    pub(super) fn render_fields(
        &mut self,
        view: &ComposerView,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        self.render_field_grid(&view.fields, window, cx)
    }

    fn render_field_grid(
        &mut self,
        fields: &[Field],
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let mut rows = Vec::new();
        for slot in pack(fields) {
            match slot {
                Slot::Wide(field) => rows.push(self.render_field(field, window, cx)),
                Slot::Pair(first, second) => {
                    let first = self.render_field(first, window, cx);
                    let second = second
                        .map(|field| self.render_field(field, window, cx))
                        .unwrap_or_else(|| div().into_any_element());
                    rows.push(
                        h_flex()
                            .gap_4()
                            .items_start()
                            .child(div().flex_1().min_w_0().child(first))
                            .child(div().flex_1().min_w_0().child(second))
                            .into_any_element(),
                    );
                }
            }
        }
        v_flex().gap_2().children(rows).into_any_element()
    }

    fn render_field(
        &mut self,
        field: &Field,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        match field {
            Field::Choice {
                common,
                style,
                options,
                value,
                target,
                uppercase,
                capitalize,
            } => {
                let shown = self
                    .optimistic
                    .get(&common.key)
                    .cloned()
                    .unwrap_or_else(|| value.clone());
                let control = match style {
                    ChoiceStyle::Buttons => self.render_buttons(
                        common,
                        options,
                        &shown,
                        target,
                        *uppercase || *capitalize,
                        cx,
                    ),
                    ChoiceStyle::Select => self.render_select(common, options, &shown, target, cx),
                    ChoiceStyle::Tiles => self.render_tiles(common, options, &shown, target, cx),
                };
                field_row(common, control, cx)
            }
            Field::Multi {
                common,
                options,
                values,
                max,
                target,
            } => {
                let at_cap = values.len() >= *max;
                let buttons = options.iter().map(|option| {
                    let selected = option
                        .value
                        .as_str()
                        .is_some_and(|value| values.iter().any(|chosen| chosen == value));
                    let edit = target.edit(option.value.clone());
                    Button::new(SharedString::from(format!(
                        "{}-{}",
                        common.key, option.label
                    )))
                    .small()
                    .when(selected, |button| button.primary())
                    .when(!selected, |button| button.outline())
                    .label(option.label.clone())
                    // At the cap the chosen stay tappable so they can be
                    // unpicked; the rest disable rather than guessing which
                    // selection a fourth tap should evict.
                    .disabled(!selected && at_cap)
                    .on_click(
                        cx.listener(move |this, _, _, cx| this.edit_from_control(edit.clone(), cx)),
                    )
                });
                field_row(
                    common,
                    h_flex()
                        .flex_wrap()
                        .gap_1()
                        .children(buttons)
                        .into_any_element(),
                    cx,
                )
            }
            Field::Switch {
                common,
                checked,
                on,
                off,
                target,
            } => {
                let shown = self
                    .optimistic
                    .get(&common.key)
                    .map(|value| value == on)
                    .unwrap_or(*checked);
                let (on, off, target, key) =
                    (on.clone(), off.clone(), target.clone(), common.key.clone());
                let control = Switch::new(SharedString::from(common.key.clone()))
                    .checked(shown)
                    .on_click(cx.listener(move |this, checked: &bool, _, cx| {
                        let value = if *checked { on.clone() } else { off.clone() };
                        this.edit_control(&key, target.edit(value.clone()), value, cx);
                    }));
                field_row(common, control.into_any_element(), cx)
            }
            Field::Number {
                common,
                value,
                min,
                max,
                integer,
                slider,
                unsettable,
                target,
            } => {
                let control = self.render_number(
                    common,
                    value,
                    *min,
                    *max,
                    *integer,
                    *slider,
                    *unsettable,
                    target,
                    window,
                    cx,
                );
                field_row(common, control, cx)
            }
            Field::Text {
                common,
                value,
                multiline,
                url,
                target,
            } => {
                let control = if *multiline {
                    let input = self.area_for(&common.key, value, "", target, false, window, cx);
                    Textarea::new(&input).into_any_element()
                } else {
                    let input = self.input_for(
                        &common.key,
                        value,
                        if *url { "https://…" } else { "" },
                        target,
                        window,
                        cx,
                    );
                    div()
                        .when(*url, |this| this.w_full())
                        .when(!*url, |this| this.w(px(144.)))
                        .child(Input::new(&input).small())
                        .into_any_element()
                };
                field_row(common, control, cx)
            }
            Field::List {
                common,
                value,
                url,
                target,
            } => {
                let text = value.join("\n");
                let placeholder = if *url {
                    "One public URL per line"
                } else {
                    "One per line"
                };
                let input =
                    self.area_for(&common.key, &text, placeholder, target, true, window, cx);
                field_row(common, Textarea::new(&input).into_any_element(), cx)
            }
            Field::Dimensions {
                common,
                name,
                value,
                allow_auto,
                specials,
                tiers,
                matched,
                size,
                note,
                limits,
            } => {
                let control = self.render_dimensions(
                    common,
                    name,
                    value,
                    *allow_auto,
                    specials,
                    tiers,
                    matched.as_ref(),
                    *size,
                    note.as_deref(),
                    limits,
                    window,
                    cx,
                );
                field_row(common, control, cx)
            }
            Field::Sizes {
                common,
                name,
                value,
                specials,
                groups,
            } => {
                let control = self.render_sizes(common, name, value, specials, groups, cx);
                field_row(common, control, cx)
            }
            Field::Records {
                common,
                param,
                attached,
                rows,
                can_add,
                add_label,
            } => {
                let mut rendered = Vec::new();
                for (index, row) in rows.iter().enumerate() {
                    let fields = self.render_field_grid(&row.fields, window, cx);
                    let param = param.clone();
                    rendered.push(
                        v_flex()
                            .gap_2()
                            .p_2()
                            .rounded(cx.theme().radius)
                            .border_1()
                            .border_color(cx.theme().border)
                            .child(
                                h_flex()
                                    .justify_between()
                                    .child(
                                        div()
                                            .text_xs()
                                            .font_weight(gpui_kit::FontWeight::MEDIUM)
                                            .child(row.title.clone()),
                                    )
                                    .when(row.removable, |this| {
                                        this.child(
                                            Button::new(SharedString::from(format!(
                                                "{param}-remove-{index}"
                                            )))
                                            .ghost()
                                            .xsmall()
                                            .label("Remove")
                                            .on_click(cx.listener(move |this, _, _, cx| {
                                                this.edit_from_control(
                                                    Edit::RecordRemove {
                                                        param: param.clone(),
                                                        index,
                                                    },
                                                    cx,
                                                )
                                            })),
                                        )
                                    }),
                            )
                            .child(fields)
                            .into_any_element(),
                    );
                }
                let add_param = param.clone();
                let control = v_flex()
                    .w_full()
                    .gap_2()
                    .children(rendered)
                    .when(*can_add && !*attached, |this| {
                        this.child(
                            Button::new(SharedString::from(format!("{param}-add")))
                                .outline()
                                .small()
                                .label(add_label.clone())
                                .on_click(cx.listener(move |this, _, _, cx| {
                                    this.edit_from_control(
                                        Edit::RecordAdd {
                                            param: add_param.clone(),
                                        },
                                        cx,
                                    )
                                })),
                        )
                    })
                    .into_any_element();
                field_row(common, control, cx)
            }
            Field::Tencent { tencent, .. } => self.render_tencent(tencent, cx),
            Field::GrokSource { common, source, .. } => {
                let control = self.render_grok_source(source.as_ref(), cx);
                field_row(common, control, cx)
            }
            Field::Note { text, tone, .. } => div()
                .text_xs()
                .text_color(match tone {
                    Tone::Muted => cx.theme().muted_foreground,
                    Tone::Danger => cx.theme().danger,
                    Tone::Warning => cx.theme().warning,
                })
                .child(text.clone())
                .into_any_element(),
            Field::Unsupported { key, names, hint } => h_flex()
                .gap_1()
                .text_xs()
                .text_color(cx.theme().muted_foreground)
                .child("Not settable here:")
                .child(
                    div()
                        .min_w_0()
                        .truncate()
                        .font_family(cx.theme().mono_font_family.clone())
                        .child(names.clone()),
                )
                .child(info_hint(key, hint))
                .into_any_element(),
        }
    }

    fn render_buttons(
        &self,
        common: &Common,
        options: &[ChoiceOption],
        shown: &Value,
        target: &Target,
        uppercase: bool,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let buttons = options.iter().enumerate().map(|(index, option)| {
            let selected = &option.value == shown;
            let value = option.value.clone();
            let key = common.key.clone();
            let edit = target.edit(value.clone());
            let label = if uppercase {
                option.label.to_uppercase()
            } else {
                option.label.clone()
            };
            Button::new(SharedString::from(format!("{}-{index}", common.key)))
                .xsmall()
                .when(selected, |button| button.primary())
                .when(!selected, |button| button.ghost())
                .label(label)
                .disabled(option.disabled)
                .when_some(option.tooltip.clone(), |button, tooltip| {
                    button.tooltip(tooltip)
                })
                .when_some(option.price.clone(), |button, price| {
                    button.child(div().ml_1().text_xs().opacity(0.7).child(price))
                })
                .on_click(cx.listener(move |this, _, _, cx| {
                    this.edit_control(&key, edit.clone(), value.clone(), cx)
                }))
        });
        h_flex()
            .flex_wrap()
            .gap_0p5()
            .p_0p5()
            .rounded(cx.theme().radius)
            .border_1()
            .border_color(cx.theme().border)
            .bg(cx.theme().secondary)
            .children(buttons)
            .into_any_element()
    }

    fn render_select(
        &self,
        common: &Common,
        options: &[ChoiceOption],
        shown: &Value,
        target: &Target,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let current = options
            .iter()
            .find(|option| &option.value == shown)
            .map(|option| match &option.price {
                Some(price) => format!("{} · {price}", option.label),
                None => option.label.clone(),
            })
            .unwrap_or_else(|| value_text(shown));
        let options = options.to_vec();
        let target = target.clone();
        let key = common.key.clone();
        let shown = shown.clone();
        let view = cx.entity().downgrade();
        Button::new(SharedString::from(format!("{}-select", common.key)))
            .outline()
            .small()
            .label(current)
            .icon(IconName::ChevronDown)
            .dropdown_menu(move |mut menu, _, _| {
                for option in &options {
                    let label = match &option.price {
                        Some(price) => format!("{} · {price}", option.label),
                        None => option.label.clone(),
                    };
                    let (value, edit, key, view) = (
                        option.value.clone(),
                        target.edit(option.value.clone()),
                        key.clone(),
                        view.clone(),
                    );
                    menu = menu.item(
                        PopupMenuItem::new(label)
                            .checked(option.value == shown)
                            .disabled(option.disabled)
                            .on_click(move |_, _, cx| {
                                let _ = view.update(cx, |this, cx| {
                                    this.edit_control(&key, edit.clone(), value.clone(), cx)
                                });
                            }),
                    );
                }
                menu.scrollable(true).max_h(px(360.))
            })
            .into_any_element()
    }

    fn render_tiles(
        &self,
        common: &Common,
        options: &[ChoiceOption],
        shown: &Value,
        target: &Target,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let tiles = options.iter().enumerate().map(|(index, option)| {
            let selected = &option.value == shown;
            let (value, key, edit) = (
                option.value.clone(),
                common.key.clone(),
                target.edit(option.value.clone()),
            );
            ratio_tile(
                SharedString::from(format!("{}-tile-{index}", common.key)),
                &option.label,
                option.aspect,
                selected,
                option.disabled,
                cx,
            )
            .on_click(cx.listener(move |this, _, _, cx| {
                this.edit_control(&key, edit.clone(), value.clone(), cx)
            }))
        });
        h_flex()
            .flex_wrap()
            .gap_1()
            .children(tiles)
            .into_any_element()
    }

    #[allow(clippy::too_many_arguments)]
    fn render_number(
        &mut self,
        common: &Common,
        value: &Value,
        min: Option<f64>,
        max: Option<f64>,
        integer: bool,
        slider: bool,
        unsettable: bool,
        target: &Target,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        if !slider {
            let input = self.number_input(&common.key, value, unsettable, target, window, cx);
            return div()
                .w(px(96.))
                .child(Input::new(&input).small())
                .into_any_element();
        }
        let (slider_state, input) = self.slider_for(
            &common.key,
            value,
            min.unwrap_or(0.),
            max.unwrap_or(1.),
            integer,
            target,
            window,
            cx,
        );
        h_flex()
            .flex_1()
            .gap_2()
            .child(
                div()
                    .flex_1()
                    .min_w(px(80.))
                    .child(Slider::new(&slider_state)),
            )
            .child(div().w(px(80.)).child(Input::new(&input).small()))
            .into_any_element()
    }

    #[allow(clippy::too_many_arguments)]
    fn render_dimensions(
        &mut self,
        common: &Common,
        name: &str,
        value: &str,
        allow_auto: bool,
        specials: &[SizeLabel],
        tiers: &[DimensionTier],
        matched: Option<&Matched>,
        size: Option<Size>,
        note: Option<&str>,
        limits: &str,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let key = common.key.clone();
        let special = specials.iter().any(|word| word.value == value);
        self.ensure_dimensions(&key, name, value, matched, size, special, window, cx);
        let Some(ControlState::Dimensions(state)) = self.controls.get(&key) else {
            return div().into_any_element();
        };
        let (custom, tier, width, height) = (
            state.custom,
            state.tier.clone(),
            state.width.clone(),
            state.height.clone(),
        );
        // A tile picked a moment ago shows as picked before the rules answer.
        let shown = self
            .optimistic
            .get(&key)
            .and_then(Value::as_str)
            .unwrap_or(value)
            .to_string();
        let presets = tiers
            .iter()
            .find(|entry| entry.value == tier)
            .map(|entry| entry.presets.clone())
            .unwrap_or_default();

        let mut options: Vec<(String, String, Option<f32>)> = Vec::new();
        if allow_auto {
            options.push((String::new(), "Auto".into(), None));
        }
        options.extend(
            specials
                .iter()
                .map(|word| (word.value.clone(), word.label.clone(), None)),
        );
        options.extend(presets.iter().map(|preset| {
            (
                preset.value.clone(),
                preset.ratio.clone(),
                ratio_value(&preset.ratio),
            )
        }));
        options.push(("custom".into(), "Custom".into(), Some(1.)));
        let selected = if custom { "custom".to_string() } else { shown };
        let seed = tiers
            .iter()
            .find(|entry| entry.value == tier)
            .map(|entry| entry.seed.clone())
            .unwrap_or_default();

        let tiles = options
            .into_iter()
            .enumerate()
            .map(|(index, (option, label, aspect))| {
                let is_selected = option == selected;
                let (key, name, seed) = (key.clone(), name.to_string(), seed.clone());
                let has_size = size.is_some();
                ratio_tile(
                    SharedString::from(format!("{key}-dim-{index}")),
                    &label,
                    aspect,
                    is_selected,
                    false,
                    cx,
                )
                .on_click(cx.listener(move |this, _, _, cx| {
                    let to_custom = option == "custom";
                    if let Some(ControlState::Dimensions(state)) = this.controls.get_mut(&key) {
                        state.custom = to_custom;
                    }
                    if !to_custom {
                        let value = Value::String(option.clone());
                        this.edit_dimensions(&key, name.clone(), value, cx);
                    } else if !has_size {
                        // From Auto or a size word there are no numbers to
                        // edit: start from the tier's square size.
                        this.edit_dimensions(&key, name.clone(), Value::String(seed.clone()), cx);
                    }
                    cx.notify();
                }))
            });

        let detail: AnyElement = if custom {
            h_flex()
                .gap_1p5()
                .child(div().w(px(80.)).child(Input::new(&width).small()))
                .child(
                    div()
                        .text_xs()
                        .text_color(cx.theme().muted_foreground)
                        .child("×"),
                )
                .child(div().w(px(80.)).child(Input::new(&height).small()))
                .child(info_hint(&format!("{key}-limits"), limits))
                .into_any_element()
        } else if let Some(note) = note {
            div()
                .text_xs()
                .text_color(cx.theme().muted_foreground)
                .child(note.to_string())
                .into_any_element()
        } else {
            let ratio = matched
                .map(|matched| matched.ratio.clone())
                .unwrap_or_else(|| "1:1".into());
            let tier_buttons = tiers.iter().map(|entry| {
                let active = entry.value == tier;
                let next = entry
                    .presets
                    .iter()
                    .find(|preset| preset.ratio == ratio)
                    .map(|preset| preset.value.clone());
                let (key, name, value) = (key.clone(), name.to_string(), entry.value.clone());
                Button::new(SharedString::from(format!("{key}-tier-{value}")))
                    .xsmall()
                    .when(active, |button| button.secondary())
                    .when(!active, |button| button.ghost())
                    .label(value.clone())
                    .on_click(cx.listener(move |this, _, _, cx| {
                        if let Some(ControlState::Dimensions(state)) = this.controls.get_mut(&key) {
                            state.tier = value.clone();
                        }
                        // Keep the shape, change the scale.
                        if let Some(next) = &next {
                            this.edit_dimensions(
                                &key,
                                name.clone(),
                                Value::String(next.clone()),
                                cx,
                            );
                        }
                        cx.notify();
                    }))
            });
            h_flex()
                .flex_wrap()
                .gap_1p5()
                .child(h_flex().gap_0p5().children(tier_buttons))
                .child(
                    div()
                        .text_xs()
                        .text_color(cx.theme().muted_foreground)
                        .child(
                            size.map(|size| format!("{} × {}", size.width, size.height))
                                .unwrap_or_else(|| value.to_string()),
                        ),
                )
                .into_any_element()
        };
        v_flex()
            .gap_1()
            .child(h_flex().flex_wrap().gap_1().children(tiles))
            .child(detail)
            .into_any_element()
    }

    /// An edit made on the dimensions control `key`: its own, so the Custom
    /// and tier choices that came with it stand when the rules answer.
    fn edit_dimensions(&mut self, key: &str, param: String, value: Value, cx: &mut Context<Self>) {
        if let Some(ControlState::Dimensions(state)) = self.controls.get_mut(key) {
            state.own_edit = true;
        }
        self.edit_control(
            key,
            Edit::AtlasParam {
                name: param,
                value: value.clone(),
            },
            value,
            cx,
        );
    }

    fn render_sizes(
        &self,
        common: &Common,
        name: &str,
        value: &str,
        specials: &[String],
        groups: &[SizeGroup],
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let shown = self
            .optimistic
            .get(&common.key)
            .and_then(Value::as_str)
            .map(str::to_string)
            .unwrap_or_else(|| value.to_string());
        let special = specials.contains(&shown).then(|| shown.clone());
        let Some(group) = groups
            .iter()
            .find(|group| group.options.iter().any(|option| option.value == shown))
            .or_else(|| groups.first())
        else {
            return div().into_any_element();
        };
        let selected = group
            .options
            .iter()
            .find(|option| option.value == shown)
            .or_else(|| group.options.first())
            .cloned();
        let key = common.key.clone();

        let mut tiles = Vec::new();
        for (index, word) in specials.iter().enumerate() {
            let is_selected = special.as_deref() == Some(word.as_str());
            let mut label = word.clone();
            if let Some(first) = label.get_mut(0..1) {
                first.make_ascii_uppercase();
            }
            let (key, name, word) = (key.clone(), name.to_string(), word.clone());
            tiles.push(
                ratio_tile(
                    SharedString::from(format!("{key}-special-{index}")),
                    &label,
                    None,
                    is_selected,
                    false,
                    cx,
                )
                .on_click(cx.listener(move |this, _, _, cx| {
                    let value = Value::String(word.clone());
                    this.edit_control(
                        &key,
                        Edit::AtlasParam {
                            name: name.clone(),
                            value: value.clone(),
                        },
                        value,
                        cx,
                    );
                })),
            );
        }
        let current_area = selected
            .as_ref()
            .filter(|_| special.is_none())
            .map(|option| (option.width * option.height) as f64)
            .unwrap_or(1024. * 1024.);
        for (index, candidate) in groups.iter().enumerate() {
            let is_selected = special.is_none() && candidate.ratio == group.ratio;
            // Keep about the same pixel count when the shape changes.
            let nearest = candidate
                .options
                .iter()
                .min_by(|a, b| {
                    let distance = |option: &&engine_option::Option| {
                        ((option.width * option.height) as f64 / current_area)
                            .ln()
                            .abs()
                    };
                    distance(a).total_cmp(&distance(b))
                })
                .map(|option| option.value.clone());
            let (key, name) = (key.clone(), name.to_string());
            tiles.push(
                ratio_tile(
                    SharedString::from(format!("{key}-group-{index}")),
                    &candidate.ratio,
                    Some(candidate.aspect),
                    is_selected,
                    false,
                    cx,
                )
                .on_click(cx.listener(move |this, _, _, cx| {
                    if let Some(next) = &nearest {
                        let value = Value::String(next.clone());
                        this.edit_control(
                            &key,
                            Edit::AtlasParam {
                                name: name.clone(),
                                value: value.clone(),
                            },
                            value,
                            cx,
                        );
                    }
                })),
            );
        }

        let detail: AnyElement = match (&special, &selected) {
            (Some(_), _) | (None, None) => div()
                .text_xs()
                .text_color(cx.theme().muted_foreground)
                .child("The model picks the size from the prompt.")
                .into_any_element(),
            (None, Some(selected)) => {
                let orientation = match selected.width.cmp(&selected.height) {
                    std::cmp::Ordering::Equal => "Square",
                    std::cmp::Ordering::Greater => "Landscape",
                    std::cmp::Ordering::Less => "Portrait",
                };
                let approximate =
                    (selected.width as f32 / selected.height as f32 - group.aspect).abs() > 0.001;
                let options: Vec<ChoiceOption> = group
                    .options
                    .iter()
                    .map(|option| ChoiceOption {
                        value: Value::String(option.value.clone()),
                        label: format!(
                            "{} × {} · {:.1} MP",
                            option.width,
                            option.height,
                            (option.width * option.height) as f64 / 1_000_000.
                        ),
                        price: None,
                        disabled: false,
                        tooltip: None,
                        aspect: None,
                    })
                    .collect();
                let target = Target::AtlasParam {
                    name: name.to_string(),
                };
                h_flex()
                    .flex_wrap()
                    .gap_2()
                    .child(self.render_select(
                        &Common {
                            key: format!("{key}-resolution"),
                            ..common.clone()
                        },
                        &options,
                        &Value::String(selected.value.clone()),
                        &target,
                        cx,
                    ))
                    .child(
                        div()
                            .text_xs()
                            .text_color(cx.theme().muted_foreground)
                            .child(format!(
                                "{orientation} · {}{}",
                                if approximate { "≈ " } else { "" },
                                group.ratio
                            )),
                    )
                    .into_any_element()
            }
        };
        v_flex()
            .gap_2()
            .child(h_flex().flex_wrap().gap_1().children(tiles))
            .child(detail)
            .into_any_element()
    }

    /// Grok Edit/Extend's clip: its poster (a still — nothing here plays,
    /// with or without sound), its length and size, and Upload / Replace.
    fn render_grok_source(
        &self,
        source: Option<&GrokSourceView>,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let theme = cx.theme();
        let uploading = self.is_uploading_source();
        let preview = source.map(|source| {
            let poster = Media::urls(cx).video_poster(&source.key);
            let caption_color = if source.outside {
                theme.danger
            } else {
                theme.muted_foreground
            };
            v_flex()
                .gap_0p5()
                .child(
                    div()
                        .relative()
                        .h(rems(6.))
                        .w(rems(10.))
                        .overflow_hidden()
                        .rounded(theme.radius)
                        .border_1()
                        .border_color(if source.outside {
                            theme.danger
                        } else {
                            theme.border
                        })
                        .bg(theme.muted)
                        .child(
                            img(media_image(
                                ImageRequest::new(poster).max_dimension(SOURCE_POSTER_PIXELS),
                            ))
                            .size_full()
                            .object_fit(ObjectFit::Contain),
                        )
                        .child(
                            div().absolute().top_1().right_1().child(
                                Button::new("grok-source-clear")
                                    .xsmall()
                                    .danger()
                                    .icon(IconName::X)
                                    .tooltip("Remove source video")
                                    .on_click(cx.listener(|this, _, _, cx| {
                                        this.edit_from_control(
                                            Edit::GrokSource {
                                                source: None,
                                                mode: None,
                                            },
                                            cx,
                                        )
                                    })),
                            ),
                        ),
                )
                .child(
                    div()
                        .text_xs()
                        .text_color(caption_color)
                        .child(format!("{} s \u{b7} {}", source.seconds, source.resolution)),
                )
        });
        let upload = Button::new("grok-source-upload")
            .outline()
            .small()
            .icon(IconName::Upload)
            .label(if uploading {
                "Uploading\u{2026}"
            } else if source.is_some() {
                "Replace"
            } else {
                "Upload mp4"
            })
            .loading(uploading)
            .disabled(uploading)
            .on_click(cx.listener(|this, _, _, cx| this.pick_source_video(cx)));
        h_flex()
            .gap_2()
            .items_start()
            .children(preview)
            .child(upload)
            .into_any_element()
    }

    fn render_tencent(&self, tencent: &TencentView, cx: &mut Context<Self>) -> AnyElement {
        let theme = cx.theme();
        let presets = [("2K", 2048u32), ("4K", 4096), ("5K", 5120)].map(|(label, pixels)| {
            let active = tencent.long_edge == Some(pixels);
            Button::new(SharedString::from(format!("tencent-{label}")))
                .when(active, |button| button.primary())
                .when(!active, |button| button.outline())
                .flex_1()
                .label(label)
                .child(
                    div()
                        .ml_1()
                        .text_xs()
                        .opacity(0.75)
                        .child(format!("{pixels} px · long edge")),
                )
                .on_click(cx.listener(move |this, _, _, cx| {
                    this.edit_from_control(Edit::TencentLongEdge { pixels }, cx)
                }))
        });
        let method_label = if tencent.multiplier {
            "Scale multiplier · ×"
        } else if tencent.safe {
            "Longest side · pixels"
        } else {
            "Saved custom dimensions"
        };
        let method = Button::new("tencent-method")
            .outline()
            .small()
            .label(method_label)
            .icon(IconName::ChevronDown)
            .dropdown_menu({
                let view = cx.entity().downgrade();
                let multiplier = tencent.multiplier;
                move |menu, _, _| {
                    let (edge_view, scale_view) = (view.clone(), view.clone());
                    menu.item(
                        PopupMenuItem::new("Longest side · pixels")
                            .checked(!multiplier)
                            .on_click(move |_, _, cx| {
                                let _ = edge_view.update(cx, |this, cx| {
                                    this.edit_from_control(
                                        Edit::TencentLongEdge { pixels: 5120 },
                                        cx,
                                    )
                                });
                            }),
                    )
                    .item(
                        PopupMenuItem::new("Scale multiplier · ×")
                            .checked(multiplier)
                            .on_click(move |_, _, cx| {
                                let _ = scale_view.update(cx, |this, cx| {
                                    this.edit_from_control(
                                        Edit::AtlasParam {
                                            name: "mode".into(),
                                            value: "percent".into(),
                                        },
                                        cx,
                                    )
                                });
                            }),
                    )
                }
            });
        let size_buttons: AnyElement = if tencent.multiplier {
            let percent = tencent.percent;
            h_flex()
                .gap_1()
                .children([1.5_f64, 2., 3., 4.].map(|scale| {
                    let active = (percent - scale).abs() < 0.01;
                    Button::new(SharedString::from(format!("tencent-scale-{scale}")))
                        .xsmall()
                        .when(active, |button| button.primary())
                        .when(!active, |button| button.ghost())
                        .label(format!("{scale}×"))
                        .on_click(cx.listener(move |this, _, _, cx| {
                            this.edit_from_control(
                                Edit::AtlasParam {
                                    name: "percent".into(),
                                    value: scale.into(),
                                },
                                cx,
                            )
                        }))
                }))
                .into_any_element()
        } else {
            div().into_any_element()
        };

        let engines = [
            (
                "fidelity",
                "Preserve details",
                "Photos & products. Prioritize fidelity to the source.",
            ),
            ("super", "AI artwork", "Illustrations & generated images."),
            (
                "ultra",
                "Enhance details",
                "Stronger detail enhancement. Inspect fine textures afterward.",
            ),
            (
                "standard",
                "Quick upscale",
                "General-purpose enlargement. Fastest processing mode.",
            ),
        ]
        .map(|(value, label, help)| {
            let active = tencent.engine == value;
            div()
                .id(SharedString::from(format!("tencent-engine-{value}")))
                .flex_1()
                .min_w(px(140.))
                .p_2()
                .rounded(theme.radius_lg)
                .border_1()
                .border_color(if active { theme.primary } else { theme.border })
                .when(active, |this| this.bg(theme.primary.opacity(0.1)))
                .cursor_pointer()
                .child(
                    div()
                        .text_xs()
                        .font_weight(gpui_kit::FontWeight::MEDIUM)
                        .child(label),
                )
                .child(
                    div()
                        .mt_1()
                        .text_xs()
                        .text_color(theme.muted_foreground)
                        .child(help),
                )
                .on_click(cx.listener(move |this, _, _, cx| {
                    this.edit_from_control(
                        Edit::AtlasParam {
                            name: "type".into(),
                            value: value.into(),
                        },
                        cx,
                    )
                }))
        });

        let formats = ["PNG", "JPEG", "WEBP", "BMP"].map(|format| {
            let active = tencent.format == format;
            Button::new(SharedString::from(format!("tencent-format-{format}")))
                .xsmall()
                .when(active, |button| button.primary())
                .when(!active, |button| button.ghost())
                .label(format)
                .on_click(cx.listener(move |this, _, _, cx| {
                    this.edit_from_control(
                        Edit::AtlasParam {
                            name: "encode_format".into(),
                            value: format.into(),
                        },
                        cx,
                    )
                }))
        });

        let readout: AnyElement = match (tencent.source, tencent.output) {
            (Some(source), Some(output)) => v_flex()
                .gap_1()
                .child(
                    div()
                        .font_family(theme.mono_font_family.clone())
                        .text_sm()
                        .child(format!("{} × {} → {} × {} px", source.width, source.height, output.width, output.height)),
                )
                .child(div().text_xs().text_color(theme.muted_foreground).child(format!(
                    "Estimated output · {} MP · {:.2}× per side. Pixel rounding may vary slightly.",
                    tencent.megapixels.clone().unwrap_or_default(),
                    tencent.scale.unwrap_or(1.)
                )))
                .into_any_element(),
            _ => div()
                .text_xs()
                .text_color(theme.muted_foreground)
                .child(if tencent.safe {
                    "Attach an image to see the expected output dimensions."
                } else {
                    "Choose a preset to preview the output size."
                })
                .into_any_element(),
        };
        let scale_warning = tencent.scale.and_then(|scale| {
            if scale > 4. {
                Some(format!(
                    "Large upscale: about {:.1}× as many pixels. Processing and saving can take longer. For 5K, use the 5K preset above.",
                    scale * scale
                ))
            } else if scale < 1. {
                Some("This target is smaller than your source and will reduce its resolution.".to_string())
            } else {
                None
            }
        });

        v_flex()
            .gap_4()
            .p_3()
            .rounded(theme.radius_lg)
            .border_1()
            .border_color(theme.border)
            .child(div().text_sm().font_weight(gpui_kit::FontWeight::MEDIUM).child("Upscale image"))
            .child(
                v_flex()
                    .gap_2()
                    .child(div().text_xs().font_weight(gpui_kit::FontWeight::MEDIUM).child("Output size"))
                    .child(h_flex().gap_2().children(presets))
                    .child(h_flex().gap_2().child(method).child(size_buttons))
                    .when_some(tencent.legacy_note.clone(), |this, note| {
                        this.child(div().text_xs().text_color(theme.warning).child(note))
                    }),
            )
            .child(
                v_flex()
                    .gap_1()
                    .p_3()
                    .rounded(theme.radius)
                    .bg(theme.muted.opacity(0.5))
                    .child(div().text_xs().font_weight(gpui_kit::FontWeight::MEDIUM).child(tencent.locked_text.clone()))
                    .child(readout)
                    .when(tencent.multiplier, |this| {
                        this.child(div().text_xs().text_color(theme.muted_foreground).child(format!(
                            "{}× multiplies both width and height. This is a multiplier, not a percentage.",
                            tencent.percent
                        )))
                    })
                    .when_some(scale_warning, |this, warning| this.child(div().text_xs().text_color(theme.warning).child(warning))),
            )
            .child(
                v_flex()
                    .gap_2()
                    .child(div().text_xs().font_weight(gpui_kit::FontWeight::MEDIUM).child("Image treatment"))
                    .child(h_flex().flex_wrap().gap_2().children(engines))
                    .child(
                        div()
                            .text_xs()
                            .text_color(theme.muted_foreground)
                            .child("Proportions stay the same; AI enhancement can still change fine details."),
                    ),
            )
            .child(
                v_flex()
                    .gap_1()
                    .child(div().text_xs().text_color(theme.muted_foreground).child(format!("File format · {}", tencent.format)))
                    .child(h_flex().gap_0p5().children(formats))
                    .when(matches!(tencent.format.as_str(), "JPEG" | "WEBP"), |this| {
                        this.child(div().text_xs().text_color(theme.muted_foreground).child(format!(
                            "File quality · {} (higher means less compression and a larger file)",
                            tencent.quality
                        )))
                    }),
            )
            .into_any_element()
    }

    // --- Control state ------------------------------------------------------

    /// Leaving a box: a number caught mid-typing is committed, and the box
    /// shows what the rules made of it (once any edit of it has come back).
    fn subscribe_blur<T: 'static + gpui_kit::EventEmitter<InputEvent>>(
        &mut self,
        input: &Entity<T>,
        key: &str,
        cx: &mut Context<Self>,
    ) -> Subscription {
        let key = key.to_string();
        cx.subscribe(input, move |this, _, event: &InputEvent, cx| {
            if matches!(event, InputEvent::Blur) {
                this.commit_draft(&key, cx);
                this.sync_controls(cx);
                cx.notify();
            }
        })
    }

    fn input_for(
        &mut self,
        key: &str,
        value: &str,
        placeholder: &str,
        target: &Target,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Entity<InputState> {
        if let Some(ControlState::Input { input, .. }) = self.controls.get(key) {
            return input.clone();
        }
        let input = cx.new(|cx| {
            InputState::new(window, cx)
                .placeholder(placeholder.to_string())
                .default_value(value.to_string())
        });
        let (target, control_key) = (target.clone(), key.to_string());
        let changes = cx.subscribe(&input, move |this, state, event: &InputEvent, cx| {
            if matches!(event, InputEvent::Change) {
                let text = state.read(cx).value().to_string();
                this.edit_control(
                    &control_key,
                    target.edit(Value::String(text.clone())),
                    Value::String(text),
                    cx,
                );
            }
        });
        let blur = self.subscribe_blur(&input, key, cx);
        self.controls.insert(
            key.to_string(),
            ControlState::Input {
                input: input.clone(),
                _subscriptions: [changes, blur],
            },
        );
        input
    }

    fn number_input(
        &mut self,
        key: &str,
        value: &Value,
        unsettable: bool,
        target: &Target,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Entity<InputState> {
        if let Some(ControlState::Number { input, .. }) = self.controls.get(key) {
            return input.clone();
        }
        let input = cx.new(|cx| {
            InputState::new(window, cx)
                .placeholder(if unsettable { "Random" } else { "" })
                .default_value(value_text(value))
        });
        let (edit_target, control_key) = (target.clone(), key.to_string());
        let changes = cx.subscribe(&input, move |this, state, event: &InputEvent, cx| {
            if matches!(event, InputEvent::Change) {
                let text = state.read(cx).value().to_string();
                if let Some(value) = parse_number(&text, unsettable) {
                    this.edit_control(&control_key, edit_target.edit(value.clone()), value, cx);
                }
            }
        });
        let blur = self.subscribe_blur(&input, key, cx);
        self.controls.insert(
            key.to_string(),
            ControlState::Number {
                input: input.clone(),
                target: target.clone(),
                unsettable,
                _subscriptions: [changes, blur],
            },
        );
        input
    }

    #[allow(clippy::too_many_arguments)]
    fn area_for(
        &mut self,
        key: &str,
        value: &str,
        placeholder: &str,
        target: &Target,
        list: bool,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Entity<TextareaState> {
        if let Some(ControlState::Area { input, .. }) = self.controls.get(key) {
            return input.clone();
        }
        let input = cx.new(|cx| {
            TextareaState::new(window, cx)
                .auto_grow(2, 8)
                .placeholder(placeholder.to_string())
                .default_value(value.to_string())
        });
        let (target, control_key) = (target.clone(), key.to_string());
        let changes = cx.subscribe(&input, move |this, state, event: &InputEvent, cx| {
            if matches!(event, InputEvent::Change) {
                let text = state.read(cx).value().to_string();
                let value = if list {
                    Value::Array(
                        text.lines()
                            .filter(|line| !line.trim().is_empty())
                            .map(|line| Value::String(line.to_string()))
                            .collect(),
                    )
                } else {
                    Value::String(text)
                };
                this.edit_control(&control_key, target.edit(value.clone()), value, cx);
            }
        });
        let blur = self.subscribe_blur(&input, key, cx);
        self.controls.insert(
            key.to_string(),
            ControlState::Area {
                input: input.clone(),
                _subscriptions: [changes, blur],
            },
        );
        input
    }

    #[allow(clippy::too_many_arguments)]
    fn slider_for(
        &mut self,
        key: &str,
        value: &Value,
        min: f64,
        max: f64,
        integer: bool,
        target: &Target,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> (Entity<SliderState>, Entity<InputState>) {
        if let Some(ControlState::Slider { slider, input, .. }) = self.controls.get(key) {
            return (slider.clone(), input.clone());
        }
        let current = value.as_f64().unwrap_or(min);
        let slider = cx.new(|_| {
            SliderState::new()
                .min(min as f32)
                .max(max as f32)
                .step(if integer { 1. } else { 0.1 })
                .default_value(current as f32)
        });
        let input = cx.new(|cx| InputState::new(window, cx).default_value(value_text(value)));
        let (slider_target, slider_key) = (target.clone(), key.to_string());
        // The release repeats the drag's last value; only a different one is
        // worth an edit.
        let mut dragged: Option<f64> = None;
        let slider_subscription = cx.subscribe(&slider, move |this, _, event: &SliderEvent, cx| {
            let (SliderEvent::Change(value) | SliderEvent::Release(value)) = event;
            let mut number = value.start() as f64;
            if integer {
                number = number.round();
            } else {
                number = (number * 10.).round() / 10.;
            }
            let repeated = match event {
                SliderEvent::Change(_) => {
                    let repeated = dragged == Some(number);
                    dragged = Some(number);
                    repeated
                }
                SliderEvent::Release(_) => dragged.take() == Some(number),
            };
            if repeated {
                return;
            }
            let value = Value::from(number);
            this.edit_control(&slider_key, slider_target.edit(value.clone()), value, cx);
        });
        let (input_target, input_key) = (target.clone(), key.to_string());
        let input_subscription =
            cx.subscribe(&input, move |this, state, event: &InputEvent, cx| {
                if matches!(event, InputEvent::Change) {
                    let text = state.read(cx).value().to_string();
                    if let Some(value) = parse_number(&text, false) {
                        this.edit_control(&input_key, input_target.edit(value.clone()), value, cx);
                    }
                }
            });
        let blur = self.subscribe_blur(&input, key, cx);
        self.controls.insert(
            key.to_string(),
            ControlState::Slider {
                slider: slider.clone(),
                input: input.clone(),
                target: target.clone(),
                _subscriptions: [slider_subscription, input_subscription, blur],
            },
        );
        (slider, input)
    }

    #[allow(clippy::too_many_arguments)]
    fn ensure_dimensions(
        &mut self,
        key: &str,
        name: &str,
        value: &str,
        matched: Option<&Matched>,
        size: Option<Size>,
        special: bool,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self.controls.contains_key(key) {
            return;
        }
        let side = |pick: fn(Size) -> u32| size.map(|size| pick(size).to_string());
        let width = cx.new(|cx| {
            InputState::new(window, cx).default_value(side(|size| size.width).unwrap_or_default())
        });
        let height = cx.new(|cx| {
            InputState::new(window, cx).default_value(side(|size| size.height).unwrap_or_default())
        });
        let commit = |key: String| {
            move |this: &mut ApiComposer, cx: &mut Context<ApiComposer>| {
                let Some(ControlState::Dimensions(state)) = this.controls.get_mut(&key) else {
                    return;
                };
                let parse = |input: &Entity<InputState>| {
                    input
                        .read(cx)
                        .value()
                        .trim()
                        .parse::<u32>()
                        .ok()
                        .filter(|side| *side > 0)
                };
                let (Some(width), Some(height)) = (parse(&state.width), parse(&state.height))
                else {
                    return;
                };
                state.own_edit = true;
                let param = state.param.clone();
                this.edit_control(
                    &key,
                    Edit::AtlasDimensions {
                        name: param,
                        width,
                        height,
                    },
                    Value::String("custom".into()),
                    cx,
                );
            }
        };
        let width_commit = commit(key.to_string());
        let height_commit = commit(key.to_string());
        let width_subscription = cx.subscribe(&width, move |this, _, event: &InputEvent, cx| {
            if matches!(event, InputEvent::Change) {
                width_commit(this, cx);
            }
        });
        let height_subscription = cx.subscribe(&height, move |this, _, event: &InputEvent, cx| {
            if matches!(event, InputEvent::Change) {
                height_commit(this, cx);
            }
        });
        let width_blur = self.subscribe_blur(&width, key, cx);
        let height_blur = self.subscribe_blur(&height, key, cx);
        self.controls.insert(
            key.to_string(),
            ControlState::Dimensions(Box::new(DimensionsState {
                param: name.to_string(),
                custom: is_custom_size(value, special, matched),
                tier: matched
                    .map(|matched| matched.tier.clone())
                    .unwrap_or_else(|| "1K".into()),
                value: value.to_string(),
                own_edit: false,
                width,
                height,
                _subscriptions: [
                    width_subscription,
                    height_subscription,
                    width_blur,
                    height_blur,
                ],
            })),
        );
    }

    /// Commits what the number box `key` holds if it is a number only once
    /// typing stops ("3."): the box is being left, or the form sent.
    fn commit_draft(&mut self, key: &str, cx: &mut Context<Self>) {
        let (input, target, unsettable) = match self.controls.get(key) {
            Some(ControlState::Number {
                input,
                target,
                unsettable,
                ..
            }) => (input.clone(), target.clone(), *unsettable),
            Some(ControlState::Slider { input, target, .. }) => {
                (input.clone(), target.clone(), false)
            }
            _ => return,
        };
        let text = input.read(cx).value();
        // Committed as it was typed already.
        if parse_number(&text, unsettable).is_some() {
            return;
        }
        if let Some(value) = parse_draft(&text) {
            self.edit_control(key, target.edit(value.clone()), value, cx);
        }
    }

    /// Every box's draft, before the form is sent (Generate, Cmd-Enter in a
    /// field — which the field never sees as its own Enter).
    pub(super) fn commit_drafts(&mut self, cx: &mut Context<Self>) {
        let keys: Vec<String> = self.controls.keys().cloned().collect();
        for key in keys {
            self.commit_draft(&key, cx);
        }
    }

    /// Boxes not being typed in, and with no edit of theirs still on the way,
    /// take the rules' values; the dimensions controls work out their Custom
    /// and tier choices again when their value changed from elsewhere. The
    /// state of controls no longer on screen is dropped.
    pub(super) fn sync_controls(&mut self, cx: &mut Context<Self>) {
        let Some(view) = self.view.clone() else {
            return;
        };
        let mut values = Vec::new();
        collect_values(&view.fields, &mut values);
        let present: HashSet<&str> = values.iter().map(|(key, _)| key.as_str()).collect();
        self.controls
            .retain(|key, _| present.contains(key.as_str()));
        let window = self.window;
        let _ = window.update(cx, |_, window, cx| {
            for (key, synced) in &values {
                if self.optimistic.contains_key(key) {
                    continue;
                }
                let Some(state) = self.controls.get_mut(key) else {
                    continue;
                };
                match (state, synced) {
                    (ControlState::Input { input, .. }, Synced::Text(text))
                    | (ControlState::Number { input, .. }, Synced::Text(text)) => {
                        set_unfocused(input, text, window, cx)
                    }
                    (ControlState::Area { input, .. }, Synced::Text(text)) => {
                        set_unfocused(input, text, window, cx)
                    }
                    (ControlState::Slider { slider, input, .. }, Synced::Text(text)) => {
                        if let Ok(number) = text.parse::<f32>() {
                            slider.update(cx, |slider, cx| slider.set_value(number, window, cx));
                        }
                        set_unfocused(input, text, window, cx)
                    }
                    (
                        ControlState::Dimensions(state),
                        Synced::Dimensions {
                            value,
                            special,
                            matched,
                            size,
                        },
                    ) => {
                        if *value != state.value {
                            if !state.own_edit {
                                state.custom = is_custom_size(value, *special, matched.as_ref());
                                if let Some(matched) = matched {
                                    state.tier = matched.tier.clone();
                                }
                            }
                            state.value = value.clone();
                        }
                        state.own_edit = false;
                        let side = |pick: fn(&Size) -> u32| {
                            size.as_ref()
                                .map(|size| pick(size).to_string())
                                .unwrap_or_default()
                        };
                        set_unfocused(&state.width, &side(|size| size.width), window, cx);
                        set_unfocused(&state.height, &side(|size| size.height), window, cx);
                    }
                    _ => {}
                }
            }
        });
    }
}

/// Puts `text` in a box, unless it is being typed in or already shows it.
fn set_unfocused<T>(input: &Entity<T>, text: &str, window: &mut Window, cx: &mut App)
where
    T: 'static + gpui_kit::Focusable + TextValue,
{
    let state = input.read(cx);
    if state.focus_handle(cx).is_focused(window) || state.text_value() == text {
        return;
    }
    let text = text.to_string();
    input.update(cx, |input, cx| input.replace_value(text, window, cx));
}

/// The two kinds of text box, read and written alike.
trait TextValue {
    fn text_value(&self) -> SharedString;
    fn replace_value(&mut self, text: String, window: &mut Window, cx: &mut Context<Self>)
    where
        Self: Sized;
}

impl TextValue for InputState {
    fn text_value(&self) -> SharedString {
        self.value()
    }

    fn replace_value(&mut self, text: String, window: &mut Window, cx: &mut Context<Self>) {
        self.set_value(text, window, cx);
    }
}

impl TextValue for TextareaState {
    fn text_value(&self) -> SharedString {
        self.value()
    }

    fn replace_value(&mut self, text: String, window: &mut Window, cx: &mut Context<Self>) {
        self.set_value(text, window, cx);
    }
}

/// Whether a dimensions value is shown as Custom: a size that no preset
/// matches (Auto and the size words are not sizes).
fn is_custom_size(value: &str, special: bool, matched: Option<&Matched>) -> bool {
    !value.is_empty() && !special && matched.is_none()
}

/// What a control takes from the rules after a step.
enum Synced {
    /// The text its box shows.
    Text(String),
    Dimensions {
        value: String,
        special: bool,
        matched: Option<Matched>,
        size: Option<Size>,
    },
    /// Nothing to put back: its state lives only while it is on screen.
    Other,
}

/// Every control key on screen, with what it takes from the rules.
fn collect_values(fields: &[Field], into: &mut Vec<(String, Synced)>) {
    for field in fields {
        match field {
            Field::Number { common, value, .. } => {
                into.push((common.key.clone(), Synced::Text(value_text(value))))
            }
            Field::Text { common, value, .. } => {
                into.push((common.key.clone(), Synced::Text(value.clone())))
            }
            Field::List { common, value, .. } => {
                into.push((common.key.clone(), Synced::Text(value.join("\n"))))
            }
            Field::Dimensions {
                common,
                value,
                specials,
                matched,
                size,
                ..
            } => into.push((
                common.key.clone(),
                Synced::Dimensions {
                    value: value.clone(),
                    special: specials.iter().any(|word| &word.value == value),
                    matched: matched.clone(),
                    size: *size,
                },
            )),
            Field::Records { common, rows, .. } => {
                into.push((common.key.clone(), Synced::Other));
                for row in rows {
                    collect_values(&row.fields, into);
                }
            }
            other => into.push((other.key().to_string(), Synced::Other)),
        }
    }
}

fn ratio_value(ratio: &str) -> Option<f32> {
    let (width, height) = ratio.split_once(':')?;
    let (width, height) = (width.parse::<f32>().ok()?, height.parse::<f32>().ok()?);
    (width > 0. && height > 0.).then(|| width / height)
}

/// A 64 px tile with the ratio drawn in it; a dashed outline for no shape.
fn ratio_tile(
    id: SharedString,
    label: &str,
    aspect: Option<f32>,
    selected: bool,
    disabled: bool,
    cx: &App,
) -> gpui_kit::Stateful<gpui_kit::Div> {
    let theme = cx.theme();
    let shape = aspect.unwrap_or(1.);
    let (width, height) = (24. * shape.min(1.), 24. / shape.max(1.));
    div()
        .id(id)
        .w(px(64.))
        .h(px(64.))
        .flex()
        .flex_col()
        .items_center()
        .justify_center()
        .gap_1()
        .rounded(theme.radius)
        .border_1()
        .border_color(if selected {
            theme.primary
        } else {
            theme.border
        })
        .when(selected, |this| this.bg(theme.secondary))
        .when(disabled, |this| this.opacity(0.5))
        .when(!disabled, |this| {
            this.cursor_pointer().hover(|style| style.bg(theme.accent))
        })
        .text_xs()
        .child(
            div().h(px(28.)).flex().items_center().child(
                div()
                    .w(px(width))
                    .h(px(height))
                    .rounded(px(2.))
                    .border_1()
                    .border_color(theme.foreground.opacity(0.7))
                    .when(aspect.is_none(), |this| this.border_dashed()),
            ),
        )
        .child(label.to_string())
}

/// Name on the left, control on the right — or under it when stacked.
fn field_row(common: &Common, control: AnyElement, cx: &App) -> AnyElement {
    let name = h_flex()
        .min_w_0()
        .gap_1()
        .text_xs()
        .child(div().truncate().child(common.label.clone()))
        .when(common.required, |this| {
            this.child(div().text_color(cx.theme().muted_foreground).child("*"))
        })
        .when_some(common.hint.clone(), |this, hint| {
            this.child(info_hint(&common.key, &hint))
        });
    let notes = common.notes.iter().map(|note| {
        div()
            .text_xs()
            .text_color(cx.theme().muted_foreground)
            .child(note.clone())
    });
    if common.stacked {
        v_flex()
            .gap_1()
            .child(name)
            .child(control)
            .children(notes)
            .into_any_element()
    } else {
        v_flex()
            .gap_1()
            .child(
                h_flex()
                    .min_h_8()
                    .gap_2()
                    .child(name)
                    .child(h_flex().ml_auto().min_w_0().child(control)),
            )
            .children(notes)
            .into_any_element()
    }
}

/// The vendor's description behind an icon.
fn info_hint(key: &str, text: &str) -> AnyElement {
    let text: SharedString = text.to_string().into();
    div()
        .id(SharedString::from(format!("{key}-hint")))
        .flex_shrink_0()
        .child(Icon::new(IconName::Info).xsmall())
        .tooltip(move |window, cx| Tooltip::new(text.clone()).build(window, cx))
        .into_any_element()
}

mod engine_option {
    pub use super::super::engine::SizeOption as Option;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_numbers_as_typed() {
        assert_eq!(parse_number("12", false), Some(Value::from(12.)));
        assert_eq!(parse_number("-", false), None);
        assert_eq!(parse_number("3.", false), None);
        assert_eq!(parse_number("", true), Some(Value::String(String::new())));
        assert_eq!(parse_number("", false), None);
    }

    #[test]
    fn reads_ratios() {
        assert_eq!(ratio_value("16:9"), Some(16. / 9.));
        assert_eq!(ratio_value("auto"), None);
    }
}
