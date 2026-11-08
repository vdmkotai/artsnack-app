//! Platforms without a player: every clip shows its poster.

use crate::{Options, Status};

/// Never produced off macOS.
#[derive(Clone, Debug)]
pub struct Frame;

pub struct Player;

impl Player {
    pub fn new(_url: &str, _options: Options) -> anyhow::Result<Self> {
        anyhow::bail!("video playback is only built for macOS")
    }

    pub fn status(&self) -> Status {
        Status::Failed("video playback is only built for macOS".into())
    }

    pub fn play(&self) {}
    pub fn pause(&self) {}

    pub fn is_playing(&self) -> bool {
        false
    }

    pub fn set_muted(&self, _muted: bool) {}

    pub fn is_muted(&self) -> bool {
        true
    }

    pub fn seek(&self, _seconds: f64) {}

    pub fn is_seeking(&self) -> bool {
        false
    }

    pub fn wants_frames(&self) -> bool {
        false
    }

    pub fn tick(&self) -> bool {
        false
    }

    pub fn position(&self) -> f64 {
        0.
    }

    pub fn duration(&self) -> Option<f64> {
        None
    }

    pub fn natural_size(&self) -> Option<(f32, f32)> {
        None
    }

    pub fn frame(&mut self) -> Option<Frame> {
        None
    }
}
