//! Feeding a media grid only what changed.
//!
//! [`MediaGridState::sync`] takes the items' keys and shapes by value and
//! compares them with the last ones in full. Called from `render`, that is a
//! copy and a comparison of every loaded item on every frame the screen draws —
//! each frame of a playing clip, each turn of a spinner. [`GridSync`] calls it
//! only when the items (by the owner's revision) or the grid's geometry moved.

use artsnack_ui::MediaGridState;
use gpui_kit::{Pixels, SharedString, Window};

#[derive(Clone, Copy, Debug, PartialEq)]
struct Inputs {
    revision: u64,
    /// The grid's width from the last layout: the grid measures itself in
    /// paint, and its viewport spans the same box.
    width: Pixels,
    rem: Pixels,
    tile_scale: f32,
}

#[derive(Default)]
pub struct GridSync {
    last: Option<Inputs>,
}

impl GridSync {
    /// Lays `grid` out again if the items (`revision`) or the geometry changed
    /// since the last call; `items` gives the keys and shapes, in display
    /// order, only then.
    pub fn sync(
        &mut self,
        grid: &mut MediaGridState,
        revision: u64,
        tile_scale: f32,
        window: &Window,
        items: impl FnOnce() -> (Vec<SharedString>, Vec<f32>),
    ) {
        let inputs = Inputs {
            revision,
            width: grid.viewport().size.width,
            rem: window.rem_size(),
            tile_scale,
        };
        if self.last == Some(inputs) {
            return;
        }
        let (keys, aspects) = items();
        grid.sync(keys, aspects, tile_scale, window);
        self.last = Some(inputs);
    }
}
