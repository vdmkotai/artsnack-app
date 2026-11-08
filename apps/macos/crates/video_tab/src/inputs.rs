//! Input images: first and last frames, references, and LTX's sheet.
//!
//! Every image — picked, dropped, pasted, from the gallery, handed over or
//! restored — is prepared once at fal's reference profile (the web's
//! `prepareReferenceImage(blob, "fal")`) off the main thread, and shown from a
//! small decoded preview. The web does not keep video inputs across a reload,
//! so neither does this.

use std::{
    path::{Path, PathBuf},
    sync::{
        Arc,
        atomic::{AtomicU64, Ordering},
    },
};

use artsnack_backend::api::comfy_video_jobs::InputRole;
use artsnack_media::{decode, upload};
use gpui_kit::{ClipboardEntry, ClipboardItem, RenderImage};

/// Files the decoder reads. AVIF and HEIC need a system decoder this build
/// does not have.
const ACCEPTED_EXTENSIONS: [&str; 5] = ["png", "jpg", "jpeg", "webp", "gif"];
/// A frame slot is about 200 pt wide; decoded at twice that for Retina.
const PREVIEW_PIXELS: u32 = 480;

#[derive(Clone)]
pub(crate) struct InputImage {
    pub id: u64,
    pub role: InputRole,
    /// JPEG at fal's profile: what is uploaded.
    pub jpeg: Arc<Vec<u8>>,
    pub preview: Arc<RenderImage>,
    /// The object key it came from, when it is one of the app's own outputs.
    pub source_key: Option<String>,
}

/// An image prepared off the main thread, waiting for its role.
pub(crate) struct Prepared {
    jpeg: Vec<u8>,
    preview: RenderImage,
    source_key: Option<String>,
}

impl Prepared {
    pub fn into_input(self, role: InputRole) -> InputImage {
        static NEXT_ID: AtomicU64 = AtomicU64::new(1);
        InputImage {
            id: NEXT_ID.fetch_add(1, Ordering::Relaxed),
            role,
            jpeg: Arc::new(self.jpeg),
            preview: Arc::new(self.preview),
            source_key: self.source_key,
        }
    }
}

/// Prepares raw image bytes. Runs off the main thread.
pub(crate) fn prepare(
    bytes: &[u8],
    limits: &upload::ProfileLimits,
    source_key: Option<String>,
) -> anyhow::Result<Prepared> {
    let prepared = upload::prepare(bytes, limits)?;
    let preview = decode::decode(&prepared.jpeg, Some(PREVIEW_PIXELS))?;
    Ok(Prepared {
        jpeg: prepared.jpeg,
        preview,
        source_key,
    })
}

/// The web's `isAttachableImageFile`, by extension.
pub(crate) fn is_accepted(path: &Path) -> bool {
    path.extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| ACCEPTED_EXTENSIONS.contains(&extension.to_lowercase().as_str()))
}

/// An image on the clipboard: pixels, or a copied file.
pub(crate) enum Pasted {
    Bytes(Vec<u8>),
    File(PathBuf),
}

/// The images a paste carries (`pastedImageFiles`). Into a text field, a
/// clipboard that also has text keeps it: the text is what is being pasted.
pub(crate) fn pasted_images(item: &ClipboardItem, into_text_field: bool) -> Vec<Pasted> {
    let has_text = item
        .entries()
        .iter()
        .any(|entry| matches!(entry, ClipboardEntry::String(text) if !text.text().is_empty()));
    if into_text_field && has_text {
        return Vec::new();
    }
    item.entries()
        .iter()
        .flat_map(|entry| match entry {
            ClipboardEntry::Image(image) => vec![Pasted::Bytes(image.bytes.clone())],
            ClipboardEntry::ExternalPaths(paths) => paths
                .paths()
                .iter()
                .filter(|path| is_accepted(path))
                .cloned()
                .map(Pasted::File)
                .collect(),
            ClipboardEntry::String(_) => Vec::new(),
        })
        .collect()
}

/// The bytes of a pasted image. Runs off the main thread.
pub(crate) fn read_pasted(pasted: Pasted) -> anyhow::Result<Vec<u8>> {
    match pasted {
        Pasted::Bytes(bytes) => Ok(bytes),
        Pasted::File(path) => Ok(std::fs::read(path)?),
    }
}
