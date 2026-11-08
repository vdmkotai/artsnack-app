//! The grid's tiles: a finished image or clip, a running job, a failure.
//!
//! Only the tile under the pointer builds its action buttons; every other tile
//! is its image and its badges. A grid scrolls by re-rendering, and a few
//! hundred tiles each building six buttons and their tooltips on every frame
//! was the cost the web paid in React re-renders. The hovered tile stays
//! "hovered" until the pointer reaches another one, so a menu opened from it
//! keeps its trigger while the pointer is over the menu.

use std::sync::Arc;

use artsnack_backend::api::{favorites::ToggleArgs, grok_generations::ApiGeneration};
use artsnack_media::{ImageRequest, Media, MediaUrls};
use artsnack_ui::{MediaTile, TileAction, TileMenuItem};
use gpui_kit::{
    AnyElement, App, ClickEvent, Context, FontWeight, InteractiveElement as _, IntoElement,
    ParentElement as _, Pixels, SharedString, Size, StatefulInteractiveElement as _, Styled as _,
    WeakEntity, Window,
    assets::IconName,
    component::{
        ActiveTheme as _, Icon, Sizable as _,
        button::{Button, ButtonVariants as _},
        h_flex,
        popover::Popover,
        progress::Progress,
        spinner::Spinner,
        tooltip::Tooltip,
        v_flex,
    },
    div,
    prelude::FluentBuilder as _,
    rems,
};

use super::{
    ApiResults, ApiResultsEvent, ResultsKind, VideoRole,
    content::{Item, ItemKind, is_self_hosted_video},
    meta::Failure,
};

/// Decode viewer originals to at most this many device pixels on the longer
/// side: sharp on a 5K display, and a 12k-pixel upload does not become a
/// 576 MB texture.
const ORIGINAL_MAX_DIMENSION: u32 = 4096;
/// Previews are 512 px wide from the CDN; decoding to 768 covers tall ones.
const PREVIEW_MAX_DIMENSION: u32 = 768;
/// Below this size a tile has no room for its badges (the web's container
/// query on the masonry cell), and its actions fold into a menu.
const COMPACT_WIDTH: f32 = 180.0;
const COMPACT_HEIGHT: f32 = 80.0;

/// The grid preview: the CDN thumbnail of an image, the poster frame of a clip.
pub(super) fn preview(b2_key: &str, video: bool, urls: &MediaUrls) -> ImageRequest {
    let url = if video {
        urls.video_poster(b2_key)
    } else {
        urls.thumb(b2_key)
    };
    ImageRequest::new(url).max_dimension(PREVIEW_MAX_DIMENSION)
}

pub(super) fn original(b2_key: &str, urls: &MediaUrls) -> ImageRequest {
    ImageRequest::new(urls.original(b2_key)).max_dimension(ORIGINAL_MAX_DIMENSION)
}

fn is_compact(size: Size<Pixels>) -> bool {
    size.width.as_f32() < COMPACT_WIDTH || size.height.as_f32() < COMPACT_HEIGHT
}

/// The headline of a failed tile, so the cause reads without the full text.
fn failure_title(row: &ApiGeneration) -> &'static str {
    match row.error_kind.as_deref() {
        Some("billing") => "fal balance empty",
        Some("moderation") => "Rejected by moderation",
        Some("auth") => "Not authorised",
        Some("timeout") => "Timed out",
        Some("validation") => "Rejected settings",
        _ => "Failed",
    }
}

/// `m:ss`.
fn format_duration(seconds: f64) -> String {
    let total = seconds.max(0.0).round() as u64;
    format!("{}:{:02}", total / 60, total % 60)
}

/// Sends `event` from the grid.
fn emit(view: &WeakEntity<ApiResults>, event: ApiResultsEvent, cx: &mut App) {
    let _ = view.update(cx, |_, cx| cx.emit(event));
}

/// "Edit with Grok" and "Extend with Grok" for a clip Grok can fetch.
pub(super) fn grok_source_items(
    view: &WeakEntity<ApiResults>,
    key: &str,
    before: impl Fn(&mut Window, &mut App) + Clone + 'static,
) -> Vec<TileMenuItem> {
    [
        (
            "edit",
            "Edit with Grok",
            "Change this clip (up to 8.7 s), keeping its length and shape",
        ),
        (
            "extend",
            "Extend with Grok",
            "Continue this clip (2\u{2013}15 s) from its last frame",
        ),
    ]
    .into_iter()
    .map(|(mode, label, hint)| {
        let view = view.clone();
        let key = key.to_string();
        let before = before.clone();
        TileMenuItem::new(label, move |window, cx| {
            before(window, cx);
            emit(
                &view,
                ApiResultsEvent::UseAsSourceVideo {
                    key: key.clone(),
                    mode,
                },
                cx,
            );
        })
        .hint(hint)
    })
    .collect()
}

/// The three ways an image can go to the self-hosted video tab.
pub(super) fn send_to_video_items(
    view: &WeakEntity<ApiResults>,
    image_url: &SharedString,
    before: impl Fn(&mut Window, &mut App) + Clone + 'static,
) -> Vec<TileMenuItem> {
    [
        (
            VideoRole::First,
            "As start frame",
            "The clip begins on this image",
        ),
        (
            VideoRole::Last,
            "As last frame",
            "The clip ends on this image",
        ),
        (
            VideoRole::Reference,
            "As reference",
            "Keeps this look or character; tag it @image",
        ),
    ]
    .into_iter()
    .map(|(role, label, hint)| {
        let view = view.clone();
        let image_url = image_url.clone();
        let before = before.clone();
        TileMenuItem::new(label, move |window, cx| {
            before(window, cx);
            emit(
                &view,
                ApiResultsEvent::SendToVideo {
                    image_url: image_url.clone(),
                    role,
                },
                cx,
            );
        })
        .hint(hint)
    })
    .collect()
}

impl ApiResults {
    /// Item `item` at `size`, inside the element that tracks the hovered tile.
    pub(super) fn render_item(
        &self,
        item: &Item,
        size: Size<Pixels>,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let hovered = self.hovered.as_ref() == Some(&item.key);
        let tile = match &item.kind {
            ItemKind::Output { b2_key } => self.output_tile(item, b2_key, size, hovered, cx),
            ItemKind::Pending => self.pending_tile(item, size, hovered, cx),
            ItemKind::Failed => self.failed_tile(item, size, hovered, cx),
        };
        let key = item.key.clone();
        div()
            .id(item.key.clone())
            .size_full()
            .on_hover(cx.listener(move |this, hovered: &bool, _, cx| {
                if *hovered && this.hovered.as_ref() != Some(&key) {
                    this.hovered = Some(key.clone());
                    cx.notify();
                }
            }))
            .child(tile)
            .into_any_element()
    }

    fn output_tile(
        &self,
        item: &Item,
        b2_key: &str,
        size: Size<Pixels>,
        hovered: bool,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let row = &item.row;
        let video = row.is_video();
        let urls = Media::urls(cx);
        let selecting = self.is_selecting();
        // `None` until the favourites list first arrives: no heart then, so a
        // click cannot mean the opposite of what it shows.
        let favorited = self.hearts.read(cx).favorited(b2_key);
        let mut tile = MediaTile::new(item.key.clone(), preview(b2_key, video, urls), size);
        if !video {
            // A clip's original is an mp4, not something to decode as a still.
            tile = tile.original(original(b2_key, urls));
        }

        if selecting {
            tile = tile.selection(self.selection.is_selected(&row.id));
        } else {
            // The heart is state worth reading off the grid once set; until
            // then it is one of the hovered tile's controls.
            if let Some(favorited) = favorited
                && (hovered || favorited)
            {
                let hearts = self.hearts.clone();
                let args = ToggleArgs {
                    api_generation_id: Some(row.id.clone()),
                    b2_key: b2_key.to_string(),
                    ..ToggleArgs::default()
                };
                tile = tile.favorite(favorited, move |window, cx| {
                    hearts.update(cx, |hearts, cx| hearts.toggle(args.clone(), window, cx));
                });
            }
            if hovered {
                for action in self.output_actions(item, b2_key, cx) {
                    tile = tile.action(action);
                }
            }
        }

        // A playing clip's frames: over the poster, under the badges and the
        // hover actions (overlays draw in the order they are added). The
        // surface is a view of its own that redraws only itself per frame.
        let surface = (video && self.clips.is_playing(&item.key))
            .then(|| self.players.surface(&item.key, cx))
            .flatten();
        let playing = surface.is_some() && self.players.has_frame(&item.key);
        if let Some(surface) = surface {
            tile = tile.overlay(div().absolute().inset_0().child(surface));
        }
        if !is_compact(size) {
            tile = tile.overlay(self.result_badge(row, cx));
            if video {
                tile = tile.overlay(video_overlay(row, playing, cx));
            } else if let Some(shortfall) = shortfall_badge(row, cx) {
                tile = tile.overlay(shortfall);
            }
        }

        let key = item.key.clone();
        let id = row.id.clone();
        tile.on_click(cx.listener(move |this, event: &ClickEvent, window, cx| {
            this.click_output(key.clone(), id.clone(), event.modifiers().shift, window, cx)
        }))
        .into_any_element()
    }

    /// The hovered tile's commands, in the web's order. A clip feeds nothing
    /// back into the form, so it has no reference actions.
    fn output_actions(&self, item: &Item, b2_key: &str, cx: &Context<Self>) -> Vec<TileAction> {
        let view = cx.entity().downgrade();
        let row = &item.row;
        let mut actions = Vec::with_capacity(6);
        actions.extend(self.copy_prompt_action(item.key.clone(), row, cx));
        actions.push(reproduce_action(&view, row));
        if !row.is_video() {
            let image_url: SharedString = Media::urls(cx).original(b2_key).into();
            for (id, icon, label, as_video) in [
                (
                    "use-reference",
                    IconName::ImagePlus,
                    "Use as reference for a new image",
                    false,
                ),
                (
                    "make-video",
                    IconName::Film,
                    "Make video from this image",
                    true,
                ),
            ] {
                let view = view.clone();
                let image_url = image_url.clone();
                actions.push(TileAction::new(id, icon, label, move |_, cx| {
                    emit(
                        &view,
                        ApiResultsEvent::UseAsReference {
                            image_url: image_url.clone(),
                            as_video,
                        },
                        cx,
                    );
                }));
            }
            // The video tab's own grid has no other tab to send to.
            if self.kind == ResultsKind::Api {
                actions.push(TileAction::menu(
                    "send-to-video",
                    IconName::Clapperboard,
                    "Use in self-hosted video",
                    send_to_video_items(&view, &image_url, |_, _| {}),
                ));
            }
        } else if self.kind == ResultsKind::Api
            && let Some(key) = self
                .meta
                .get(row)
                .and_then(|meta| meta.grok_source_key.clone())
        {
            actions.push(TileAction::menu(
                "grok-source",
                IconName::Film,
                "Edit or extend with Grok",
                grok_source_items(&view, &key, |_, _| {}),
            ));
        }
        actions.push(delete_action(&view, row, false));
        actions
    }

    /// Copy prompt, with its tick, when the row has a prompt.
    fn copy_prompt_action(
        &self,
        copy_key: SharedString,
        row: &Arc<ApiGeneration>,
        cx: &Context<Self>,
    ) -> Option<TileAction> {
        if row.prompt.trim().is_empty() {
            return None;
        }
        let copied = self.copied.is(&copy_key);
        let view = cx.entity().downgrade();
        let prompt = row.prompt.clone();
        Some(TileAction::new(
            "copy-prompt",
            if copied {
                IconName::Check
            } else {
                IconName::Copy
            },
            if copied {
                "Prompt copied"
            } else {
                "Copy prompt"
            },
            move |_, cx| {
                let key = copy_key.clone();
                let prompt = prompt.clone();
                let _ = view.update(cx, |this, cx| {
                    this.copied.copy(key, prompt, |this| &mut this.copied, cx)
                });
            },
        ))
    }

    /// Model and price, on every tile at every stage. A solid fill, not a blur:
    /// the badge is always on screen, often over a clip.
    fn result_badge(&self, row: &ApiGeneration, cx: &App) -> AnyElement {
        let theme = cx.theme();
        let meta = self.meta.get(row);
        let badge: SharedString = meta
            .map(|meta| meta.badge.clone())
            .or_else(|| row.api_model.clone())
            .unwrap_or_else(|| "Grok".into())
            .into();
        let price = meta.and_then(|meta| meta.price.clone());
        h_flex()
            .absolute()
            .bottom_1()
            .right_1()
            .gap_1p5()
            .px_1p5()
            .py_0p5()
            .rounded(theme.radius)
            .bg(theme.overlay)
            .text_xs()
            .text_color(theme.foreground)
            .child(div().max_w(rems(12.)).truncate().child(badge))
            .when_some(price, |this, price| {
                this.child(div().text_color(theme.muted_foreground).child(price))
            })
            .into_any_element()
    }

    /// A job still in flight, with a way to get rid of it. The button removes
    /// the tile; a vendor that has the job keeps it (and bills it), so the
    /// button only shows under the pointer, never inviting a stray click.
    fn pending_tile(
        &self,
        item: &Item,
        size: Size<Pixels>,
        hovered: bool,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let theme = cx.theme();
        let row = &item.row;
        let label = row.progress_label();
        let percent = row.progress_percent();
        let selecting = self.is_selecting();
        let remove_tip = if is_self_hosted_video(row) {
            "Cancel this clip on the video pod"
        } else {
            "Remove from results (the job itself cannot be cancelled)"
        };

        let mut tile = div()
            .relative()
            .size_full()
            .overflow_hidden()
            .rounded(theme.radius)
            .border_1()
            .border_color(theme.border)
            .bg(theme.muted.opacity(0.3))
            .child(
                v_flex()
                    .size_full()
                    .items_center()
                    .justify_center()
                    .gap_3()
                    .px_2()
                    .child(Spinner::new().large().color(theme.primary))
                    .child(
                        v_flex()
                            .w_full()
                            .max_w(rems(16.))
                            .gap_1p5()
                            .child(
                                div()
                                    .w_full()
                                    .text_xs()
                                    .text_center()
                                    .text_color(theme.muted_foreground)
                                    .truncate()
                                    .child(label.clone())
                                    .when_some(percent, |this, percent| {
                                        this.child(format!(" · {}%", percent.round() as u32))
                                    }),
                            )
                            .child(
                                Progress::new(SharedString::from(format!("progress-{}", row.id)))
                                    .xsmall()
                                    .value(percent.unwrap_or_default())
                                    .loading(percent.is_none())
                                    .accessibility_label(label),
                            ),
                    ),
            );
        if hovered && !selecting {
            let view = cx.entity().downgrade();
            let row = row.clone();
            tile = tile.child(
                div()
                    .absolute()
                    .top_1()
                    .right_1()
                    .rounded(theme.radius)
                    .bg(theme.overlay)
                    .child(
                        Button::new("remove")
                            .ghost()
                            .xsmall()
                            .icon(Icon::new(IconName::Trash).text_color(theme.danger))
                            .tooltip(remove_tip)
                            .on_click(move |_, window, cx| {
                                let _ = view.update(cx, |this, cx| {
                                    this.confirm_remove(row.clone(), false, window, cx)
                                });
                            }),
                    ),
            );
        }
        if !is_compact(size) {
            tile = tile.child(self.result_badge(row, cx));
        }
        if selecting {
            tile = tile.child(self.selection_overlay(&row.id, cx));
        }
        tile.into_any_element()
    }

    /// A failure: the cause, a readable line of the vendor's text, the full
    /// text behind Details, and the row's prompt and settings one click from a
    /// retry.
    fn failed_tile(
        &self,
        item: &Item,
        size: Size<Pixels>,
        hovered: bool,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let theme = cx.theme();
        let row = &item.row;
        let title = failure_title(row);
        let failure = self
            .meta
            .get(row)
            .and_then(|meta| meta.failure.clone())
            .unwrap_or_else(|| Failure {
                summary: row.error.clone().unwrap_or_else(|| "Unknown error".into()),
                ..Failure::default()
            });
        let selecting = self.is_selecting();

        let mut tile = div()
            .relative()
            .size_full()
            .overflow_hidden()
            .rounded(theme.radius)
            .border_1()
            .border_color(theme.danger.opacity(0.3))
            .bg(theme.danger.opacity(0.1))
            .child(
                // The title and Details never yield; on a short tile it is the
                // summary that gives up lines.
                v_flex()
                    .size_full()
                    .items_center()
                    .justify_center()
                    .gap_1()
                    .px_3()
                    .pb_7()
                    .text_center()
                    .child(
                        div()
                            .flex_shrink_0()
                            .text_sm()
                            .font_weight(FontWeight::MEDIUM)
                            .text_color(theme.danger)
                            .child(title),
                    )
                    .child(
                        div()
                            .w_full()
                            .min_h_0()
                            .text_xs()
                            .text_color(theme.muted_foreground)
                            .line_clamp(3)
                            .child(failure.summary.clone()),
                    )
                    .when(failure.has_more, |this| {
                        this.child(self.failure_details(&item.key, title, failure.full.clone(), cx))
                    }),
            );
        if hovered && !selecting {
            let view = cx.entity().downgrade();
            let mut actions: Vec<TileAction> = Vec::with_capacity(3);
            actions.extend(self.copy_prompt_action(item.key.clone(), row, cx));
            actions.push(reproduce_action(&view, row));
            actions.push(delete_action(&view, row, false));
            tile = tile.child(
                h_flex()
                    .absolute()
                    .top_1()
                    .right_1()
                    .gap_0p5()
                    .rounded(theme.radius)
                    .bg(theme.overlay)
                    .children(actions.into_iter().map(TileAction::into_element)),
            );
        }
        if !is_compact(size) {
            tile = tile.child(self.result_badge(row, cx));
        }
        if selecting {
            tile = tile.child(self.selection_overlay(&row.id, cx));
        }
        tile.into_any_element()
    }

    /// The full vendor response, far too long and unbroken for a tile, on
    /// demand and copyable for a support thread.
    fn failure_details(
        &self,
        key: &SharedString,
        title: &'static str,
        full: String,
        cx: &Context<Self>,
    ) -> impl IntoElement {
        let copy_key: SharedString = format!("failure:{key}").into();
        let copied = self.copied.is(&copy_key);
        let view = cx.entity().downgrade();
        let full: SharedString = full.into();
        Popover::new("failure-details")
            .trigger(
                Button::new("failure-details-trigger")
                    .ghost()
                    .xsmall()
                    .label("Details"),
            )
            .content(move |_, _, cx| {
                let theme = cx.theme();
                let view = view.clone();
                let copy_key = copy_key.clone();
                let text = full.clone();
                v_flex()
                    .w(rems(28.))
                    .gap_2()
                    .child(
                        h_flex()
                            .justify_between()
                            .gap_2()
                            .child(div().text_sm().font_weight(FontWeight::MEDIUM).child(title))
                            .child(
                                Button::new("copy-failure")
                                    .ghost()
                                    .xsmall()
                                    .icon(if copied {
                                        IconName::Check
                                    } else {
                                        IconName::Copy
                                    })
                                    .label(if copied { "Copied" } else { "Copy" })
                                    .on_click(move |_, _, cx| {
                                        let key = copy_key.clone();
                                        let text = text.to_string();
                                        let _ = view.update(cx, |this, cx| {
                                            this.copied.copy(key, text, |this| &mut this.copied, cx)
                                        });
                                    }),
                            ),
                    )
                    .child(
                        div()
                            .id("failure-text")
                            .max_h(rems(20.))
                            .overflow_y_scroll()
                            .p_2()
                            .rounded(theme.radius)
                            .bg(theme.muted)
                            .text_xs()
                            .font_family(theme.mono_font_family.clone())
                            .child(full.clone()),
                    )
            })
    }

    /// While selecting, the whole tile is one checkbox laid over its controls,
    /// so a click can only toggle — never press a Delete under the pointer.
    fn selection_overlay(&self, row_id: &str, cx: &Context<Self>) -> impl IntoElement {
        let theme = cx.theme();
        let selected = self.selection.is_selected(row_id);
        let row_id = row_id.to_string();
        div()
            .id("select")
            .absolute()
            .inset_0()
            .occlude()
            .p_1()
            .rounded(theme.radius)
            .when(selected, |this| {
                this.border_2()
                    .border_color(theme.primary)
                    .bg(theme.primary.opacity(0.2))
            })
            .child(
                div()
                    .size_5()
                    .flex()
                    .items_center()
                    .justify_center()
                    .rounded_full()
                    .border_1()
                    .when(selected, |this| {
                        this.bg(theme.primary).border_color(theme.primary).child(
                            Icon::new(IconName::Check)
                                .xsmall()
                                .text_color(theme.primary_foreground),
                        )
                    })
                    .when(!selected, |this| {
                        this.bg(theme.overlay).border_color(theme.foreground)
                    }),
            )
            .on_click(cx.listener(move |this, event: &ClickEvent, window, cx| {
                this.select_row(row_id.clone(), event.modifiers().shift, window, cx)
            }))
    }

    /// The price for the viewer's bar; none for a self-hosted clip, whose pod
    /// bills by the hour (Details has its GPU time).
    pub(super) fn price_tag(&self, row: &ApiGeneration) -> Option<SharedString> {
        if is_self_hosted_video(row) {
            return None;
        }
        self.meta
            .get(row)
            .and_then(|meta| meta.price_tag.clone())
            .map(Into::into)
    }
}

/// Reproduce: the composer restores the row's settings and references.
pub(super) fn reproduce_action(
    view: &WeakEntity<ApiResults>,
    row: &Arc<ApiGeneration>,
) -> TileAction {
    let view = view.clone();
    let row = row.clone();
    TileAction::new(
        "reproduce",
        IconName::RefreshCw,
        "Reproduce settings",
        move |_, cx| emit(&view, ApiResultsEvent::Reproduce(row.clone()), cx),
    )
}

/// Delete, with the confirmation the row's state calls for. `close_viewer`:
/// the viewer closes once the row is actually gone.
pub(super) fn delete_action(
    view: &WeakEntity<ApiResults>,
    row: &Arc<ApiGeneration>,
    close_viewer: bool,
) -> TileAction {
    let view = view.clone();
    let row = row.clone();
    TileAction::new(
        "delete",
        IconName::Trash,
        "Delete generation",
        move |window, cx| {
            let _ = view.update(cx, |this, cx| {
                this.confirm_remove(row.clone(), close_viewer, window, cx)
            });
        },
    )
}

/// "1 of 4" on a finished image batch that came back short. Grok's edit
/// endpoint takes no batch parameter, so four images are four requests, and a
/// moderation refusal is an empty answer, not an error: without this the
/// missing images simply never existed. The stored reason is the tooltip.
fn shortfall_badge(row: &ApiGeneration, cx: &App) -> Option<AnyElement> {
    let produced = row.outputs().len();
    let requested = row.count.unwrap_or(1.0).max(1.0) as usize;
    if produced >= requested {
        return None;
    }
    let theme = cx.theme();
    let reason: Option<SharedString> = row.error.clone().map(Into::into);
    Some(
        div()
            .id("shortfall")
            .absolute()
            .bottom_1()
            .left_1()
            .px_1p5()
            .py_0p5()
            .rounded(theme.radius)
            .bg(theme.warning)
            .text_xs()
            .font_weight(FontWeight::MEDIUM)
            .text_color(theme.warning_foreground)
            .child(format!("{produced} of {requested}"))
            .when_some(reason, |this, reason| {
                this.tooltip(move |window, cx| Tooltip::new(reason.clone()).build(window, cx))
            })
            .into_any_element(),
    )
}

/// A clip's corner: the play marker and its length. The marker hides while
/// the clip plays — which, until the native player exists, is never (see
/// `playback`): a playing clip draws its frames over the poster here.
fn video_overlay(row: &ApiGeneration, playing: bool, cx: &App) -> AnyElement {
    let theme = cx.theme();
    let duration = row
        .duration
        .filter(|seconds| *seconds > 0.0)
        .map(format_duration);
    h_flex()
        .absolute()
        .bottom_1()
        .left_1()
        .gap_1()
        .px_1p5()
        .py_0p5()
        .rounded(theme.radius)
        .bg(theme.overlay)
        .text_xs()
        .text_color(theme.foreground)
        .when(!playing, |this| {
            this.child(Icon::new(IconName::Play).xsmall())
        })
        .when_some(duration, |this, duration| this.child(duration))
        .into_any_element()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn formats_clip_lengths() {
        assert_eq!(format_duration(6.0), "0:06");
        assert_eq!(format_duration(75.4), "1:15");
    }
}
