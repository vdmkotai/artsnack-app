//! How a search result is drawn: its URLs and shape, the hover caption, the
//! viewer's item and its details panel.

use artsnack_backend::api::{
    favorites::{MediaType, short_checkpoint_name},
    search_catalog::{SearchSource, js_number},
};
use artsnack_media::{ImageRequest, MediaUrls};
use artsnack_ui::{LightboxItem, TileMedia};
use gpui_kit::{
    AnyElement, App, FontWeight, IntoElement, ParentElement as _, SharedString, Styled as _,
    component::{ActiveTheme as _, h_flex, v_flex},
    div,
    prelude::FluentBuilder as _,
};

use crate::{
    engine::{SearchResult, document_ratio},
    time::format_timestamp,
};

/// Decode viewer originals to at most this many device pixels on the longer
/// side: sharp on a 5K display, and a 12k-pixel upload does not become a
/// 576 MB texture.
const ORIGINAL_MAX_DIMENSION: u32 = 4096;
/// Previews are 512 px wide from the CDN; decoding to 768 covers tall ones.
const PREVIEW_MAX_DIMENSION: u32 = 768;

pub fn key(result: &SearchResult) -> SharedString {
    result.id().into()
}

pub fn is_image(result: &SearchResult) -> bool {
    result.document.media_type == MediaType::Image
}

pub fn media(result: &SearchResult) -> TileMedia {
    match result.document.media_type {
        MediaType::Image => TileMedia::Image,
        MediaType::Video => TileMedia::Video,
    }
}

/// The grid's still: an image's thumbnail; for a clip, its own thumbnail when
/// it has one, else a poster frame. Clips do not play in the Search grid.
pub fn preview(result: &SearchResult, urls: &MediaUrls) -> ImageRequest {
    let asset = result.asset();
    let url = match (result.document.media_type, &asset.thumbnail_key) {
        (MediaType::Image, _) => urls.thumb(&asset.key),
        (MediaType::Video, Some(thumbnail)) => urls.thumb(thumbnail),
        (MediaType::Video, None) => urls.video_poster(&asset.key),
    };
    ImageRequest::new(url).max_dimension(PREVIEW_MAX_DIMENSION)
}

/// The full-size image; for a clip, its still again (the viewer shows the
/// still with a Play button until native playback exists).
pub fn original(result: &SearchResult, urls: &MediaUrls) -> ImageRequest {
    match result.document.media_type {
        MediaType::Image => ImageRequest::new(urls.original(&result.asset().key))
            .max_dimension(ORIGINAL_MAX_DIMENSION),
        MediaType::Video => preview(result, urls),
    }
}

/// The object's own URL: what a reference, a download or the player uses.
pub fn media_url(result: &SearchResult, urls: &MediaUrls) -> String {
    match result.document.media_type {
        MediaType::Image => urls.original(&result.asset().key),
        MediaType::Video => urls.video(&result.asset().key),
    }
}

pub fn lightbox_item(result: &SearchResult, urls: &MediaUrls) -> LightboxItem {
    LightboxItem {
        key: key(result),
        preview: preview(result, urls),
        original: original(result, urls),
        media: media(result),
        video_url: (result.document.media_type == MediaType::Video)
            .then(|| urls.video(&result.asset().key).into()),
    }
}

/// Width ÷ height, held between 1:2 and 2:1; 16:9 for a clip and square for
/// an image when nothing is recorded.
pub fn aspect(result: &SearchResult) -> f32 {
    match document_ratio(&result.document) {
        Some(ratio) if ratio.is_finite() && ratio > 0.0 => ratio.clamp(0.5, 2.0) as f32,
        _ if result.document.media_type == MediaType::Video => 16.0 / 9.0,
        _ => 1.0,
    }
}

/// Self-hosted images and every API result can be hearted.
pub fn has_heart(result: &SearchResult) -> bool {
    is_image(result) || result.document.source == SearchSource::Api
}

/// The model line: its label, else the model, else the checkpoint, and how
/// many LoRAs.
pub fn model_line(result: &SearchResult) -> String {
    let document = &result.document;
    let model = document
        .model_label
        .clone()
        .or_else(|| document.model.clone())
        .or_else(|| {
            document
                .checkpoints
                .first()
                .map(|checkpoint| short_checkpoint_name(checkpoint).to_string())
        })
        .unwrap_or_else(|| "Unknown model".into());
    match document.loras.len() {
        0 => model,
        count => format!("{model} \u{b7} {count} LoRA"),
    }
}

/// "Matched beach · token, red dress · phrase", or "Recent generation".
pub fn reasons_line(result: &SearchResult) -> String {
    if result.reasons.is_empty() {
        return "Recent generation".into();
    }
    let reasons: Vec<String> = result
        .reasons
        .iter()
        .map(|reason| format!("{} \u{b7} {}", reason.term, reason.kind.as_str()))
        .collect();
    format!("Matched {}", reasons.join(", "))
}

/// "video · atlas · 5s".
pub fn kind_line(result: &SearchResult) -> String {
    let document = &result.document;
    let media = match document.media_type {
        MediaType::Image => "image",
        MediaType::Video => "video",
    };
    let mut line = format!("{media} \u{b7} {}", document.provider);
    if let Some(duration) = document.duration.filter(|duration| *duration != 0.0) {
        line.push_str(&format!(" \u{b7} {}s", js_number(duration)));
    }
    line
}

/// The hover caption over a tile: prompt, why it matched, and the model.
pub fn caption(result: &SearchResult, cx: &App) -> impl IntoElement {
    let theme = cx.theme();
    v_flex()
        .w_full()
        .gap_0p5()
        .p_2()
        .bg(theme.overlay)
        .text_color(theme.foreground)
        .when(!result.document.prompt.trim().is_empty(), |this| {
            this.child(
                div()
                    .text_xs()
                    .line_clamp(2)
                    .child(result.document.prompt.clone()),
            )
        })
        .child(
            div()
                .text_xs()
                .text_color(theme.muted_foreground)
                .truncate()
                .child(reasons_line(result)),
        )
        .child(
            div()
                .text_xs()
                .text_color(theme.muted_foreground)
                .truncate()
                .child(format!(
                    "{} \u{b7} {}",
                    kind_line(result),
                    model_line(result)
                )),
        )
}

fn optional_number(value: Option<f64>) -> String {
    value.map(js_number).unwrap_or_else(|| "\u{2014}".into())
}

/// The viewer's details panel (I): when and where it was made, the prompts,
/// and every setting the catalogue knows.
pub fn details(result: &SearchResult, cx: &App) -> AnyElement {
    let document = &result.document;
    let muted = cx.theme().muted_foreground;
    let field = |label: &'static str, value: String| {
        v_flex()
            .gap_0p5()
            .min_w_0()
            .child(div().text_xs().text_color(muted).child(label))
            .child(div().text_sm().child(value))
    };
    let dash = || "\u{2014}".to_string();
    let size = match (document.width, document.height) {
        (Some(width), Some(height)) if width != 0.0 && height != 0.0 => {
            format!("{}\u{d7}{}", js_number(width), js_number(height))
        }
        _ => document.aspect_ratio.clone().unwrap_or_else(dash),
    };
    let created = format_timestamp(document.created_at).unwrap_or_default();
    let source = match document.source {
        SearchSource::SelfHosted => "Self-hosted",
        SearchSource::Api => "API",
    };

    v_flex()
        .p_4()
        .gap_3()
        .child(
            div()
                .text_sm()
                .font_weight(FontWeight::SEMIBOLD)
                .child("Generation details"),
        )
        .child(div().text_xs().text_color(muted).child(format!(
            "{created} \u{b7} {source} \u{b7} {}",
            document.provider
        )))
        .child(field("Positive prompt", document.prompt.clone()))
        .when_some(
            document
                .negative_prompt
                .clone()
                .filter(|negative| !negative.trim().is_empty()),
            |this, negative| this.child(field("Negative prompt", negative)),
        )
        .child(field(
            "Model",
            document
                .model_label
                .clone()
                .or_else(|| document.model.clone())
                .unwrap_or_else(|| "Unknown".into()),
        ))
        .child(field(
            "Checkpoint",
            if document.checkpoints.is_empty() {
                dash()
            } else {
                document.checkpoints.join(", ")
            },
        ))
        .child(field(
            "LoRA",
            if document.loras.is_empty() {
                dash()
            } else {
                document.loras.join(", ")
            },
        ))
        .child(
            h_flex()
                .gap_3()
                .child(div().flex_1().child(field("Size", size)))
                .child(
                    div()
                        .flex_1()
                        .child(field("Seed", optional_number(document.seed))),
                ),
        )
        .child(
            h_flex()
                .gap_3()
                .child(div().flex_1().child(field(
                    "Sampler",
                    document.sampler.clone().unwrap_or_else(dash),
                )))
                .child(div().flex_1().child(field(
                    "Scheduler",
                    document.scheduler.clone().unwrap_or_else(dash),
                ))),
        )
        .child(field(
            "Steps / CFG",
            format!(
                "{} / {}",
                optional_number(document.steps),
                optional_number(document.cfg)
            ),
        ))
        .into_any_element()
}
