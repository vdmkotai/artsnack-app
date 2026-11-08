//! How a favourite is drawn: its URLs, its shape and its commands.

use artsnack_backend::api::favorites::{Favorite, MediaType, provider, short_checkpoint_name};
use artsnack_media::{ImageRequest, MediaUrls};
use artsnack_ui::{LightboxItem, TileMedia};
use gpui_kit::SharedString;

use crate::command::ReproduceSource;

/// Decode lightbox originals to at most this many device pixels on the longer
/// side: sharp on a 5K display, and a 12k-pixel upload does not become a
/// 576 MB texture.
const ORIGINAL_MAX_DIMENSION: u32 = 4096;
/// Grid previews are 512 px wide from the CDN; decoding to 768 covers tall ones.
const PREVIEW_MAX_DIMENSION: u32 = 768;

pub fn key(favorite: &Favorite) -> SharedString {
    favorite.id.clone().into()
}

pub fn media(favorite: &Favorite) -> TileMedia {
    match favorite.media_type {
        MediaType::Image => TileMedia::Image,
        MediaType::Video => TileMedia::Video,
    }
}

pub fn preview(favorite: &Favorite, urls: &MediaUrls) -> ImageRequest {
    let url = match favorite.media_type {
        MediaType::Image => urls.thumb(&favorite.b2_key),
        MediaType::Video => urls.video_poster(&favorite.b2_key),
    };
    ImageRequest::new(url).max_dimension(PREVIEW_MAX_DIMENSION)
}

pub fn original(favorite: &Favorite, urls: &MediaUrls) -> ImageRequest {
    ImageRequest::new(urls.original(&favorite.b2_key)).max_dimension(ORIGINAL_MAX_DIMENSION)
}

pub fn lightbox_item(favorite: &Favorite, urls: &MediaUrls) -> LightboxItem {
    LightboxItem {
        key: key(favorite),
        preview: preview(favorite, urls),
        original: original(favorite, urls),
        media: media(favorite),
        video_url: (favorite.media_type == MediaType::Video)
            .then(|| urls.video(&favorite.b2_key).into()),
    }
}

/// Width ÷ height, from whatever the row recorded; square when unknown.
pub fn aspect(favorite: &Favorite) -> f32 {
    if let Some(ratio) = favorite.aspect_ratio.as_deref().and_then(parse_ratio) {
        return ratio;
    }
    if let Some(form) = &favorite.form_state {
        let width = form.get("width").and_then(|value| value.as_f64());
        let height = form.get("height").and_then(|value| value.as_f64());
        if let (Some(width), Some(height)) = (width, height)
            && width > 0.0
            && height > 0.0
        {
            return (width / height) as f32;
        }
    }
    1.0
}

/// `"16:9"` → 1.777…
fn parse_ratio(ratio: &str) -> Option<f32> {
    let (width, height) = ratio.split_once(':')?;
    let width: f32 = width.trim().parse().ok()?;
    let height: f32 = height.trim().parse().ok()?;
    (width > 0.0 && height > 0.0).then_some(width / height)
}

/// The hover badge: the checkpoint for self-hosted results, else the provider.
pub fn badge(favorite: &Favorite) -> SharedString {
    match (&favorite.checkpoint, favorite.provider.as_str()) {
        (Some(checkpoint), provider::SELF_HOSTED) => {
            short_checkpoint_name(checkpoint).to_string().into()
        }
        (_, provider) => provider::label(provider).to_string().into(),
    }
}

/// What Reproduce restores for this favourite, if anything.
pub fn reproduce_source(favorite: &Favorite) -> Option<ReproduceSource> {
    if let Some(id) = &favorite.enhancement_id {
        return Some(ReproduceSource::Enhancement {
            enhancement_id: id.clone(),
        });
    }
    if let Some(id) = &favorite.api_generation_id {
        return Some(ReproduceSource::Api {
            generation_id: id.clone(),
        });
    }
    favorite
        .form_state
        .clone()
        .map(|form_state| ReproduceSource::SelfHosted { form_state })
}

#[cfg(test)]
mod tests {
    use super::parse_ratio;

    #[test]
    fn parses_ratios() {
        assert_eq!(parse_ratio("2:1"), Some(2.0));
        assert_eq!(parse_ratio(" 9 : 16 "), Some(0.5625));
        assert_eq!(parse_ratio("0:1"), None);
        assert_eq!(parse_ratio("square"), None);
    }
}
