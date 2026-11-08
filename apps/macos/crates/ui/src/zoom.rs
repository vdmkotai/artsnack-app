//! Zoom without a browser.
//!
//! GPUI has no page zoom. What it has is the rem: every rem-based size (text,
//! spacing, control heights, radii) is resolved against the window's rem size,
//! and GPUI Kit's Root sets that from the theme's base font each frame. So:
//!
//! - **window zoom** is a change of the theme's base font (done by the app shell);
//! - **pane zoom** is [`PaneZoom`], which scales the rem for one subtree;
//! - **tile size** in a results grid is just a number its layout multiplies by.
//!
//! What does not scale is anything given in `px`: hairline borders, shadows,
//! scrollbar widths, the focus ring. That is deliberate — those are physical
//! sizes — and is why application code uses rem helpers everywhere else.

use std::panic::Location;

use gpui_kit::{
    AnyElement, App, Bounds, ClickEvent, Element, ElementId, GlobalElementId, InspectorElementId,
    InteractiveElement as _, IntoElement, LayoutId, ParentElement as _, Pixels, RenderOnce,
    SharedString, Styled as _, Window,
    component::{
        ActiveTheme as _, Disableable as _, Sizable as _,
        button::{Button, ButtonVariants as _},
        h_flex,
    },
};

/// An ordered set of zoom factors that the −/+ controls step through.
#[derive(Clone, Copy, Debug)]
pub struct ZoomScale {
    steps: &'static [f32],
}

impl ZoomScale {
    /// Chrome's page-zoom presets, which the Electron shell used for Cmd +/−.
    pub const WINDOW: Self = Self {
        steps: &[
            0.5, 0.67, 0.75, 0.8, 0.9, 1.0, 1.1, 1.25, 1.5, 1.75, 2.0, 2.5, 3.0,
        ],
    };

    /// Pane zoom: the window presets up to 200 %, past which a half-window pane
    /// has no room left for its controls.
    pub const PANE: Self = Self {
        steps: &[0.5, 0.67, 0.75, 0.8, 0.9, 1.0, 1.1, 1.25, 1.5, 1.75, 2.0],
    };

    /// Result tile size: 25–200 % in 25 % steps, as the web's preview zoom.
    pub const TILES: Self = Self {
        steps: &[0.25, 0.5, 0.75, 1.0, 1.25, 1.5, 1.75, 2.0],
    };

    pub const fn new(steps: &'static [f32]) -> Self {
        Self { steps }
    }

    pub fn min(&self) -> f32 {
        self.steps[0]
    }

    pub fn max(&self) -> f32 {
        self.steps[self.steps.len() - 1]
    }

    /// The next step above `factor`, or the maximum.
    pub fn zoom_in(&self, factor: f32) -> f32 {
        self.steps
            .iter()
            .copied()
            .find(|step| *step > factor + f32::EPSILON)
            .unwrap_or_else(|| self.max())
    }

    /// The next step below `factor`, or the minimum.
    pub fn zoom_out(&self, factor: f32) -> f32 {
        self.steps
            .iter()
            .rev()
            .copied()
            .find(|step| *step < factor - f32::EPSILON)
            .unwrap_or_else(|| self.min())
    }

    /// `factor` clamped into this scale's range. A value saved by an older build
    /// with different steps stays as it was if it is in range.
    pub fn clamp(&self, factor: f32) -> f32 {
        if factor.is_finite() {
            factor.clamp(self.min(), self.max())
        } else {
            1.0
        }
    }
}

/// Renders `child` with the rem size multiplied by `factor`.
///
/// Everything inside that is sized in rems — text, padding, controls, icons —
/// grows or shrinks together. Popovers and menus opened from inside keep the
/// pane's zoom, because GPUI records the rem size in effect when a deferred
/// element is drawn. Window-level layers (dialogs, sheets, toasts) follow the
/// window zoom instead.
///
/// Code that converts rems to pixels in `render` (for example to give a virtual
/// list its item sizes) runs before this element and sees the window's rem; it
/// must multiply by the same factor itself.
pub fn pane_zoom(factor: f32, child: impl IntoElement) -> PaneZoom {
    PaneZoom {
        factor,
        child: child.into_any_element(),
    }
}

pub struct PaneZoom {
    factor: f32,
    child: AnyElement,
}

impl IntoElement for PaneZoom {
    type Element = Self;

    fn into_element(self) -> Self::Element {
        self
    }
}

impl Element for PaneZoom {
    /// The scaled rem, resolved once so all three phases agree.
    type RequestLayoutState = Pixels;
    type PrepaintState = ();

    fn id(&self) -> Option<ElementId> {
        None
    }

    fn source_location(&self) -> Option<&'static Location<'static>> {
        None
    }

    fn request_layout(
        &mut self,
        _: Option<&GlobalElementId>,
        _: Option<&InspectorElementId>,
        window: &mut Window,
        cx: &mut App,
    ) -> (LayoutId, Self::RequestLayoutState) {
        let rem = window.rem_size() * self.factor;
        let layout_id =
            window.with_rem_size(Some(rem), |window| self.child.request_layout(window, cx));
        (layout_id, rem)
    }

    fn prepaint(
        &mut self,
        _: Option<&GlobalElementId>,
        _: Option<&InspectorElementId>,
        _: Bounds<Pixels>,
        rem: &mut Self::RequestLayoutState,
        window: &mut Window,
        cx: &mut App,
    ) -> Self::PrepaintState {
        window.with_rem_size(Some(*rem), |window| {
            self.child.prepaint(window, cx);
        });
    }

    fn paint(
        &mut self,
        _: Option<&GlobalElementId>,
        _: Option<&InspectorElementId>,
        _: Bounds<Pixels>,
        rem: &mut Self::RequestLayoutState,
        _: &mut Self::PrepaintState,
        window: &mut Window,
        cx: &mut App,
    ) {
        window.with_rem_size(Some(*rem), |window| self.child.paint(window, cx));
    }
}

type ZoomHandler = Box<dyn Fn(f32, &mut Window, &mut App) + 'static>;

/// A compact − / 100 % / + control. Clicking the percentage resets to 100 %.
///
/// Controlled: the owner passes the current factor and stores the requested one.
#[derive(IntoElement)]
pub struct ZoomControl {
    id: ElementId,
    factor: f32,
    scale: ZoomScale,
    label: SharedString,
    on_change: Option<ZoomHandler>,
}

impl ZoomControl {
    /// `label` names what is zoomed, for the tooltips ("form", "tiles").
    pub fn new(
        id: impl Into<ElementId>,
        factor: f32,
        scale: ZoomScale,
        label: impl Into<SharedString>,
    ) -> Self {
        Self {
            id: id.into(),
            factor,
            scale,
            label: label.into(),
            on_change: None,
        }
    }

    /// Receives the requested factor.
    pub fn on_change(mut self, handler: impl Fn(f32, &mut Window, &mut App) + 'static) -> Self {
        self.on_change = Some(Box::new(handler));
        self
    }
}

impl RenderOnce for ZoomControl {
    fn render(self, _: &mut Window, cx: &mut App) -> impl IntoElement {
        let Self {
            id,
            factor,
            scale,
            label,
            on_change,
        } = self;
        let on_change = on_change.map(std::rc::Rc::new);
        let request = |next: f32| {
            let on_change = on_change.clone();
            move |_: &ClickEvent, window: &mut Window, cx: &mut App| {
                if let Some(on_change) = &on_change {
                    on_change(next, window, cx);
                }
            }
        };
        let percent: SharedString = format!("{}%", (factor * 100.0).round() as i32).into();

        h_flex()
            .id(id)
            .gap_0p5()
            .text_color(cx.theme().muted_foreground)
            .child(
                Button::new("zoom-out")
                    .ghost()
                    .xsmall()
                    .icon(gpui_kit::assets::IconName::Minus)
                    .tooltip(format!("Smaller {label}"))
                    .disabled(factor <= scale.min() + f32::EPSILON)
                    .on_click(request(scale.zoom_out(factor))),
            )
            .child(
                Button::new("zoom-reset")
                    .ghost()
                    .xsmall()
                    .label(percent)
                    .tooltip(format!("Reset {label} to 100%"))
                    .on_click(request(1.0)),
            )
            .child(
                Button::new("zoom-in")
                    .ghost()
                    .xsmall()
                    .icon(gpui_kit::assets::IconName::Plus)
                    .tooltip(format!("Larger {label}"))
                    .disabled(factor >= scale.max() - f32::EPSILON)
                    .on_click(request(scale.zoom_in(factor))),
            )
    }
}

#[cfg(test)]
mod tests {
    use super::ZoomScale;

    #[test]
    fn steps_through_presets_and_stops_at_the_ends() {
        let scale = ZoomScale::WINDOW;
        assert_eq!(scale.zoom_in(1.0), 1.1);
        assert_eq!(scale.zoom_out(1.0), 0.9);
        assert_eq!(scale.zoom_in(3.0), 3.0);
        assert_eq!(scale.zoom_out(0.5), 0.5);
    }

    #[test]
    fn a_factor_between_steps_moves_to_the_neighbouring_step() {
        let scale = ZoomScale::TILES;
        assert_eq!(scale.zoom_in(1.1), 1.25);
        assert_eq!(scale.zoom_out(1.1), 1.0);
    }

    #[test]
    fn clamps_out_of_range_and_non_finite_values() {
        assert_eq!(ZoomScale::PANE.clamp(5.0), 2.0);
        assert_eq!(ZoomScale::PANE.clamp(f32::NAN), 1.0);
    }
}
