//! The parts both backend panels are built from: labelled form cells, number
//! fields, the GPU picker's rows, and the active backend's card pieces.

use std::rc::Rc;

use artsnack_backend::api::runpod_backends::BackendState;
use gpui_kit::{
    AnyElement, App, AppContext as _, Context, Div, ElementId, Entity, FontWeight,
    InteractiveElement as _, IntoElement, ParentElement as _, RenderOnce, SharedString,
    StatefulInteractiveElement as _, Styled as _, Window,
    assets::IconName,
    base::{Checkbox as BaseCheckbox, CheckboxIndicator, CheckboxState},
    component::{
        ActiveTheme as _, Disableable as _, Icon, Sizable as _, StyledExt as _, ThemeStyled as _,
        button::{Button, ButtonVariants as _},
        h_flex,
        input::InputState,
        progress::Progress,
        searchable_list::SearchableListItem,
        spinner::Spinner,
        tag::Tag,
        tooltip::Tooltip,
        v_flex,
    },
    div,
    prelude::FluentBuilder as _,
    px, rems,
};

use crate::format::plain_number;

/// One cell of a launch form: its label above, the control, and an optional
/// note under it.
pub(crate) fn field(label: &'static str, control: impl IntoElement, cx: &App) -> Div {
    v_flex()
        .min_w_0()
        .gap_1p5()
        .child(
            div()
                .text_sm()
                .font_weight(FontWeight::MEDIUM)
                .text_color(cx.theme().foreground)
                .child(label),
        )
        .child(control)
}

/// The note under a field.
pub(crate) fn note(text: impl Into<SharedString>, cx: &App) -> Div {
    div()
        .text_xs()
        .text_color(cx.theme().muted_foreground)
        .child(text.into())
}

/// A number the user types or steps. Stepping clamps to the range, and so
/// does leaving the field; [`number_value`] reads it the web's way.
pub(crate) fn number_input<T: 'static>(
    value: f64,
    step: f64,
    min: f64,
    max: Option<f64>,
    window: &mut Window,
    cx: &mut Context<T>,
) -> Entity<InputState> {
    cx.new(|cx| {
        let state = InputState::new(window, cx)
            .default_value(plain_number(value))
            .step(step)
            .min(min)
            .validate(|text, _| is_number_text(text));
        match max {
            Some(max) => state.max(max),
            None => state,
        }
    })
}

/// What a number field holds: an empty or unreadable entry is 0, as
/// `Number(value) || 0` reads it on the web.
pub(crate) fn number_value(input: &Entity<InputState>, cx: &App) -> f64 {
    input
        .read(cx)
        .value()
        .trim()
        .parse::<f64>()
        .ok()
        .filter(|value| value.is_finite())
        .unwrap_or(0.0)
}

/// Digits with at most one decimal point, or nothing yet.
fn is_number_text(text: &str) -> bool {
    text.chars().all(|c| c.is_ascii_digit() || c == '.') && text.matches('.').count() <= 1
}

/// A GPU in a picker: its name, and its specs and prices on a second line.
/// Both lines are always drawn — the list sizes every row like its first.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct GpuChoice {
    pub value: SharedString,
    pub name: SharedString,
    pub description: SharedString,
}

impl SearchableListItem for GpuChoice {
    type Value = SharedString;

    fn title(&self) -> SharedString {
        self.name.clone()
    }

    fn render(&self, _: &mut Window, cx: &mut App) -> impl IntoElement {
        v_flex()
            .min_w_0()
            .py_0p5()
            .child(div().truncate().child(self.name.clone()))
            .child(
                div()
                    .truncate()
                    .text_xs()
                    .text_color(cx.theme().muted_foreground)
                    .child(if self.description.is_empty() {
                        // Keeps the second line's height.
                        SharedString::from("\u{a0}")
                    } else {
                        self.description.clone()
                    }),
            )
    }

    fn value(&self) -> &SharedString {
        &self.value
    }

    fn matches(&self, query: &str) -> bool {
        let query = query.to_lowercase();
        self.name.to_lowercase().contains(&query)
            || self.description.to_lowercase().contains(&query)
    }
}

/// Booting, starting or being destroyed: worth checking often.
pub(crate) fn is_changing(state: BackendState) -> bool {
    state.is_booting() || state == BackendState::Destroying
}

/// The state as a tag. Ready and error carry meaning; the rest stay neutral.
pub(crate) fn state_tag(state: BackendState) -> Tag {
    match state {
        BackendState::Ready => Tag::success(),
        BackendState::Error => Tag::danger(),
        _ => Tag::secondary(),
    }
    .small()
    .child(state.label())
}

/// The backend's own message, its percentage and the bar under them.
pub(crate) fn progress_block(
    id: impl Into<ElementId>,
    message: &str,
    progress: f64,
    cx: &App,
) -> impl IntoElement {
    let progress = progress.clamp(0.0, 100.0);
    v_flex()
        .gap_1p5()
        .child(
            h_flex()
                .justify_between()
                .gap_3()
                .text_sm()
                .child(div().min_w_0().child(message.to_string()))
                .child(
                    div()
                        .flex_shrink_0()
                        .font_family(cx.theme().mono_font_family.clone())
                        .child(format!("{}%", progress.round() as i64)),
                ),
        )
        // A sliver stays visible at 0% so the bar reads as a bar.
        .child(Progress::new(id).value(progress.max(2.0) as f32))
}

/// A row of facts under a backend's progress.
pub(crate) fn facts(items: Vec<String>, cx: &App) -> impl IntoElement {
    h_flex()
        .flex_wrap()
        .gap_x_6()
        .gap_y_1()
        .text_sm()
        .text_color(cx.theme().muted_foreground)
        .children(items.into_iter().map(|item| div().child(item)))
}

/// A box for a backend card or a summary: a hairline and the large radius.
pub(crate) fn card(cx: &App) -> Div {
    v_flex()
        .gap_4()
        .p_4()
        .rounded(cx.theme().radius_lg)
        .border_1()
        .border_color(cx.theme().border)
}

/// "Loading … state" while the backend row is not known yet.
pub(crate) fn loading(text: &'static str, cx: &App) -> impl IntoElement {
    h_flex()
        .justify_center()
        .gap_2()
        .py_12()
        .text_sm()
        .text_color(cx.theme().muted_foreground)
        .child(Spinner::new().small())
        .child(text)
}

/// The destroy confirmation under a backend card. Destroying is permanent
/// and the card is already in view, so it is confirmed in place.
pub(crate) fn destroy_confirmation(
    question: &'static str,
    consequence: String,
    destroying: bool,
    on_destroy: impl Fn(&gpui_kit::ClickEvent, &mut Window, &mut App) + 'static,
    on_cancel: impl Fn(&gpui_kit::ClickEvent, &mut Window, &mut App) + 'static,
    cx: &App,
) -> impl IntoElement {
    let danger = cx.theme().danger;
    v_flex()
        .gap_3()
        .p_4()
        .rounded(cx.theme().radius_lg)
        .border_1()
        .border_color(danger.opacity(0.3))
        .bg(danger.opacity(0.06))
        .child(
            v_flex()
                .gap_1()
                .child(div().font_weight(FontWeight::MEDIUM).child(question))
                .child(
                    div()
                        .text_sm()
                        .text_color(cx.theme().muted_foreground)
                        .child(consequence),
                ),
        )
        .child(
            h_flex()
                .gap_2()
                .child(
                    Button::new("destroy-permanently")
                        .danger()
                        .label("Destroy permanently")
                        .loading(destroying)
                        .disabled(destroying)
                        .on_click(on_destroy),
                )
                .child(
                    Button::new("cancel-destroy")
                        .outline()
                        .label("Cancel")
                        .on_click(on_cancel),
                ),
        )
}

/// Wraps `child` so it shows `text` on hover.
pub(crate) fn with_tooltip(
    id: impl Into<ElementId>,
    text: impl Into<SharedString>,
    child: impl IntoElement,
) -> impl IntoElement {
    let text = text.into();
    div()
        .id(id)
        .tooltip(move |window, cx| Tooltip::new(text.clone()).build(window, cx))
        .child(child)
}

/// A group's checkbox: checked when every member is, mixed when only some
/// are — the web's `indeterminate`, which GPUI Kit's styled `Checkbox` does
/// not draw. Behaviour (toggling, focus, keys, the mixed state for screen
/// readers) is the base checkbox's; this only draws it like its neighbours.
#[derive(IntoElement)]
pub(crate) struct GroupCheckbox {
    id: ElementId,
    state: CheckboxState,
    label: SharedString,
    children: Vec<AnyElement>,
    on_change: Option<Rc<dyn Fn(bool, &mut Window, &mut App)>>,
}

impl GroupCheckbox {
    pub fn new(id: impl Into<ElementId>, label: impl Into<SharedString>) -> Self {
        Self {
            id: id.into(),
            state: CheckboxState::Unchecked,
            label: label.into(),
            children: Vec::new(),
            on_change: None,
        }
    }

    /// From how many of `total` members are checked.
    pub fn checked_count(mut self, checked: usize, total: usize) -> Self {
        self.state = if total > 0 && checked == total {
            CheckboxState::Checked
        } else if checked == 0 {
            CheckboxState::Unchecked
        } else {
            CheckboxState::Indeterminate
        };
        self
    }

    /// Text after the label, such as a count.
    pub fn suffix(mut self, suffix: impl IntoElement) -> Self {
        self.children.push(suffix.into_any_element());
        self
    }

    /// Receives `true` to check every member, `false` to clear them. A mixed
    /// group checks all, as a native mixed checkbox does.
    pub fn on_change(mut self, handler: impl Fn(bool, &mut Window, &mut App) + 'static) -> Self {
        self.on_change = Some(Rc::new(handler));
        self
    }
}

impl RenderOnce for GroupCheckbox {
    fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let focus_handle = window
            .use_keyed_state(self.id.clone(), cx, |_, cx| {
                cx.focus_handle().tab_stop(true)
            })
            .read(cx)
            .clone();
        let focused = focus_handle.is_focused(window);
        let theme = cx.theme();
        let marked = self.state != CheckboxState::Unchecked;
        let (border, fill) = if marked {
            (theme.primary, theme.primary)
        } else {
            (theme.input, theme.input_background())
        };
        let mark = match self.state {
            CheckboxState::Checked => Some(IconName::Check),
            CheckboxState::Indeterminate => Some(IconName::Minus),
            CheckboxState::Unchecked => None,
        };
        let mark_color = theme.primary_foreground;
        let foreground = theme.foreground;
        // The styled Checkbox's own corner: never rounder than 4px whatever
        // the theme says, so this box matches the checkboxes beside it.
        let radius = theme.radius.min(px(4.));

        BaseCheckbox::new(self.id)
            .state(self.state)
            .track_focus(&focus_handle)
            .accessibility_label(self.label.clone())
            .when_some(self.on_change, |this, on_change| {
                this.on_change(move |next, _, window, cx| {
                    on_change(next == CheckboxState::Checked, window, cx)
                })
            })
            .h_flex()
            .gap_2()
            .items_center()
            .rounded(theme.radius * 0.5)
            .when(focused, |this| this.focus_ring_style(window, cx))
            .child(
                CheckboxIndicator::new()
                    .state(self.state)
                    .flex()
                    .flex_shrink_0()
                    .items_center()
                    .justify_center()
                    .size(rems(1.))
                    .border_1()
                    .rounded(radius)
                    .border_color(border)
                    .bg(fill)
                    .when_some(mark, |this, mark| {
                        this.child(Icon::new(mark).size_3().text_color(mark_color))
                    }),
            )
            .child(
                div()
                    .font_weight(FontWeight::MEDIUM)
                    .text_color(foreground)
                    .child(self.label),
            )
            .children(self.children)
    }
}
