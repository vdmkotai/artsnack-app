//! A number that can be typed or dragged: an input and a slider kept in step.
//!
//! Typing commits on Enter or when the field loses focus, clamped to the range
//! (an unreadable entry falls back), as the web form does. Dragging commits as
//! it moves. Values set by the owner (Reproduce, a reset) update both without
//! reporting a change back, so there is no feedback loop.
//!
//! The value itself is held at the field's precision — what the field shows
//! is what is sent: Steps typed as 20.6 is 21, not 20.6 displayed as 21.
//!
//! A form's Cmd+Enter reaches the form before the field sees Enter or loses
//! focus, so the form calls [`NumberField::commit`] before reading the value.
//!
//! Unlabelled, the field is one row (input, then slider). With
//! [`NumberField::labeled`] it is the web's narrow column: the label and the
//! input on top, the slider under them, as each LoRA strength is laid out.

use gpui_kit::{
    AppContext as _, Context, Entity, EventEmitter, IntoElement, ParentElement as _, Render,
    SharedString, Styled as _, Subscription, Window,
    component::{
        ActiveTheme as _, Sizable as _, h_flex,
        input::{Input, InputEvent, InputState},
        slider::{Slider, SliderEvent, SliderState},
        v_flex,
    },
    div,
};

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct NumberSpec {
    pub min: f64,
    pub max: f64,
    pub step: f64,
    /// Digits after the point when shown.
    pub decimals: usize,
    /// Used when the typed text is not a number.
    pub fallback: f64,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct NumberChanged(pub f64);

pub struct NumberField {
    spec: NumberSpec,
    value: f64,
    label: Option<SharedString>,
    input: Entity<InputState>,
    slider: Entity<SliderState>,
    _subscriptions: Vec<Subscription>,
}

impl EventEmitter<NumberChanged> for NumberField {}

impl NumberField {
    pub fn new(value: f64, spec: NumberSpec, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let value = normalize(value, &spec);
        let input =
            cx.new(|cx| InputState::new(window, cx).default_value(format_value(value, &spec)));
        let slider = cx.new(|_| {
            SliderState::new()
                .min(spec.min as f32)
                .max(spec.max as f32)
                .step(spec.step as f32)
                .default_value(value as f32)
        });
        let subscriptions = vec![
            cx.subscribe_in(&input, window, |this, _, event, window, cx| match event {
                InputEvent::PressEnter { .. } | InputEvent::Blur => this.commit_typed(window, cx),
                _ => {}
            }),
            cx.subscribe_in(
                &slider,
                window,
                |this, _, event: &SliderEvent, window, cx| {
                    let value = match event {
                        SliderEvent::Change(value) | SliderEvent::Release(value) => {
                            value.start() as f64
                        }
                    };
                    this.apply(value, true, false, window, cx);
                },
            ),
        ];
        Self {
            spec,
            value,
            label: None,
            input,
            slider,
            _subscriptions: subscriptions,
        }
    }

    /// Lays the field out as a column under this label.
    pub fn labeled(mut self, label: impl Into<SharedString>) -> Self {
        self.label = Some(label.into());
        self
    }

    /// The value, at the field's precision.
    pub fn value(&self) -> f64 {
        self.value
    }

    /// Sets the value from outside without emitting a change.
    pub fn set_value(&mut self, value: f64, window: &mut Window, cx: &mut Context<Self>) {
        self.apply(value, false, true, window, cx);
    }

    /// Takes whatever is typed in the field, as Enter or leaving it would,
    /// and returns the value. The change is also reported, but only after the
    /// caller's update: a form about to send reads the returned value.
    pub fn commit(&mut self, window: &mut Window, cx: &mut Context<Self>) -> f64 {
        if self.input.read(cx).value().as_ref() != format_value(self.value, &self.spec) {
            self.commit_typed(window, cx);
        }
        self.value
    }

    fn commit_typed(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let typed = self.input.read(cx).value().trim().parse::<f64>();
        let value = typed.unwrap_or(self.spec.fallback);
        self.apply(value, true, true, window, cx);
    }

    fn apply(
        &mut self,
        value: f64,
        emit: bool,
        update_slider: bool,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let value = normalize(value, &self.spec);
        let text = format_value(value, &self.spec);
        if self.input.read(cx).value().as_ref() != text {
            self.input
                .update(cx, |input, cx| input.set_value(text, window, cx));
        }
        if update_slider {
            self.slider
                .update(cx, |slider, cx| slider.set_value(value as f32, window, cx));
        }
        let changed = (value - self.value).abs() > f64::EPSILON;
        self.value = value;
        if emit && changed {
            cx.emit(NumberChanged(value));
        }
        cx.notify();
    }
}

impl Render for NumberField {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let Some(label) = self.label.clone() else {
            return h_flex()
                .gap_3()
                .child(div().w_20().flex_shrink_0().child(Input::new(&self.input)))
                .child(div().flex_1().child(Slider::new(&self.slider)))
                .into_any_element();
        };
        v_flex()
            .gap_2()
            .child(
                h_flex()
                    .justify_between()
                    .gap_2()
                    .child(
                        div()
                            .min_w_0()
                            .truncate()
                            .text_xs()
                            .text_color(cx.theme().muted_foreground)
                            .child(label),
                    )
                    .child(
                        div()
                            .w_20()
                            .flex_shrink_0()
                            .child(Input::new(&self.input).small()),
                    ),
            )
            .child(Slider::new(&self.slider))
            .into_any_element()
    }
}

fn clamp(value: f64, spec: &NumberSpec) -> f64 {
    if value.is_finite() {
        value.clamp(spec.min, spec.max)
    } else {
        spec.fallback
    }
}

/// Within the range and at the field's precision: the number the field shows
/// is the number it holds, compares, puts on the slider and reports. A slider
/// position arrives as an `f32` (0.6 as 0.6000000238) and comes out exact.
pub fn normalize(value: f64, spec: &NumberSpec) -> f64 {
    let scale = 10f64.powi(spec.decimals as i32);
    clamp((clamp(value, spec) * scale).round() / scale, spec)
}

fn format_value(value: f64, spec: &NumberSpec) -> String {
    let text = format!("{value:.precision$}", precision = spec.decimals);
    if spec.decimals > 0 {
        // 7.50 → 7.5, 1.00 → 1
        text.trim_end_matches('0').trim_end_matches('.').to_string()
    } else {
        text
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const CFG: NumberSpec = NumberSpec {
        min: 1.0,
        max: 20.0,
        step: 0.5,
        decimals: 1,
        fallback: 7.0,
    };

    #[test]
    fn clamps_and_falls_back() {
        assert_eq!(clamp(50.0, &CFG), 20.0);
        assert_eq!(clamp(f64::NAN, &CFG), 7.0);
    }

    #[test]
    fn holds_values_at_the_shown_precision() {
        let steps = NumberSpec {
            min: 1.0,
            max: 100.0,
            step: 1.0,
            decimals: 0,
            fallback: 20.0,
        };
        assert_eq!(normalize(20.6, &steps), 21.0);
        assert_eq!(normalize(0.2, &steps), 1.0);
        assert_eq!(normalize(7.25, &CFG), 7.3);
        let denoise = NumberSpec {
            min: 0.0,
            max: 1.0,
            step: 0.01,
            decimals: 2,
            fallback: 1.0,
        };
        assert_eq!(normalize(0.6_f32 as f64, &denoise), 0.6);
        assert_eq!(normalize(f64::NAN, &denoise), 1.0);
    }

    #[test]
    fn formats_without_trailing_zeros() {
        assert_eq!(format_value(7.5, &CFG), "7.5");
        assert_eq!(format_value(7.0, &CFG), "7");
        let steps = NumberSpec { decimals: 0, ..CFG };
        assert_eq!(format_value(20.0, &steps), "20");
    }
}
