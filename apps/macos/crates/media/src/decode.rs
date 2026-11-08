//! Decoding off the main thread, at the size the image is shown.
//!
//! GPUI's own loader decodes at full resolution and keeps it; a 4096² original
//! shown as a 300 px tile would hold 64 MB of texture. Here an image larger
//! than its requested size is downscaled before it ever becomes a texture.
//!
//! The downscale cannot happen inside the decoder: the `image` crate's JPEG,
//! PNG and WebP decoders have no reduced-size output (no DCT scaling), so the
//! full image is decoded first and then resized. What bounds the memory that
//! costs is [`decode_bounded`]: it reads the dimensions from the header, works
//! out the peak bytes the decode needs, and waits until that much of a shared
//! allowance is free, so a few huge originals decode one after another rather
//! than all at once.

use std::{io::Cursor, sync::Arc, sync::LazyLock};

use gpui_kit::{BackgroundExecutor, RenderImage};
use image::{DynamicImage, Frame, ImageDecoder as _, ImageReader, Limits, imageops::FilterType};
use smallvec::SmallVec;
use tokio::sync::Semaphore;

/// Decoded bytes, in MiB, that may be in flight across all decodes at once.
/// One decode larger than this runs alone.
const DECODE_ALLOWANCE_MIB: u32 = 512;
/// The most one decode may allocate. Above `image`'s default of 512 MiB, so a
/// 10000×10000 original still decodes — the allowance keeps it alone.
const MAX_DECODE_ALLOC: u64 = 1536 * 1024 * 1024;
/// Wider or taller than this is not a picture but a decompression bomb.
const MAX_SIDE: u32 = 32_768;

static DECODE_ALLOWANCE: LazyLock<Semaphore> =
    LazyLock::new(|| Semaphore::new(DECODE_ALLOWANCE_MIB as usize));

fn limits() -> Limits {
    let mut limits = Limits::default();
    limits.max_image_width = Some(MAX_SIDE);
    limits.max_image_height = Some(MAX_SIDE);
    limits.max_alloc = Some(MAX_DECODE_ALLOC);
    limits
}

fn reader(bytes: &[u8]) -> anyhow::Result<ImageReader<Cursor<&[u8]>>> {
    let mut reader = ImageReader::new(Cursor::new(bytes)).with_guessed_format()?;
    reader.limits(limits());
    Ok(reader)
}

/// Decodes `bytes` and scales it to fit `max_dimension` on its longer side.
/// Animated formats keep their first frame. Blocks; prefer [`decode_bounded`]
/// for anything that may be large.
pub fn decode(bytes: &[u8], max_dimension: Option<u32>) -> anyhow::Result<RenderImage> {
    let mut decoder = reader(bytes)?.into_decoder()?;
    let orientation = decoder.orientation()?;
    let mut image = DynamicImage::from_decoder(decoder)?;
    image.apply_orientation(orientation);

    if let Some(max) = max_dimension {
        let longest = image.width().max(image.height());
        if longest > max {
            image = image.resize(max, max, FilterType::Triangle);
        }
    }

    // GPUI textures are BGRA.
    let mut buffer = image.into_rgba8();
    for pixel in buffer.as_chunks_mut::<4>().0 {
        pixel.swap(0, 2);
    }
    let frames: SmallVec<[Frame; 1]> = SmallVec::from_elem(Frame::new(buffer), 1);
    Ok(RenderImage::new(frames))
}

/// Width and height from the image's header, without decoding its pixels.
pub fn dimensions(bytes: &[u8]) -> anyhow::Result<(u32, u32)> {
    Ok(reader(bytes)?.into_dimensions()?)
}

/// The most memory decoding a `width`×`height` image to fit `max_dimension`
/// holds at once: the full decode, plus the resized (or converted) output.
pub fn decode_cost(width: u32, height: u32, max_dimension: Option<u32>) -> u64 {
    let full = u64::from(width) * u64::from(height) * 4;
    let output = match max_dimension {
        Some(max) if width.max(height) > max => {
            let scale = f64::from(max) / f64::from(width.max(height));
            let (w, h) = (
                (f64::from(width) * scale).ceil() as u64,
                (f64::from(height) * scale).ceil() as u64,
            );
            w * h * 4
        }
        _ => full,
    };
    full + output
}

/// [`decode`] on `executor`, admitted against the shared decode allowance by
/// its estimated peak memory, so concurrent decodes of large originals do not
/// add up past it.
pub async fn decode_bounded(
    bytes: Arc<[u8]>,
    max_dimension: Option<u32>,
    executor: &BackgroundExecutor,
) -> anyhow::Result<RenderImage> {
    let header = bytes.clone();
    let (width, height) = executor.spawn(async move { dimensions(&header) }).await?;
    let mib = decode_cost(width, height, max_dimension).div_ceil(1024 * 1024);
    let permits = mib.clamp(1, u64::from(DECODE_ALLOWANCE_MIB)) as u32;
    let _allowance = DECODE_ALLOWANCE.acquire_many(permits).await?;
    executor
        .spawn(async move { decode(&bytes, max_dimension) })
        .await
}

/// Bytes a decoded image occupies (in memory and, once drawn, on the GPU).
pub fn decoded_size(image: &RenderImage) -> usize {
    let size = image.size(0);
    (size.width.0 as usize) * (size.height.0 as usize) * 4
}

#[cfg(test)]
mod tests {
    use super::*;

    fn png(width: u32, height: u32) -> Vec<u8> {
        let mut bytes = Vec::new();
        DynamicImage::new_rgb8(width, height)
            .write_to(&mut Cursor::new(&mut bytes), image::ImageFormat::Png)
            .unwrap();
        bytes
    }

    #[test]
    fn reads_dimensions_and_decodes_to_the_requested_size() {
        let bytes = png(400, 200);
        assert_eq!(dimensions(&bytes).unwrap(), (400, 200));
        let image = decode(&bytes, Some(100)).unwrap();
        assert_eq!(decoded_size(&image), 100 * 50 * 4);
    }

    #[test]
    fn the_cost_counts_the_full_decode_and_the_output() {
        // 10000² RGBA is ~381 MiB before the 768 px preview is made.
        let cost = decode_cost(10_000, 10_000, Some(768));
        assert_eq!(cost, 10_000 * 10_000 * 4 + 768 * 768 * 4);
        assert_eq!(decode_cost(100, 50, None), 2 * 100 * 50 * 4);
    }

    #[test]
    fn rejects_what_is_not_an_image() {
        assert!(decode(b"\0\0\0\x18ftypmp42", Some(64)).is_err());
        assert!(dimensions(b"<html>").is_err());
    }
}
