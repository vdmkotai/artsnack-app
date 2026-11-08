//! Video playback.
//!
//! On macOS an `AVPlayer` decodes the clip (hardware, with its own buffering
//! and range requests against the media CDN) into an `AVPlayerItemVideoOutput`;
//! each frame comes out as a `CVPixelBuffer` in the one format GPUI's Metal
//! renderer draws with `surface()` (`420YpCbCr8BiPlanarFullRange`). The caller
//! polls [`Player::tick`] once per display frame while the clip wants frames
//! ([`Player::wants_frames`]) and draws [`Player::frame`] when it reports a new
//! one. Audio plays through the player and every preset starts muted: the
//! owner's rule is that nothing ever starts making sound by itself, so sound
//! is only ever the caller's [`Player::set_muted`] in answer to the user.
//!
//! The crate has no GPUI dependency, so `cargo check --target
//! aarch64-apple-darwin -p artsnack-video` works on any machine.

/// What a player is doing.
#[derive(Clone, Debug, PartialEq)]
pub enum Status {
    Loading,
    Ready,
    Failed(String),
}

/// How a player starts.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Options {
    pub muted: bool,
    /// Back to the start at the end, forever.
    pub looping: bool,
    pub autoplay: bool,
}

impl Options {
    /// A grid tile: muted, looping, playing.
    pub const TILE: Self = Self {
        muted: true,
        looping: true,
        autoplay: true,
    };
    /// The viewer: looping and playing (it opened on purpose), but muted —
    /// sound only when the user asks for it (M, or the unmute control), never
    /// because the viewer opened or stepped to the next clip.
    pub const VIEWER: Self = Self {
        muted: true,
        looping: true,
        autoplay: true,
    };
}

#[cfg(target_os = "macos")]
mod mac;
#[cfg(target_os = "macos")]
pub use mac::{Frame, Player};

#[cfg(not(target_os = "macos"))]
mod fallback;
#[cfg(not(target_os = "macos"))]
pub use fallback::{Frame, Player};

/// `m:ss`, the duration badge and the viewer's clock.
pub fn format_time(seconds: f64) -> String {
    let total = if seconds.is_finite() && seconds > 0. {
        seconds.round() as u64
    } else {
        0
    };
    format!("{}:{:02}", total / 60, total % 60)
}

#[cfg(test)]
mod tests {
    use super::{Options, format_time};

    #[test]
    fn no_preset_starts_with_sound() {
        let presets = [Options::TILE, Options::VIEWER];
        assert!(presets.iter().all(|options| options.muted));
    }

    #[test]
    fn formats_clock_time() {
        assert_eq!(format_time(0.), "0:00");
        assert_eq!(format_time(9.6), "0:10");
        assert_eq!(format_time(75.), "1:15");
        assert_eq!(format_time(f64::NAN), "0:00");
    }
}
