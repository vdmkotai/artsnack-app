//! The seam for playing clips in the grid.
//!
//! On the web the results grid plays its clips — muted, looping, no controls —
//! but only the few nearest the centre of the scroll area, decided for the
//! whole grid at once (`video-playback.ts`): at most four, a clip already
//! playing keeps its slot unless a rival is clearly closer, and nothing plays
//! while the viewer covers the grid. Nothing ever plays with sound by itself.
//!
//! The choice is made here every frame from the masonry's visible cells;
//! `artsnack_ui::ClipPlayers` keeps an AVFoundation player for each chosen
//! clip and lets go of the others, and the tile draws its frames over the
//! poster. A build without a player (not macOS) keeps every poster.

use artsnack_ui::MasonryCell;
use gpui_kit::SharedString;

/// How many clips of the grid may play at the same time.
const MAX_PLAYING_CLIPS: usize = 4;
/// A playing clip keeps its slot unless a rival is clearly closer.
const PLAYING_BIAS: f32 = 0.75;

/// The visible part of the grid, in masonry coordinates.
#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) struct Viewport {
    pub top: f32,
    pub height: f32,
    pub width: f32,
}

/// Which clips of the grid play.
pub(crate) struct ClipScheduler {
    /// Whether this build can play a clip at all.
    player: bool,
    /// Nearest the centre first.
    playing: Vec<SharedString>,
    /// The viewer covers the grid.
    suspended: bool,
}

impl Default for ClipScheduler {
    fn default() -> Self {
        Self {
            player: artsnack_ui::PLAYBACK,
            playing: Vec::new(),
            suspended: false,
        }
    }
}

impl ClipScheduler {
    /// The clips to play, nearest the centre first.
    pub fn playing(&self) -> &[SharedString] {
        if self.player { &self.playing } else { &[] }
    }

    pub fn set_suspended(&mut self, suspended: bool) {
        self.suspended = suspended;
        if suspended {
            self.playing.clear();
        }
    }

    /// Picks the clips to play from the ones near the viewport: the visible
    /// ones nearest its centre, vertical distance first (a feed is read top to
    /// bottom). Call once per frame.
    pub fn schedule<'a>(
        &mut self,
        clips: impl IntoIterator<Item = (&'a SharedString, MasonryCell)>,
        viewport: Viewport,
    ) {
        if self.suspended || viewport.height <= 0.0 {
            self.playing.clear();
            return;
        }
        let centre_x = viewport.width / 2.0;
        let centre_y = viewport.top + viewport.height / 2.0;
        let bottom = viewport.top + viewport.height;
        let mut ranked: Vec<(f32, &SharedString)> = clips
            .into_iter()
            .filter(|(_, cell)| cell.y + cell.height > viewport.top && cell.y < bottom)
            .map(|(key, cell)| {
                let distance = (((cell.x + cell.width / 2.0) - centre_x) * 0.5)
                    .hypot((cell.y + cell.height / 2.0) - centre_y);
                let bias = if self.playing.contains(key) {
                    PLAYING_BIAS
                } else {
                    1.0
                };
                (distance * bias, key)
            })
            .collect();
        ranked.sort_by(|a, b| a.0.total_cmp(&b.0));
        self.playing = ranked
            .into_iter()
            .take(MAX_PLAYING_CLIPS)
            .map(|(_, key)| key.clone())
            .collect();
    }

    /// Whether the clip `key` is playing (its frames replace the poster).
    pub fn is_playing(&self, key: &str) -> bool {
        self.player && self.playing.iter().any(|playing| playing == key)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cell(y: f32) -> MasonryCell {
        MasonryCell {
            x: 0.0,
            y,
            width: 100.0,
            height: 100.0,
        }
    }

    #[test]
    fn plays_the_visible_clips_nearest_the_centre_and_keeps_a_playing_one() {
        let keys: Vec<SharedString> = (0..7).map(|ix| format!("c{ix}").into()).collect();
        let viewport = Viewport {
            top: 0.0,
            height: 700.0,
            width: 100.0,
        };
        let mut scheduler = ClipScheduler {
            player: true,
            ..ClipScheduler::default()
        };
        // Seven stacked clips; the centre is at 350, inside c3.
        scheduler.schedule(
            keys.iter()
                .enumerate()
                .map(|(ix, key)| (key, cell(ix as f32 * 100.0))),
            viewport,
        );
        let playing: Vec<bool> = keys.iter().map(|key| scheduler.is_playing(key)).collect();
        assert_eq!(playing, [false, true, true, true, true, false, false]);

        // Scrolled 20 px: c5 is now closer than c1 (180 px against 220), but
        // c1 is playing and keeps its slot.
        scheduler.schedule(
            keys.iter()
                .enumerate()
                .map(|(ix, key)| (key, cell(ix as f32 * 100.0))),
            Viewport {
                top: 20.0,
                ..viewport
            },
        );
        assert!(scheduler.is_playing("c1") && !scheduler.is_playing("c5"));

        scheduler.set_suspended(true);
        assert!(!scheduler.is_playing("c3"));
    }

    #[test]
    fn nothing_plays_without_a_player() {
        let key: SharedString = "c".into();
        let mut scheduler = ClipScheduler {
            player: false,
            ..ClipScheduler::default()
        };
        scheduler.schedule(
            [(&key, cell(0.0))],
            Viewport {
                top: 0.0,
                height: 500.0,
                width: 100.0,
            },
        );
        assert!(!scheduler.is_playing("c"));
    }
}
