//! The Generate screen's API tab: jobs on hosted providers — Grok (through
//! the user's SuperGrok subscription), fal.ai, Higgsfield and Atlas Cloud —
//! and the Image → Prompt tool that sits in the same provider row.
//!
//! - `composer`: the model switcher, the form, references, price and submit.
//! - [`results`]: the live grid of jobs from `grokGenerations:list`.
//! - [`describe`]: Image → Prompt.
//! - `studio`: Prompt Studio, a chat that writes the prompt.

mod composer;
pub mod describe;
pub mod mention;
mod reference_source;
pub mod results;
mod studio;
mod tab;

pub use describe::DescribePanel;
pub use mention::{PromptMentions, TagInserted, TaggableReferences};
pub use results::{ApiResults, ApiResultsEvent, VideoRole};
pub use tab::{ApiTab, ApiTabEvent, TabsBuilder};

/// Binds the tab's keys. Call once at startup.
pub fn init(cx: &mut gpui_kit::App) {
    composer::init(cx);
    tab::init(cx);
    results::init(cx);
    describe::init(cx);
    // After the tab's own Cmd+Enter, which it has to win against.
    studio::init(cx);
}
