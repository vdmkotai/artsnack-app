//! One image of a generation, flattened out of its row: what the Gallery grid
//! shows one tile for, and what both screens' viewers page through.

use std::{collections::HashMap, sync::Arc};

use artsnack_backend::api::generations::{Generation, ImageRef};
use artsnack_media::{ImageRequest, MediaUrls};
use artsnack_ui::{LightboxItem, TileMedia};
use gpui_kit::SharedString;

/// Decode viewer originals to at most this many device pixels on the longer
/// side: sharp on a 5K display, and a 12k-pixel upload does not become a
/// 576 MB texture.
const ORIGINAL_MAX_DIMENSION: u32 = 4096;
/// Previews are 512 px wide from the CDN; decoding to 768 covers tall ones.
const PREVIEW_MAX_DIMENSION: u32 = 768;

#[derive(Clone, Debug)]
pub(crate) struct GalleryImage {
    /// `{generation id}:{b2 key}`: identity for selection, tiles and the viewer.
    pub key: SharedString,
    pub generation: Arc<Generation>,
    pub b2_key: String,
}

impl GalleryImage {
    /// Every image of `rows`, in order. Rows without output (running, failed,
    /// or old ones whose files are gone) contribute nothing.
    pub fn all(rows: &[Arc<Generation>]) -> Vec<Self> {
        rows.iter()
            .flat_map(|generation| {
                generation.b2_keys.iter().map(|b2_key| Self {
                    key: image_key(&generation.id, b2_key),
                    generation: generation.clone(),
                    b2_key: b2_key.clone(),
                })
            })
            .collect()
    }

    pub fn image_ref(&self) -> ImageRef {
        ImageRef {
            generation_id: self.generation.id.clone(),
            b2_key: self.b2_key.clone(),
        }
    }
}

/// The keys of `images`, in order (for Shift-click ranges).
pub(crate) fn keys(images: &[GalleryImage]) -> impl Iterator<Item = &str> + Clone {
    images.iter().map(|image| &*image.key)
}

/// Looks images up by key.
pub(crate) fn by_key(images: &[GalleryImage]) -> HashMap<&str, &GalleryImage> {
    images.iter().map(|image| (&*image.key, image)).collect()
}

pub(crate) fn image_key(generation_id: &str, b2_key: &str) -> SharedString {
    format!("{generation_id}:{b2_key}").into()
}

/// `(generation id, b2 key)` back out of an [`image_key`]. Convex ids hold no
/// colon, so the first one is the separator.
pub(crate) fn split_image_key(key: &str) -> Option<(&str, &str)> {
    key.split_once(':')
}

pub(crate) fn preview(b2_key: &str, urls: &MediaUrls) -> ImageRequest {
    ImageRequest::new(urls.thumb(b2_key)).max_dimension(PREVIEW_MAX_DIMENSION)
}

pub(crate) fn original(b2_key: &str, urls: &MediaUrls) -> ImageRequest {
    ImageRequest::new(urls.original(b2_key)).max_dimension(ORIGINAL_MAX_DIMENSION)
}

pub(crate) fn lightbox_item(key: SharedString, b2_key: &str, urls: &MediaUrls) -> LightboxItem {
    LightboxItem {
        key,
        preview: preview(b2_key, urls),
        original: original(b2_key, urls),
        media: TileMedia::Image,
        video_url: None,
    }
}

#[cfg(test)]
mod tests {
    use artsnack_backend::api::generations::{FormState, GenerationStatus};

    use super::*;

    fn row(id: &str, keys: &[&str]) -> Arc<Generation> {
        Arc::new(Generation {
            id: id.into(),
            timestamp: 0.0,
            form_state: FormState::default(),
            b2_keys: keys.iter().map(|key| key.to_string()).collect(),
            status: (keys.is_empty()).then_some(GenerationStatus::Processing),
            error: None,
            progress_stage: None,
            progress_message: None,
            progress_current: None,
            progress_total: None,
            queue_position: None,
        })
    }

    #[test]
    fn flattens_rows_into_images_and_skips_rows_without_output() {
        let rows = [
            row("g1", &["a.png", "b.png"]),
            row("g2", &[]),
            row("g3", &["c.png"]),
        ];
        let images = GalleryImage::all(&rows);
        let order: Vec<&str> = keys(&images).collect();
        assert_eq!(order, ["g1:a.png", "g1:b.png", "g3:c.png"]);
        assert_eq!(
            images[1].image_ref(),
            ImageRef {
                generation_id: "g1".into(),
                b2_key: "b.png".into()
            }
        );
    }

    #[test]
    fn splits_keys_at_the_first_colon() {
        assert_eq!(
            split_image_key("g1:dir/a:b.png"),
            Some(("g1", "dir/a:b.png"))
        );
        assert_eq!(split_image_key("plain"), None);
    }
}
