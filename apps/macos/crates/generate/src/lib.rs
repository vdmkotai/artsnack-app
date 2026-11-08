//! The Generate screen.

mod backend_status;
mod controls;
mod enhance;
mod form;
mod image_size;
mod results;
mod self_hosted;
mod view;

pub use enhance::{EnhanceEvent, EnhanceView};
pub use self_hosted::{SelfHostedComposer, Started};
pub use view::{GenerateEvent, GenerateTab, GenerateView};

/// Binds the screen's keys. Call once at startup.
pub fn init(cx: &mut gpui_kit::App) {
    self_hosted::init(cx);
    enhance::init(cx);
    // The two tabs this screen hosts from their own crates.
    artsnack_api_tab::init(cx);
    artsnack_video_tab::init(cx);
}
