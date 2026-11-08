//! The Self-hosted image tab.

mod composer;

pub use composer::{ComposerKind, SelfHostedComposer, Started};

pub fn init(cx: &mut gpui_kit::App) {
    composer::init(cx);
}
