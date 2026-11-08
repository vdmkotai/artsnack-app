//! What a library screen asks the rest of the app to do with an item. The
//! screens only report; the shell routes each command to the screen that
//! handles it (Generate, Enhance).

use gpui_kit::SharedString;
use serde_json::Value;

/// Where a result's settings come from, for Reproduce.
#[derive(Clone, Debug, PartialEq)]
pub enum ReproduceSource {
    /// A self-hosted image: its saved form.
    SelfHosted { form_state: Value },
    /// An API-tab result: re-open its row's settings.
    Api { generation_id: String },
    /// An enhancement: re-open the Enhance form.
    Enhancement { enhancement_id: String },
}

#[derive(Clone, Debug, PartialEq)]
pub enum MediaCommand {
    Reproduce(ReproduceSource),
    /// Open Enhance with this image (and its form, if self-hosted).
    Enhance {
        image_url: SharedString,
        form_state: Option<Value>,
    },
    /// Add this image as a reference on the API tab.
    UseAsReference {
        image_url: SharedString,
    },
}
