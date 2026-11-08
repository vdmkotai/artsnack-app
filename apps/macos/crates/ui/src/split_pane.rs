//! Settings | results, with a handle between them (the web's `GenerateSplit`).
//!
//! - The left column takes `ratio` of the width, never less than 22.5 rem
//!   (360 px at 100 %), and the right column never less than 20 rem (320 px).
//!   Both minimums are rems, so they grow with zoom; the ratio laid out is the
//!   stored one fitted to the width the split really has, so a ratio saved in
//!   a wide window never pushes the right column out of a narrow one. A split
//!   too narrow for both minimums shares its width in their proportion.
//! - Drag the handle to resize; double-click resets to 40 %.
//! - The owner keeps the ratio (and persists it per composer); this element
//!   only reports the requested one, already fitted.

use std::rc::Rc;

use gpui_kit::{
    AnyElement, App, AppContext as _, Bounds, ClickEvent, Context, DragMoveEvent, ElementId,
    InteractiveElement as _, IntoElement, ParentElement as _, Pixels, Render, RenderOnce,
    StatefulInteractiveElement as _, Styled as _, Window, canvas,
    component::{ActiveTheme as _, h_flex},
    div,
    prelude::FluentBuilder as _,
    relative, rems,
};

pub const DEFAULT_SPLIT_RATIO: f32 = 0.4;
/// The narrowest the left column may be, in rems.
const LEFT_MIN_REMS: f32 = 22.5;
/// The narrowest the right column may be, in rems.
const RIGHT_MIN_REMS: f32 = 20.;
/// The handle between them (`w_3`), in rems.
const HANDLE_REMS: f32 = 0.75;

type RatioHandler = Rc<dyn Fn(f32, &mut Window, &mut App)>;

#[derive(IntoElement)]
pub struct SplitPane {
    id: ElementId,
    ratio: f32,
    left: AnyElement,
    right: AnyElement,
    on_resize: Option<RatioHandler>,
}

/// Identifies a drag of one split's handle.
#[derive(Clone)]
struct DraggedHandle(ElementId);

/// Nothing follows the pointer while resizing.
struct NoGhost;

impl Render for NoGhost {
    fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        div()
    }
}

impl SplitPane {
    pub fn new(
        id: impl Into<ElementId>,
        ratio: f32,
        left: impl IntoElement,
        right: impl IntoElement,
    ) -> Self {
        Self {
            id: id.into(),
            ratio: clamp_ratio(ratio),
            left: left.into_any_element(),
            right: right.into_any_element(),
            on_resize: None,
        }
    }

    /// Receives the requested ratio while dragging and on reset.
    pub fn on_resize(mut self, handler: impl Fn(f32, &mut Window, &mut App) + 'static) -> Self {
        self.on_resize = Some(Rc::new(handler));
        self
    }
}

/// A stored ratio outside (0, 1) is not a ratio; fall back to the default.
pub fn clamp_ratio(ratio: f32) -> f32 {
    if ratio.is_finite() && ratio > 0.0 && ratio < 1.0 {
        ratio
    } else {
        DEFAULT_SPLIT_RATIO
    }
}

/// `ratio` fitted to a split `width` wide (all lengths in pixels): the left
/// column at least `left_min`, the right one at least `right_min` beside a
/// `handle`. If the width cannot hold both minimums, it is shared in their
/// proportion. An unknown (zero) width leaves the ratio as it is.
pub fn fit_ratio(ratio: f32, width: f32, handle: f32, left_min: f32, right_min: f32) -> f32 {
    if width <= 0.0 || !width.is_finite() {
        return ratio;
    }
    let room = (width - handle).max(0.0);
    if left_min + right_min > room {
        return room * left_min / (left_min + right_min) / width;
    }
    ratio.clamp(left_min / width, (room - right_min) / width)
}

impl RenderOnce for SplitPane {
    fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let id = self.id.clone();
        let drag_id = self.id.clone();
        let on_move = self.on_resize.clone();
        let on_reset = self.on_resize.clone();
        // The rem of this subtree (a pane zoom may scale it), in pixels.
        let rem = window.rem_size().as_f32();
        let (left_min, right_min, handle) =
            (LEFT_MIN_REMS * rem, RIGHT_MIN_REMS * rem, HANDLE_REMS * rem);
        // The width the split had last frame; 0 until it has been drawn once.
        let measured = window.with_id(id.clone(), |window| {
            window.use_keyed_state("split-width", cx, |_, _| 0.0f32)
        });
        let width = *measured.read(cx);
        let ratio = fit_ratio(self.ratio, width, handle, left_min, right_min);

        h_flex()
            .id(self.id)
            .relative()
            .size_full()
            .items_stretch()
            .on_drag_move(move |event: &DragMoveEvent<DraggedHandle>, window, cx| {
                if event.drag(cx).0 != drag_id {
                    return;
                }
                let Some(on_move) = &on_move else { return };
                let width = event.bounds.size.width.as_f32();
                if width <= 0.0 {
                    return;
                }
                let x = (event.event.position.x - event.bounds.origin.x).as_f32();
                on_move(
                    fit_ratio(x / width, width, handle, left_min, right_min),
                    window,
                    cx,
                );
            })
            .child(
                div()
                    .h_full()
                    .w(relative(ratio))
                    .flex_shrink_0()
                    .min_h_0()
                    // Before the first measurement the minimum is the rule;
                    // after it the fitted ratio already honours it.
                    .when(width <= 0.0, |this| this.min_w(rems(LEFT_MIN_REMS)))
                    .child(self.left),
            )
            .child(
                div()
                    .id("split-handle")
                    .h_full()
                    .w_3()
                    .flex_shrink_0()
                    .flex()
                    .justify_center()
                    .cursor_col_resize()
                    .group("split-handle")
                    .child(
                        div()
                            .w_px()
                            .h_full()
                            .bg(cx.theme().border)
                            .group_hover("split-handle", |style| style.bg(cx.theme().ring)),
                    )
                    .tooltip(|window, cx| {
                        gpui_kit::component::tooltip::Tooltip::new(
                            "Drag to resize. Double-click to reset.",
                        )
                        .build(window, cx)
                    })
                    .on_drag(DraggedHandle(id), |_, _, _, cx| cx.new(|_| NoGhost))
                    .on_click(move |event: &ClickEvent, window, cx| {
                        if event.click_count() >= 2
                            && let Some(on_reset) = &on_reset
                        {
                            on_reset(DEFAULT_SPLIT_RATIO, window, cx);
                        }
                    }),
            )
            .child(
                div()
                    .h_full()
                    .flex_1()
                    .min_w_0()
                    .min_h_0()
                    .child(self.right),
            )
            // Measures the width the ratio is fitted to. A change shows on the
            // next frame: a notification during the draw would be dropped.
            .child(
                canvas(
                    move |bounds: Bounds<Pixels>, window, cx| {
                        let width = bounds.size.width.as_f32();
                        if (width - *measured.read(cx)).abs() > 0.5 {
                            let measured = measured.clone();
                            window.on_next_frame(move |_, cx| {
                                measured.update(cx, |measured, cx| {
                                    *measured = width;
                                    cx.notify();
                                });
                            });
                        }
                    },
                    |_, _, _, _| {},
                )
                .absolute()
                .size_full(),
            )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fits_the_ratio_to_both_minimums() {
        // 1000 px wide, 12 px handle, minimums 360 and 320.
        let fit = |ratio| fit_ratio(ratio, 1000.0, 12.0, 360.0, 320.0);
        assert_eq!(fit(0.5), 0.5);
        assert_eq!(fit(0.1), 0.36);
        // 95 % would leave the right column 38 px: it keeps its 320.
        assert_eq!(fit(0.95), 0.668);
        // Unknown width: unchanged.
        assert_eq!(fit_ratio(0.95, 0.0, 12.0, 360.0, 320.0), 0.95);
    }

    #[test]
    fn a_split_too_narrow_for_both_minimums_shares_in_their_proportion() {
        // 600 px: 588 px of room for 360 + 320 → 311.3 left, 276.7 right.
        let ratio = fit_ratio(0.4, 600.0, 12.0, 360.0, 320.0);
        let left = ratio * 600.0;
        assert!((left - 588.0 * 360.0 / 680.0).abs() < 0.01);
        assert!(left + 12.0 <= 600.0);
    }

    #[test]
    fn invalid_ratios_fall_back_to_the_default() {
        assert_eq!(clamp_ratio(0.6), 0.6);
        assert_eq!(clamp_ratio(1.5), DEFAULT_SPLIT_RATIO);
        assert_eq!(clamp_ratio(0.0), DEFAULT_SPLIT_RATIO);
        assert_eq!(clamp_ratio(f32::NAN), DEFAULT_SPLIT_RATIO);
    }
}
