//! `grokProcessor.ts`: the source clips Grok's Edit and Extend work on.

use serde::{Deserialize, Serialize};

use crate::Action;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UploadSourceVideoArgs {
    /// The clip, uploaded through `grokGenerations:generateRefUploadUrl`.
    pub storage_id: String,
}

#[derive(Clone, Debug, Serialize)]
pub struct DescribeSourceVideoArgs {
    /// One of the app's own clips: an mp4 on a video prefix.
    pub key: String,
}

/// What the server measured from the file's own headers.
#[derive(Clone, Debug, Deserialize)]
pub struct SourceVideoFacts {
    pub key: String,
    /// Seconds; `None` when the file carries no movie header (a fragmented
    /// stream).
    pub seconds: Option<f64>,
    /// "480p" | "720p": the source's size capped at 720p, what Grok returns.
    pub resolution: Option<String>,
}

/// Checks an uploaded clip is an MP4, measures it and parks it in B2.
pub const UPLOAD_SOURCE_VIDEO: Action<UploadSourceVideoArgs, SourceVideoFacts> =
    Action::new("grokProcessor:uploadSourceVideo");

/// Measures one of the app's own clips for "Edit/Extend with Grok".
pub const DESCRIBE_SOURCE_VIDEO: Action<DescribeSourceVideoArgs, SourceVideoFacts> =
    Action::new("grokProcessor:describeSourceVideo");
