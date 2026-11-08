//! Form pieces both families are built from (the web's `h3/form-controls.tsx`):
//! labelled fields with "recommended" marks and advice, switch rows, number
//! fields, the checkpoint picker's rows and the image slots.

use std::{rc::Rc, sync::Arc};

use gpui_kit::{
    AnyElement, App, AppContext as _, ClickEvent, Context, Div, ElementId, Entity, ExternalPaths,
    FontWeight, ImageSource, InteractiveElement as _, IntoElement, ObjectFit, ParentElement,
    RenderImage, RenderOnce, SharedString, StatefulInteractiveElement as _, Styled as _,
    StyledImage as _, Window,
    assets::IconName,
    component::{
        ActiveTheme as _, Disableable as _, Icon, Sizable as _,
        button::{Button, ButtonVariants as _},
        h_flex,
        input::InputState,
        searchable_list::SearchableListItem,
        spinner::Spinner,
        switch::Switch,
        tag::Tag,
        tooltip::Tooltip,
        v_flex,
    },
    div, img,
    prelude::FluentBuilder as _,
};

use crate::form::{Advice, AdviceKind};

/// The bounds and display of a typed number.
#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) struct NumberSpec {
    pub min: f64,
    pub max: f64,
    pub step: f64,
    /// Digits after the point when shown.
    pub decimals: usize,
}

impl NumberSpec {
    pub const fn new(min: f64, max: f64, step: f64, decimals: usize) -> Self {
        Self {
            min,
            max,
            step,
            decimals,
        }
    }

    pub fn clamp(&self, value: f64) -> f64 {
        if value.is_finite() {
            value.clamp(self.min, self.max)
        } else {
            self.min
        }
    }

    pub fn format(&self, value: f64) -> String {
        let text = format!("{value:.precision$}", precision = self.decimals);
        if self.decimals > 0 {
            // 7.50 → 7.5, 1.00 → 1
            text.trim_end_matches('0').trim_end_matches('.').to_string()
        } else {
            text
        }
    }
}

/// A number field (render it with `NumberInput`): its −/+ buttons step and
/// clamp, and leaving the field clamps what was typed, as the web's
/// `NumberInput` does on blur.
pub(crate) fn number_state<T: 'static>(
    value: f64,
    spec: NumberSpec,
    window: &mut Window,
    cx: &mut Context<T>,
) -> Entity<InputState> {
    cx.new(|cx| {
        InputState::new(window, cx)
            .default_value(spec.format(value))
            .step(spec.step)
            .min(spec.min)
            .max(spec.max)
            .validate(|text, _| is_number_text(text))
    })
}

/// What a number field holds, or `None` while it is not a number yet.
pub(crate) fn parse_number(text: &str) -> Option<f64> {
    text.trim()
        .parse::<f64>()
        .ok()
        .filter(|value| value.is_finite())
}

/// Digits, one point and a leading minus, or nothing yet.
fn is_number_text(text: &str) -> bool {
    let digits = text.strip_prefix('-').unwrap_or(text);
    digits.chars().all(|c| c.is_ascii_digit() || c == '.') && digits.matches('.').count() <= 1
}

/// A checkpoint in a picker: its name, and what it is on a second line.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct ModelChoice {
    pub value: SharedString,
    pub title: SharedString,
    pub note: SharedString,
}

impl SearchableListItem for ModelChoice {
    type Value = SharedString;

    fn title(&self) -> SharedString {
        self.title.clone()
    }

    fn render(&self, _: &mut Window, cx: &mut App) -> impl IntoElement {
        v_flex()
            .min_w_0()
            .py_0p5()
            .child(div().truncate().child(self.title.clone()))
            .child(
                div()
                    .truncate()
                    .text_xs()
                    .text_color(cx.theme().muted_foreground)
                    .child(self.note.clone()),
            )
    }

    fn value(&self) -> &SharedString {
        &self.value
    }

    fn matches(&self, query: &str) -> bool {
        let query = query.to_lowercase();
        self.title.to_lowercase().contains(&query) || self.note.to_lowercase().contains(&query)
    }
}

/// The line under a control that is worth a second look.
pub(crate) fn advice_line(advice: &Advice, cx: &App) -> Div {
    let (icon, color) = match advice.kind {
        AdviceKind::Warn => (IconName::CircleAlert, cx.theme().warning),
        AdviceKind::Tip => (IconName::Lightbulb, cx.theme().info),
    };
    h_flex()
        .items_start()
        .gap_1()
        .text_xs()
        .text_color(color)
        .child(div().pt_0p5().child(Icon::new(icon).xsmall()))
        .child(div().min_w_0().child(advice.text.clone()))
}

/// Muted help under a control.
pub(crate) fn hint(text: impl Into<SharedString>, cx: &App) -> Div {
    div()
        .text_xs()
        .text_color(cx.theme().muted_foreground)
        .child(text.into())
}

pub(crate) fn recommended_mark(id: impl Into<ElementId>) -> impl IntoElement {
    div()
        .id(id)
        .child(Tag::success().outline().xsmall().child("Recommended"))
        .tooltip(|window, cx| Tooltip::new("Recommended setting").build(window, cx))
}

pub(crate) fn community_mark(id: impl Into<ElementId>) -> impl IntoElement {
    div()
        .id(id)
        .child(Tag::secondary().outline().xsmall().child("Community"))
        .tooltip(|window, cx| {
            Tooltip::new("Community add-on — not part of official MiniMax H3").build(window, cx)
        })
}

/// A labelled row of the form: the label (with its mark), the control, then
/// its hint and advice.
#[derive(IntoElement)]
pub(crate) struct Field {
    id: ElementId,
    label: SharedString,
    recommended: bool,
    hint: Option<SharedString>,
    advice: Option<Advice>,
    children: Vec<AnyElement>,
}

impl Field {
    pub fn new(id: impl Into<ElementId>, label: impl Into<SharedString>) -> Self {
        Self {
            id: id.into(),
            label: label.into(),
            recommended: false,
            hint: None,
            advice: None,
            children: Vec::new(),
        }
    }

    pub fn recommended(mut self, recommended: bool) -> Self {
        self.recommended = recommended;
        self
    }

    pub fn hint(mut self, hint: Option<impl Into<SharedString>>) -> Self {
        self.hint = hint.map(Into::into);
        self
    }

    pub fn advice(mut self, advice: Option<Advice>) -> Self {
        self.advice = advice;
        self
    }
}

impl ParentElement for Field {
    fn extend(&mut self, elements: impl IntoIterator<Item = AnyElement>) {
        self.children.extend(elements);
    }
}

impl RenderOnce for Field {
    fn render(self, _: &mut Window, cx: &mut App) -> impl IntoElement {
        let mark_id = ElementId::NamedChild(Arc::new(self.id.clone()), "recommended".into());
        v_flex()
            .min_w_0()
            .gap_1p5()
            .child(
                h_flex()
                    .flex_wrap()
                    .gap_1p5()
                    .child(
                        div()
                            .text_sm()
                            .font_weight(FontWeight::MEDIUM)
                            .child(self.label),
                    )
                    .when(self.recommended, |this| {
                        this.child(recommended_mark(mark_id))
                    }),
            )
            .children(self.children)
            .when_some(self.hint, |this, text| this.child(hint(text, cx)))
            .when_some(self.advice, |this, advice| {
                this.child(advice_line(&advice, cx))
            })
    }
}

type SwitchHandler = Rc<dyn Fn(&bool, &mut Window, &mut App)>;

/// A setting that is on or off (the web's `Toggle`): label and marks, a hint,
/// advice, and the switch. A warning tints its border.
#[derive(IntoElement)]
pub(crate) struct ToggleRow {
    id: ElementId,
    label: SharedString,
    hint: Option<SharedString>,
    recommended: bool,
    community: bool,
    advice: Option<Advice>,
    checked: bool,
    disabled: bool,
    /// Inside a group box the box is the boundary; the row draws none.
    boxed: bool,
    on_change: Option<SwitchHandler>,
}

impl ToggleRow {
    pub fn new(id: impl Into<ElementId>, label: impl Into<SharedString>, checked: bool) -> Self {
        Self {
            id: id.into(),
            label: label.into(),
            hint: None,
            recommended: false,
            community: false,
            advice: None,
            checked,
            disabled: false,
            boxed: true,
            on_change: None,
        }
    }

    pub fn hint(mut self, hint: impl Into<SharedString>) -> Self {
        self.hint = Some(hint.into());
        self
    }

    pub fn recommended(mut self, recommended: bool) -> Self {
        self.recommended = recommended;
        self
    }

    /// A community add-on rather than part of official H3.
    pub fn community(mut self) -> Self {
        self.community = true;
        self
    }

    pub fn advice(mut self, advice: Option<Advice>) -> Self {
        self.advice = advice;
        self
    }

    pub fn disabled(mut self, disabled: bool) -> Self {
        self.disabled = disabled;
        self
    }

    /// A row of a [`group_box`]: no border of its own.
    pub fn unboxed(mut self) -> Self {
        self.boxed = false;
        self
    }

    pub fn on_change(mut self, handler: impl Fn(&bool, &mut Window, &mut App) + 'static) -> Self {
        self.on_change = Some(Rc::new(handler));
        self
    }
}

impl RenderOnce for ToggleRow {
    fn render(self, _: &mut Window, cx: &mut App) -> impl IntoElement {
        let warn = self
            .advice
            .as_ref()
            .is_some_and(|advice| advice.kind == AdviceKind::Warn);
        let id = Arc::new(self.id.clone());
        let label = self.label.clone();
        h_flex()
            .id(self.id)
            .items_start()
            .justify_between()
            .gap_3()
            .when(self.boxed, |this| {
                this.px_3()
                    .py_2()
                    .rounded(cx.theme().radius)
                    .border_1()
                    .border_color(if warn {
                        cx.theme().warning.opacity(0.5)
                    } else {
                        cx.theme().border
                    })
            })
            .child(
                v_flex()
                    .min_w_0()
                    .flex_1()
                    .gap_0p5()
                    .child(
                        h_flex()
                            .flex_wrap()
                            .gap_1p5()
                            .child(
                                div()
                                    .text_sm()
                                    .font_weight(FontWeight::MEDIUM)
                                    .child(self.label),
                            )
                            .when(self.recommended, |this| {
                                this.child(recommended_mark(ElementId::NamedChild(
                                    id.clone(),
                                    "recommended".into(),
                                )))
                            })
                            .when(self.community, |this| {
                                this.child(community_mark(ElementId::NamedChild(
                                    id.clone(),
                                    "community".into(),
                                )))
                            }),
                    )
                    .when_some(self.hint, |this, text| this.child(hint(text, cx)))
                    .when_some(self.advice, |this, advice| {
                        this.child(advice_line(&advice, cx))
                    }),
            )
            .child(
                Switch::new(ElementId::NamedChild(id, "switch".into()))
                    .checked(self.checked)
                    .disabled(self.disabled)
                    .accessibility_label(label)
                    .when_some(self.on_change, |this, handler| {
                        this.on_change(move |checked, window, cx| handler(checked, window, cx))
                    }),
            )
    }
}

/// A block of related settings with a hairline boundary (Sigma shift, Speed,
/// Community add-ons).
pub(crate) fn group_box(cx: &App) -> Div {
    v_flex()
        .gap_2()
        .p_3()
        .rounded(cx.theme().radius_lg)
        .border_1()
        .border_color(cx.theme().border)
}

/// A section's title.
pub(crate) fn section_title(text: impl Into<SharedString>) -> Div {
    div()
        .text_sm()
        .font_weight(FontWeight::MEDIUM)
        .child(text.into())
}

/// One option in a wrapping row of choices (sizes, pods).
pub(crate) fn choice(
    id: impl Into<ElementId>,
    label: impl Into<SharedString>,
    selected: bool,
) -> Button {
    use gpui_kit::component::Selectable as _;
    Button::new(id)
        .small()
        .outline()
        .label(label.into())
        .selected(selected)
}

type ClickHandler = Rc<dyn Fn(&ClickEvent, &mut Window, &mut App)>;
type DropHandler = Rc<dyn Fn(&ExternalPaths, &mut Window, &mut App)>;

/// One input image, or the two ways to fill an empty slot: a file from disk
/// or an image from favourites and history. Files dropped on it fill it too.
#[derive(IntoElement)]
pub(crate) struct ImageSlot {
    id: SharedString,
    label: SharedString,
    /// The number the prompt's `@imageN` tag refers to.
    badge: Option<usize>,
    image: Option<Arc<RenderImage>>,
    preparing: bool,
    /// Icons only, for a narrow slot.
    compact: bool,
    on_upload: Option<ClickHandler>,
    on_gallery: Option<ClickHandler>,
    on_clear: Option<ClickHandler>,
    on_drop: Option<DropHandler>,
}

impl ImageSlot {
    pub fn new(id: impl Into<SharedString>, label: impl Into<SharedString>) -> Self {
        Self {
            id: id.into(),
            label: label.into(),
            badge: None,
            image: None,
            preparing: false,
            compact: false,
            on_upload: None,
            on_gallery: None,
            on_clear: None,
            on_drop: None,
        }
    }

    pub fn badge(mut self, badge: usize) -> Self {
        self.badge = Some(badge);
        self
    }

    pub fn image(mut self, image: Option<Arc<RenderImage>>) -> Self {
        self.image = image;
        self
    }

    pub fn preparing(mut self, preparing: bool) -> Self {
        self.preparing = preparing;
        self
    }

    pub fn compact(mut self) -> Self {
        self.compact = true;
        self
    }

    pub fn on_upload(
        mut self,
        handler: impl Fn(&ClickEvent, &mut Window, &mut App) + 'static,
    ) -> Self {
        self.on_upload = Some(Rc::new(handler));
        self
    }

    pub fn on_gallery(
        mut self,
        handler: impl Fn(&ClickEvent, &mut Window, &mut App) + 'static,
    ) -> Self {
        self.on_gallery = Some(Rc::new(handler));
        self
    }

    pub fn on_clear(
        mut self,
        handler: impl Fn(&ClickEvent, &mut Window, &mut App) + 'static,
    ) -> Self {
        self.on_clear = Some(Rc::new(handler));
        self
    }

    pub fn on_drop(
        mut self,
        handler: impl Fn(&ExternalPaths, &mut Window, &mut App) + 'static,
    ) -> Self {
        self.on_drop = Some(Rc::new(handler));
        self
    }
}

impl RenderOnce for ImageSlot {
    fn render(self, _: &mut Window, cx: &mut App) -> impl IntoElement {
        let theme = cx.theme().clone();
        let id = self.id.clone();
        let child_id = |suffix: &str| SharedString::from(format!("{id}-{suffix}"));
        let body: AnyElement = match (self.image, self.preparing) {
            (Some(image), _) => div()
                .id(child_id("filled"))
                .relative()
                .w_full()
                .aspect_ratio(16. / 9.)
                .rounded(theme.radius)
                .overflow_hidden()
                .border_1()
                .border_color(theme.border)
                .child(
                    img(ImageSource::Render(image))
                        .size_full()
                        .object_fit(ObjectFit::Cover),
                )
                .when_some(self.badge, |this, badge| {
                    this.child(
                        div()
                            .absolute()
                            .top_1()
                            .left_1()
                            .px_1p5()
                            .rounded(theme.radius)
                            .bg(theme.background.opacity(0.9))
                            .text_xs()
                            .font_family(theme.mono_font_family.clone())
                            .font_weight(FontWeight::SEMIBOLD)
                            .child(format!("@image{badge}")),
                    )
                })
                .when_some(self.on_clear, |this, on_clear| {
                    this.child(
                        div().absolute().top_1().right_1().child(
                            Button::new(child_id("remove"))
                                .xsmall()
                                .icon(IconName::X)
                                .accessibility_label(format!(
                                    "Remove {}",
                                    self.label.to_lowercase()
                                ))
                                .tooltip(format!("Remove {}", self.label.to_lowercase()))
                                .on_click(move |event, window, cx| on_clear(event, window, cx)),
                        ),
                    )
                })
                .into_any_element(),
            (None, true) => div()
                .w_full()
                .aspect_ratio(16. / 9.)
                .flex()
                .items_center()
                .justify_center()
                .rounded(theme.radius)
                .border_1()
                .border_dashed()
                .border_color(theme.border)
                .child(Spinner::new().small())
                .into_any_element(),
            (None, false) => h_flex()
                .w_full()
                .aspect_ratio(16. / 9.)
                .items_stretch()
                .rounded(theme.radius)
                .border_1()
                .border_dashed()
                .border_color(theme.border)
                .overflow_hidden()
                .child(
                    Button::new(child_id("upload"))
                        .ghost()
                        .small()
                        .flex_1()
                        .h_full()
                        .rounded_none()
                        .icon(IconName::Upload)
                        .when(!self.compact, |this| this.label("Upload"))
                        .accessibility_label("Upload")
                        .tooltip("Upload from disk (or drop or paste an image)")
                        .disabled(self.on_upload.is_none())
                        .when_some(self.on_upload, |this, handler| {
                            this.on_click(move |event, window, cx| handler(event, window, cx))
                        }),
                )
                .child(div().w_px().h_full().bg(theme.border))
                .child(
                    Button::new(child_id("gallery"))
                        .ghost()
                        .small()
                        .flex_1()
                        .h_full()
                        .rounded_none()
                        .icon(IconName::Images)
                        .when(!self.compact, |this| this.label("Gallery…"))
                        .accessibility_label("Gallery…")
                        .tooltip("Pick from favourites or history")
                        .disabled(self.on_gallery.is_none())
                        .when_some(self.on_gallery, |this, handler| {
                            this.on_click(move |event, window, cx| handler(event, window, cx))
                        }),
                )
                .into_any_element(),
        };
        let drop_tint = theme.primary.opacity(0.08);
        v_flex()
            .id(id.clone())
            .min_w_0()
            .gap_1()
            .rounded(theme.radius)
            .child(
                div()
                    .text_xs()
                    .text_color(theme.muted_foreground)
                    .truncate()
                    .child(self.label),
            )
            .child(body)
            .when_some(self.on_drop, |this, handler| {
                this.drag_over::<ExternalPaths>(move |style, _, _, _| style.bg(drop_tint))
                    .on_drop(move |paths: &ExternalPaths, window, cx| handler(paths, window, cx))
            })
    }
}
