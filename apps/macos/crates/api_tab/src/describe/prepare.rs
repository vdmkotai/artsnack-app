//! Getting a picture ready to describe, off the main thread: the `describe`
//! reference profile (≤ 1536 px, ≤ 1.5 MB JPEG) as a data URL for the
//! request, and a small decoded copy for its card.

use std::{path::PathBuf, sync::Arc};

use anyhow::Context as _;
use artsnack_media::{
    decode,
    fetch::Fetcher,
    upload::{self, ProfileLimits},
};
use base64::{Engine as _, engine::general_purpose::STANDARD};
use gpui_kit::{AsyncApp, RenderImage, SharedString};

/// Longest side of a card's thumbnail in device pixels: an 8 rem card at 2×,
/// with room for some pane zoom.
const PREVIEW_PIXELS: u32 = 384;
const DATA_URL_PREFIX: &str = "data:image/jpeg;base64,";
/// What the decoder reads. Anything else is refused before it costs a read.
const EXTENSIONS: [&str; 5] = ["png", "jpg", "jpeg", "webp", "gif"];

/// Where a picture to describe comes from.
pub(super) enum Origin {
    File(PathBuf),
    /// An original on the media CDN, picked from the gallery.
    Remote(SharedString),
}

pub(super) struct NewImage {
    pub name: SharedString,
    pub origin: Origin,
}

impl NewImage {
    /// A file the decoder can read, by its extension; `None` otherwise.
    pub fn file(path: &std::path::Path) -> Option<Self> {
        let extension = path.extension()?.to_str()?.to_lowercase();
        if !EXTENSIONS.contains(&extension.as_str()) {
            return None;
        }
        let name = path
            .file_name()
            .map(|name| name.to_string_lossy().to_string())
            .unwrap_or_default();
        Some(Self {
            name: name.into(),
            origin: Origin::File(path.to_path_buf()),
        })
    }

    /// An image picked from the gallery, named after its object key.
    pub fn remote(url: SharedString, key: &str) -> Self {
        let name = key.rsplit('/').next().filter(|name| !name.is_empty());
        Self {
            name: name.unwrap_or("gallery image").to_string().into(),
            origin: Origin::Remote(url),
        }
    }
}

pub(super) struct Prepared {
    /// `data:image/jpeg;base64,…`, shared by every attempt at describing it.
    pub data_url: Arc<str>,
    pub preview: Arc<RenderImage>,
}

/// Reads and prepares one picture: files are read on the background
/// executor, gallery picks fetched on the I/O runtime (and cached), and the
/// decode, resize and encode run on the background executor.
pub(super) async fn prepare(
    origin: Origin,
    limits: ProfileLimits,
    fetcher: Arc<Fetcher>,
    cx: &mut AsyncApp,
) -> Result<Prepared, SharedString> {
    let bytes = match origin {
        Origin::File(path) => cx
            .background_executor()
            .spawn(async move { std::fs::read(&path) })
            .await
            .map_err(|error| SharedString::from(format!("Could not read the file ({error})")))?,
        Origin::Remote(url) => {
            let download = cx.update(|cx| {
                artsnack_runtime::spawn_result(cx, async move { fetcher.image_bytes(&url).await })
            });
            download
                .await
                .map_err(|_| SharedString::from("Could not load that image"))?
        }
    };
    cx.background_executor()
        .spawn(async move { encode(&bytes, &limits) })
        .await
        .map_err(|error| SharedString::from(format!("Could not prepare the image ({error})")))
}

fn encode(bytes: &[u8], limits: &ProfileLimits) -> anyhow::Result<Prepared> {
    let prepared = upload::prepare(bytes, limits)?;
    let preview =
        decode::decode(&prepared.jpeg, Some(PREVIEW_PIXELS)).context("decoding the thumbnail")?;
    let mut data_url =
        String::with_capacity(DATA_URL_PREFIX.len() + prepared.jpeg.len().div_ceil(3) * 4);
    data_url.push_str(DATA_URL_PREFIX);
    STANDARD.encode_string(&prepared.jpeg, &mut data_url);
    Ok(Prepared {
        data_url: data_url.into(),
        preview: Arc::new(preview),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    #[test]
    fn accepts_only_what_the_decoder_reads() {
        assert!(NewImage::file(Path::new("/tmp/a.PNG")).is_some());
        assert!(NewImage::file(Path::new("/tmp/b.webp")).is_some());
        assert!(NewImage::file(Path::new("/tmp/c.heic")).is_none());
        assert!(NewImage::file(Path::new("/tmp/notes")).is_none());
    }

    #[test]
    fn gallery_picks_are_named_after_their_key() {
        let image = NewImage::remote("https://media.example.com/a/b.png".into(), "a/b.png");
        assert_eq!(image.name.as_ref(), "b.png");
    }
}
