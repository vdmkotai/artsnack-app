//! Preparing an image the user picked (a reference, an Enhance source) and
//! uploading it to Convex file storage — what the iOS app does with
//! `grokGenerations.generateRefUploadUrl`.
//!
//! The limits come from `packages/shared/reference-profile.ts` (the caller reads
//! them through the rules bridge); the steps mirror the web's
//! `apps/web/lib/resize-image.ts`: scale down to the profile's long edge,
//! stretch an edge that ends up under the minimum back up (each edge clamped on
//! its own, as the providers require), then re-encode JPEG at falling quality
//! until it fits the byte limit.

use std::io::Cursor;

use anyhow::{Context as _, bail};
use image::{
    DynamicImage, ImageDecoder as _, ImageReader, codecs::jpeg::JpegEncoder, imageops::FilterType,
};
use serde::Deserialize;

/// `ProfileLimits` from reference-profile.ts.
#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfileLimits {
    pub max_dimension: u32,
    pub min_dimension: u32,
    pub max_bytes: u64,
    /// Tried in order until the result fits `max_bytes`.
    pub quality_steps: Vec<f32>,
}

#[derive(Clone, Debug)]
pub struct PreparedImage {
    pub jpeg: Vec<u8>,
    pub width: u32,
    pub height: u32,
    /// The source's width ÷ height (not the possibly squashed output's).
    pub aspect: f32,
}

/// Decodes `bytes` and prepares them for `limits`. Runs off the main thread.
pub fn prepare(bytes: &[u8], limits: &ProfileLimits) -> anyhow::Result<PreparedImage> {
    let reader = ImageReader::new(Cursor::new(bytes))
        .with_guessed_format()
        .context("reading the image")?;
    let mut decoder = reader.into_decoder().context("unsupported image format")?;
    let orientation = decoder.orientation()?;
    let mut image = DynamicImage::from_decoder(decoder).context("decoding the image")?;
    image.apply_orientation(orientation);

    let (source_width, source_height) = (image.width(), image.height());
    let (width, height) = target_size(source_width, source_height, limits);
    let image = if (width, height) == (source_width, source_height) {
        image
    } else {
        image.resize_exact(width, height, FilterType::Lanczos3)
    };
    let rgb = image.to_rgb8();

    for quality in &limits.quality_steps {
        let mut jpeg = Vec::new();
        let quality = (quality * 100.0).round().clamp(1.0, 100.0) as u8;
        JpegEncoder::new_with_quality(&mut jpeg, quality)
            .encode_image(&rgb)
            .context("encoding JPEG")?;
        if jpeg.len() as u64 <= limits.max_bytes {
            return Ok(PreparedImage {
                jpeg,
                width,
                height,
                aspect: source_width as f32 / source_height as f32,
            });
        }
    }
    bail!(
        "Could not compress the image below the {}KB limit",
        limits.max_bytes / 1024
    )
}

/// The web's two steps: scale down into the long edge, then stretch a short
/// edge back up to the minimum while staying within the long-edge limit.
fn target_size(width: u32, height: u32, limits: &ProfileLimits) -> (u32, u32) {
    let scale_down = (limits.max_dimension as f64 / width.max(height) as f64).min(1.0);
    let mut width = (width as f64 * scale_down).round().max(1.0);
    let mut height = (height as f64 * scale_down).round().max(1.0);
    let min_edge = width.min(height);
    if min_edge < limits.min_dimension as f64 {
        let scale_up = limits.min_dimension as f64 / min_edge;
        width = (width * scale_up).round().min(limits.max_dimension as f64);
        height = (height * scale_up).round().min(limits.max_dimension as f64);
    }
    (width as u32, height as u32)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct UploadResponse {
    storage_id: String,
}

/// POSTs the JPEG to a Convex upload URL; returns the storage id.
pub async fn upload_jpeg(upload_url: &str, jpeg: Vec<u8>) -> anyhow::Result<String> {
    upload_bytes(upload_url, jpeg, "image/jpeg").await
}

/// The MIME type of image bytes, by their signature.
pub fn image_content_type(bytes: &[u8]) -> &'static str {
    match image::guess_format(bytes) {
        Ok(image::ImageFormat::Png) => "image/png",
        Ok(image::ImageFormat::Jpeg) => "image/jpeg",
        Ok(image::ImageFormat::WebP) => "image/webp",
        Ok(image::ImageFormat::Gif) => "image/gif",
        _ => "application/octet-stream",
    }
}

/// POSTs bytes as they are (an Enhance source keeps its full quality, as on iOS).
pub async fn upload_bytes(
    upload_url: &str,
    bytes: Vec<u8>,
    content_type: &str,
) -> anyhow::Result<String> {
    let response = reqwest::Client::new()
        .post(upload_url)
        .header(reqwest::header::CONTENT_TYPE, content_type)
        .body(bytes)
        .timeout(std::time::Duration::from_secs(120))
        .send()
        .await
        .context("uploading the image")?;
    let status = response.status();
    if !status.is_success() {
        bail!("the upload was refused (HTTP {status})");
    }
    Ok(response.json::<UploadResponse>().await?.storage_id)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn grok() -> ProfileLimits {
        ProfileLimits {
            max_dimension: 768,
            min_dimension: 256,
            max_bytes: 400 * 1024,
            quality_steps: vec![0.8, 0.65, 0.5, 0.35],
        }
    }

    #[test]
    fn scales_into_the_long_edge() {
        assert_eq!(target_size(3000, 1500, &grok()), (768, 384));
        assert_eq!(target_size(500, 400, &grok()), (500, 400));
    }

    #[test]
    fn stretches_a_short_edge_to_the_minimum_within_the_maximum() {
        // A 10:1 panorama: 768×77 → the short edge is stretched to 256 and the
        // long edge stays capped at 768, so the output is squashed — as on the web.
        assert_eq!(target_size(3000, 300, &grok()), (768, 256));
    }

    #[test]
    fn prepares_a_small_png_as_jpeg() {
        let image = DynamicImage::new_rgb8(64, 32);
        let mut png = Vec::new();
        image
            .write_to(&mut Cursor::new(&mut png), image::ImageFormat::Png)
            .unwrap();
        let prepared = prepare(&png, &grok()).unwrap();
        assert_eq!((prepared.width, prepared.height), (512, 256));
        assert_eq!(prepared.aspect, 2.0);
        assert!(prepared.jpeg.starts_with(&[0xFF, 0xD8]));
    }
}
