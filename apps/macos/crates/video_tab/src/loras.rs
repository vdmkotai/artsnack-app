//! A family's LoRAs (the web's `H3LoraStack`, which LTX reuses).
//!
//! H3 and LTX load LoRAs model-only — H3's text encoder is a separate
//! Qwen3-VL that LoRAs do not touch — so each row has one strength, not the
//! image tab's model/CLIP pair. Merged community checkpoints usually want
//! 0.2–0.6; the official ones take 1.0.
//!
//! The owner sets the rows ([`LoraStack::set_loras`]) without hearing back;
//! what the user changes is reported as [`LorasChanged`].

use artsnack_backend::api::comfy_video_jobs::VideoLora;
use gpui_kit::{
    AppContext as _, Context, Entity, EventEmitter, IntoElement, ParentElement as _, Render,
    SharedString, Styled as _, Subscription, Window,
    assets::IconName,
    component::{
        ActiveTheme as _, Disableable as _, Sizable as _,
        button::{Button, ButtonVariants as _},
        h_flex,
        input::{InputEvent, InputState, NumberInput},
        searchable_list::SearchableVec,
        select::{Select, SelectEvent, SelectState},
        slider::{Slider, SliderEvent, SliderState},
        v_flex,
    },
    div,
};

use crate::{
    controls::{NumberSpec, number_state, parse_number},
    rules::Range,
};

type NameSelect = SelectState<SearchableVec<SharedString>>;

/// The rows as the user left them.
#[derive(Clone, Debug)]
pub(crate) struct LorasChanged(pub Vec<VideoLora>);

/// The strength a new row starts at.
const NEW_STRENGTH: f64 = 0.5;

struct LoraRow {
    /// Stable across removals, so a row keeps its controls' identity.
    id: u64,
    lora: VideoLora,
    select: Entity<NameSelect>,
    strength: Entity<InputState>,
    slider: Entity<SliderState>,
    _subscriptions: Vec<Subscription>,
}

pub(crate) struct LoraStack {
    /// Namespaces the rows' element ids ("h3-lora", "ltx-lora").
    prefix: &'static str,
    rows: Vec<LoraRow>,
    available: Vec<SharedString>,
    limit: usize,
    strength: NumberSpec,
    empty_message: &'static str,
    next_id: u64,
}

impl EventEmitter<LorasChanged> for LoraStack {}

impl LoraStack {
    pub fn new(
        prefix: &'static str,
        limit: usize,
        strength: Range,
        empty_message: &'static str,
        loras: &[VideoLora],
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        let mut this = Self {
            prefix,
            rows: Vec::new(),
            available: Vec::new(),
            limit,
            strength: NumberSpec::new(strength.min, strength.max, 0.05, 2),
            empty_message,
            next_id: 1,
        };
        this.set_loras(loras, window, cx);
        this
    }

    /// The pod's LoRAs, after a catalogue read.
    pub fn set_available(&mut self, names: &[String], window: &mut Window, cx: &mut Context<Self>) {
        let names: Vec<SharedString> = names.iter().cloned().map(SharedString::from).collect();
        if names == self.available {
            return;
        }
        self.available = names;
        for ix in 0..self.rows.len() {
            self.refresh_items(ix, window, cx);
        }
        cx.notify();
    }

    /// Replaces the rows (Reproduce, a checkpoint's companion) without
    /// reporting a change.
    pub fn set_loras(&mut self, loras: &[VideoLora], window: &mut Window, cx: &mut Context<Self>) {
        let current: Vec<&VideoLora> = self.rows.iter().map(|row| &row.lora).collect();
        if current.len() == loras.len() && current.iter().zip(loras).all(|(a, b)| *a == b) {
            return;
        }
        self.rows.clear();
        for lora in loras {
            self.push_row(lora.clone(), window, cx);
        }
        cx.notify();
    }

    /// Takes in strengths typed but not committed yet (they commit on Blur or
    /// Enter, and Cmd+Enter submits before either), clamped as leaving the
    /// field would. Returns the rows when that changed any, without reporting
    /// a change: the owner reads them back at once.
    pub fn commit_drafts(
        &mut self,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Option<Vec<VideoLora>> {
        let spec = self.strength;
        let mut changed = false;
        for row in &mut self.rows {
            let value = spec.clamp(parse_number(&row.strength.read(cx).value()).unwrap_or(0.0));
            let text = spec.format(value);
            if row.strength.read(cx).value().as_ref() != text {
                row.strength
                    .update(cx, |input, cx| input.set_value(text, window, cx));
            }
            if (row.lora.strength - value).abs() >= f64::EPSILON {
                row.lora.strength = value;
                row.slider
                    .update(cx, |slider, cx| slider.set_value(value as f32, window, cx));
                changed = true;
            }
        }
        changed.then(|| {
            cx.notify();
            self.loras()
        })
    }

    fn loras(&self) -> Vec<VideoLora> {
        self.rows.iter().map(|row| row.lora.clone()).collect()
    }

    fn changed(&mut self, cx: &mut Context<Self>) {
        cx.emit(LorasChanged(self.loras()));
        cx.notify();
    }

    fn push_row(&mut self, lora: VideoLora, window: &mut Window, cx: &mut Context<Self>) {
        let id = self.next_id;
        self.next_id += 1;
        let select = cx.new(|cx| {
            SelectState::new(
                SearchableVec::new(Vec::<SharedString>::new()),
                None,
                window,
                cx,
            )
            .searchable(true)
        });
        let strength = number_state(lora.strength, self.strength, window, cx);
        let spec = self.strength;
        let slider = cx.new(|_| {
            SliderState::new()
                .min(spec.min as f32)
                .max(spec.max as f32)
                .step(spec.step as f32)
                .default_value(spec.clamp(lora.strength) as f32)
        });
        let subscriptions = vec![
            cx.subscribe_in(
                &select,
                window,
                move |this, _, event: &SelectEvent<SearchableVec<SharedString>>, _, cx| {
                    let SelectEvent::Confirm(Some(name)) = event else {
                        return;
                    };
                    if let Some(row) = this.rows.iter_mut().find(|row| row.id == id) {
                        row.lora.name = name.to_string();
                    }
                    this.changed(cx);
                },
            ),
            cx.subscribe_in(
                &strength,
                window,
                move |this, state, event: &InputEvent, window, cx| {
                    let typed = parse_number(&state.read(cx).value());
                    let value = match event {
                        InputEvent::Change => match typed {
                            Some(value) => value,
                            None => return,
                        },
                        InputEvent::Blur | InputEvent::PressEnter { .. } => {
                            this.strength.clamp(typed.unwrap_or(0.0))
                        }
                        _ => return,
                    };
                    this.set_strength(id, value, false, window, cx);
                },
            ),
            cx.subscribe_in(
                &slider,
                window,
                move |this, _, event: &SliderEvent, window, cx| {
                    let value = match event {
                        SliderEvent::Change(value) | SliderEvent::Release(value) => value.start(),
                    };
                    // Rounded to the hundredth, as the web's slider handler does.
                    let value = (value as f64 * 100.0).round() / 100.0;
                    this.set_strength(id, value, true, window, cx);
                },
            ),
        ];
        self.rows.push(LoraRow {
            id,
            lora,
            select,
            strength,
            slider,
            _subscriptions: subscriptions,
        });
        let ix = self.rows.len() - 1;
        self.refresh_items(ix, window, cx);
    }

    /// The pod's list, plus the row's own name when the pod does not list it
    /// (a reproduced clip's LoRA), so what is set stays visible.
    fn refresh_items(&mut self, ix: usize, window: &mut Window, cx: &mut Context<Self>) {
        let Some(row) = self.rows.get(ix) else {
            return;
        };
        let name = SharedString::from(row.lora.name.clone());
        let mut items = self.available.clone();
        if !name.is_empty() && !items.contains(&name) {
            items.push(name.clone());
        }
        row.select.update(cx, |select, cx| {
            select.set_items(SearchableVec::new(items), window, cx);
            if !name.is_empty() {
                select.set_selected_value(&name, window, cx);
            }
        });
    }

    fn set_strength(
        &mut self,
        id: u64,
        value: f64,
        from_slider: bool,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let spec = self.strength;
        let Some(row) = self.rows.iter_mut().find(|row| row.id == id) else {
            return;
        };
        if (row.lora.strength - value).abs() < f64::EPSILON {
            return;
        }
        row.lora.strength = value;
        if from_slider {
            let text = spec.format(value);
            if row.strength.read(cx).value().as_ref() != text {
                row.strength
                    .update(cx, |input, cx| input.set_value(text, window, cx));
            }
        } else {
            row.slider.update(cx, |slider, cx| {
                slider.set_value(spec.clamp(value) as f32, window, cx)
            });
        }
        self.changed(cx);
    }

    fn add(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.rows.len() >= self.limit {
            return;
        }
        let name = self
            .available
            .first()
            .map(|name| name.to_string())
            .unwrap_or_default();
        self.push_row(
            VideoLora {
                name,
                strength: NEW_STRENGTH,
            },
            window,
            cx,
        );
        self.changed(cx);
    }

    fn remove(&mut self, id: u64, cx: &mut Context<Self>) {
        self.rows.retain(|row| row.id != id);
        self.changed(cx);
    }
}

impl Render for LoraStack {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let prefix = self.prefix;
        let empty_message = self.empty_message;
        let full = self.rows.len() >= self.limit;
        v_flex()
            .gap_2()
            .children(self.rows.iter().map(|row| {
                let id = row.id;
                v_flex()
                    .gap_2()
                    .p_3()
                    .rounded(cx.theme().radius_lg)
                    .border_1()
                    .border_color(cx.theme().border)
                    .bg(cx.theme().group_box)
                    .child(
                        h_flex()
                            .gap_2()
                            .child(
                                div().flex_1().min_w_0().child(
                                    Select::new(&row.select)
                                        .small()
                                        .placeholder("Select LoRA…")
                                        .empty(move |_, _| div().p_2().child(empty_message)),
                                ),
                            )
                            .child(
                                Button::new(SharedString::from(format!("{prefix}-remove-{id}")))
                                    .ghost()
                                    .small()
                                    .icon(IconName::X)
                                    .accessibility_label("Remove LoRA")
                                    .tooltip("Remove LoRA")
                                    .on_click(
                                        cx.listener(move |this, _, _, cx| this.remove(id, cx)),
                                    ),
                            ),
                    )
                    .child(
                        h_flex()
                            .gap_3()
                            .child(div().flex_1().child(Slider::new(&row.slider)))
                            .child(
                                div()
                                    .w_24()
                                    .flex_shrink_0()
                                    .child(NumberInput::new(&row.strength).small()),
                            ),
                    )
            }))
            .child(
                Button::new(SharedString::from(format!("{prefix}-add")))
                    .outline()
                    .small()
                    .w_full()
                    .icon(IconName::Plus)
                    .label("Add LoRA")
                    .disabled(full)
                    .on_click(cx.listener(|this, _, window, cx| this.add(window, cx))),
            )
    }
}
