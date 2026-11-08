//! The reference tray: the selected images, in order, over the bottom of the
//! grid. Drag a thumbnail onto another to move it there; "Use N as
//! references" hands them to the API tab in that order.

use artsnack_media::{Media, media_image};
use gpui_kit::{
    AnyElement, AppContext as _, Context, FontWeight, InteractiveElement as _, IntoElement,
    ObjectFit, ParentElement as _, Render, SharedString, StatefulInteractiveElement as _,
    Styled as _, StyledImage as _, Window,
    assets::IconName,
    component::{
        ActiveTheme as _, Icon, Sizable as _,
        button::{Button, ButtonVariants as _},
        h_flex,
    },
    div, img, rems,
};

use super::SearchView;
use crate::{
    engine::MAX_SEARCH_REFERENCES,
    results::{self, key},
};

/// A thumbnail being dragged to a new place.
#[derive(Clone)]
struct DraggedReference {
    from: usize,
}

/// What follows the pointer while dragging: the thumbnail itself.
struct ReferenceGhost {
    preview: artsnack_media::ImageRequest,
}

impl Render for ReferenceGhost {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        img(media_image(self.preview.clone()))
            .size(rems(3.5))
            .rounded(cx.theme().radius)
            .object_fit(ObjectFit::Cover)
            .opacity(0.8)
    }
}

impl SearchView {
    pub(super) fn render_tray(&self, cx: &mut Context<Self>) -> Option<AnyElement> {
        if self.references.is_empty() {
            return None;
        }
        let theme = cx.theme();
        let urls = Media::urls(cx).clone();
        let count = self.references.len();
        let view = cx.entity().downgrade();

        let thumbnails = self.references.iter().enumerate().map(|(ix, reference)| {
            let preview = results::preview(reference, &urls);
            let ghost = preview.clone();
            let drop_view = view.clone();
            let remove_view = view.clone();
            div()
                .id(SharedString::from(format!("reference-{}", key(reference))))
                .relative()
                .flex_shrink_0()
                .size(rems(3.5))
                .rounded(theme.radius)
                .overflow_hidden()
                .border_1()
                .border_color(theme.border)
                .bg(theme.muted)
                .on_drag(DraggedReference { from: ix }, move |_, _, _, cx| {
                    let preview = ghost.clone();
                    cx.new(|_| ReferenceGhost { preview })
                })
                .drag_over::<DraggedReference>(|style, _, _, cx| {
                    style.border_2().border_color(cx.theme().primary)
                })
                .on_drop(move |dragged: &DraggedReference, _, cx| {
                    let from = dragged.from;
                    let _ = drop_view.update(cx, |this, cx| this.reorder_references(from, ix, cx));
                })
                .child(
                    img(media_image(preview))
                        .size_full()
                        .object_fit(ObjectFit::Cover),
                )
                .child(
                    div()
                        .absolute()
                        .top_0p5()
                        .left_0p5()
                        .size_4()
                        .flex()
                        .items_center()
                        .justify_center()
                        .rounded_full()
                        .bg(theme.primary)
                        .text_color(theme.primary_foreground)
                        .text_xs()
                        .font_weight(FontWeight::BOLD)
                        .child((ix + 1).to_string()),
                )
                .child(
                    div()
                        .absolute()
                        .bottom_0p5()
                        .left_0p5()
                        .rounded(theme.radius)
                        .bg(theme.overlay)
                        .child(
                            Icon::new(IconName::GripVertical)
                                .xsmall()
                                .text_color(theme.foreground),
                        ),
                )
                .child(
                    div()
                        .absolute()
                        .top_0p5()
                        .right_0p5()
                        .rounded(theme.radius)
                        .bg(theme.overlay)
                        .child(
                            Button::new(SharedString::from(format!(
                                "remove-reference-{}",
                                key(reference)
                            )))
                            .ghost()
                            .xsmall()
                            .icon(IconName::X)
                            .tooltip(format!("Remove reference {}", ix + 1))
                            .on_click(move |_, _, cx| {
                                cx.stop_propagation();
                                let _ = remove_view
                                    .update(cx, |this, cx| this.remove_reference(ix, cx));
                            }),
                        ),
                )
        });

        Some(
            h_flex()
                .absolute()
                .bottom_4()
                .left_0()
                .right_0()
                .px_4()
                .justify_center()
                .child(
                    h_flex()
                        .w_full()
                        .max_w(rems(56.))
                        .gap_3()
                        .p_2()
                        .rounded(theme.radius_lg)
                        .border_1()
                        .border_color(theme.border)
                        .bg(theme.popover)
                        .shadow_lg()
                        .child(
                            h_flex()
                                .id("reference-strip")
                                .flex_1()
                                .min_w_0()
                                .gap_2()
                                .overflow_x_scroll()
                                .children(thumbnails),
                        )
                        .child(
                            div()
                                .flex_shrink_0()
                                .text_xs()
                                .text_color(theme.muted_foreground)
                                .child(format!("{count}/{MAX_SEARCH_REFERENCES}")),
                        )
                        .child(
                            Button::new("clear-references")
                                .ghost()
                                .small()
                                .label("Clear")
                                .on_click(cx.listener(|this, _, _, cx| this.clear_references(cx))),
                        )
                        .child(
                            Button::new("use-references")
                                .primary()
                                .label(if count == 1 {
                                    "Use 1 as reference".to_string()
                                } else {
                                    format!("Use {count} as references")
                                })
                                .on_click(cx.listener(|this, _, _, cx| this.use_references(cx))),
                        ),
                )
                .into_any_element(),
        )
    }
}
