//! Image dimensions for the self-hosted form: a port of
//! `packages/shared/image-size.ts`. Keep the two identical — the server bounds
//! the same numbers.

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ImageSize {
    pub width: u32,
    pub height: u32,
}

pub const MIN: u32 = 512;
pub const MAX: u32 = 2048;
pub const STEP: u32 = 8;
pub const SCALE_STEP: f64 = 0.05;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Preset {
    pub id: &'static str,
    pub label: &'static str,
    pub x: u32,
    pub y: u32,
    pub width: u32,
    pub height: u32,
}

pub const PRESETS: [Preset; 5] = [
    Preset {
        id: "square",
        label: "Square",
        x: 1,
        y: 1,
        width: 1024,
        height: 1024,
    },
    Preset {
        id: "photo",
        label: "Photo",
        x: 4,
        y: 3,
        width: 1024,
        height: 768,
    },
    Preset {
        id: "classic",
        label: "Classic",
        x: 3,
        y: 2,
        width: 1152,
        height: 768,
    },
    Preset {
        id: "wide",
        label: "Wide",
        x: 16,
        y: 9,
        width: 1280,
        height: 720,
    },
    Preset {
        id: "panorama",
        label: "Panorama",
        x: 7,
        y: 3,
        width: 1344,
        height: 576,
    },
];

impl Preset {
    /// The ratio as shown: `21:9` for the panorama, flipped in portrait.
    pub fn ratio_label(&self, portrait: bool) -> String {
        if self.id == "panorama" {
            return if portrait { "9:21" } else { "21:9" }.into();
        }
        let (x, y) = if portrait {
            (self.y, self.x)
        } else {
            (self.x, self.y)
        };
        format!("{x}:{y}")
    }

    pub fn size(&self, portrait: bool) -> ImageSize {
        if portrait {
            ImageSize {
                width: self.height,
                height: self.width,
            }
        } else {
            ImageSize {
                width: self.width,
                height: self.height,
            }
        }
    }
}

/// Round to the latent grid (8 px) within 512–2048.
pub fn snap(value: f64) -> u32 {
    let value = if value.is_finite() { value } else { MIN as f64 };
    let snapped = (value / STEP as f64).round() * STEP as f64;
    (snapped as i64).clamp(MIN as i64, MAX as i64) as u32
}

pub fn matching_preset(size: ImageSize) -> Option<&'static Preset> {
    let (long, short) = (size.width.max(size.height), size.width.min(size.height));
    PRESETS.iter().find(|preset| {
        long * preset.y == short * preset.x
            || preset_sizes(preset.x, preset.y, size.height > size.width).contains(&size)
    })
}

/// The slider's stops for a preset ratio: 0.05× steps of the preset's base
/// size, snapped to the grid.
pub fn preset_sizes(x: u32, y: u32, portrait: bool) -> Vec<ImageSize> {
    let preset = PRESETS.iter().find(|preset| preset.x == x && preset.y == y);
    let base_width = preset.map(|p| p.width as f64).unwrap_or(1024.0);
    let base_height = preset
        .map(|p| p.height as f64)
        .unwrap_or(base_width * y as f64 / x as f64);
    let min = (MIN as f64 / (base_width.min(base_height) * SCALE_STEP)).ceil() as i64;
    let max = (MAX as f64 / (base_width.max(base_height) * SCALE_STEP)).floor() as i64;
    (min..=max)
        .map(|step| {
            let scale = step as f64 * SCALE_STEP;
            let width = snap(base_width * scale);
            let height = snap(base_height * scale);
            if portrait {
                ImageSize {
                    width: height,
                    height: width,
                }
            } else {
                ImageSize { width, height }
            }
        })
        .collect()
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Axis {
    Width,
    Height,
}

/// Sets one side and the other to keep the ratio, fitting both before
/// rounding — clamping them independently would stretch the image.
pub fn resize_locked(size: ImageSize, axis: Axis, value: u32) -> ImageSize {
    let ratio = size.width as f64 / size.height as f64;
    let requested_width = match axis {
        Axis::Width => value as f64,
        Axis::Height => value as f64 * ratio,
    };
    let width = requested_width
        .max((MIN as f64).max(MIN as f64 * ratio))
        .min((MAX as f64).min(MAX as f64 * ratio));
    ImageSize {
        width: snap(width),
        height: snap(width / ratio),
    }
}

/// The slider stops for any size: the preset's, or every 8 px of the long side
/// at the current ratio.
pub fn slider_stops(size: ImageSize, portrait: bool) -> Vec<ImageSize> {
    if let Some(preset) = matching_preset(size) {
        return preset_sizes(preset.x, preset.y, portrait);
    }
    let axis = if size.width >= size.height {
        Axis::Width
    } else {
        Axis::Height
    };
    let mut stops: Vec<ImageSize> = Vec::new();
    for i in 0..193 {
        let stop = resize_locked(size, axis, MIN + i * STEP);
        if stops.last() != Some(&stop) {
            stops.push(stop);
        }
    }
    stops
}

/// The stop closest to `size`.
pub fn nearest_stop(stops: &[ImageSize], size: ImageSize) -> usize {
    let distance =
        |stop: &ImageSize| stop.width.abs_diff(size.width) + stop.height.abs_diff(size.height);
    stops
        .iter()
        .enumerate()
        .min_by_key(|(_, stop)| distance(stop))
        .map(|(ix, _)| ix)
        .unwrap_or(0)
}

/// `1.25× · 1.64 MP`
pub fn scale_label(size: ImageSize) -> String {
    let base = matching_preset(size)
        .map(|preset| (preset.width * preset.height) as f64)
        .unwrap_or(1024.0 * 1024.0);
    let pixels = (size.width * size.height) as f64;
    format!("{:.2}× · {:.2} MP", (pixels / base).sqrt(), pixels / 1e6)
}

#[cfg(test)]
mod tests {
    use super::*;

    const fn size(width: u32, height: u32) -> ImageSize {
        ImageSize { width, height }
    }

    #[test]
    fn snaps_to_the_grid_and_range() {
        assert_eq!(snap(1021.0), 1024);
        assert_eq!(snap(100.0), 512);
        assert_eq!(snap(9999.0), 2048);
        assert_eq!(snap(f64::NAN), 512);
    }

    #[test]
    fn recognises_presets_in_both_orientations_and_scaled() {
        assert_eq!(
            matching_preset(size(1024, 1024)).map(|p| p.id),
            Some("square")
        );
        assert_eq!(
            matching_preset(size(768, 1024)).map(|p| p.id),
            Some("photo")
        );
        assert_eq!(matching_preset(size(1280, 720)).map(|p| p.id), Some("wide"));
        assert_eq!(matching_preset(size(1000, 600)), None);
    }

    #[test]
    fn preset_stops_stay_in_range_and_include_the_base() {
        let stops = preset_sizes(1, 1, false);
        assert!(stops.contains(&size(1024, 1024)));
        assert!(stops.iter().all(|s| (MIN..=MAX).contains(&s.width)));
        let portrait = preset_sizes(16, 9, true);
        assert!(portrait.contains(&size(720, 1280)));
    }

    #[test]
    fn locked_resize_keeps_the_ratio_within_bounds() {
        assert_eq!(
            resize_locked(size(1024, 512), Axis::Width, 1600),
            size(1600, 800)
        );
        // Width 3000 would need height 1500 at 2:1, but width caps at 2048.
        assert_eq!(
            resize_locked(size(1024, 512), Axis::Width, 3000),
            size(2048, 1024)
        );
        // Height cannot go below 512, so width cannot go below 1024 at 2:1.
        assert_eq!(
            resize_locked(size(1024, 512), Axis::Height, 100),
            size(1024, 512)
        );
    }

    #[test]
    fn labels() {
        assert_eq!(PRESETS[4].ratio_label(false), "21:9");
        assert_eq!(PRESETS[4].ratio_label(true), "9:21");
        assert_eq!(PRESETS[1].ratio_label(true), "3:4");
        assert_eq!(scale_label(size(1024, 1024)), "1.00× · 1.05 MP");
    }
}
