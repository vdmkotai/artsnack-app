//! `packages/backend/convex/grokAuth.ts` and `grokAuthActions.ts`: the user's
//! SuperGrok connection, made with xAI's device-authorization flow.

use serde::Deserialize;

use crate::{Action, Mutation, NoArgs, Query};

#[derive(Clone, Debug, Default, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GrokConnection {
    pub connected: bool,
    pub email: Option<String>,
}

pub const CONNECTION: Query<NoArgs, GrokConnection> = Query::new("grokAuth:getConnection");

pub const DISCONNECT: Mutation<NoArgs, ()> = Mutation::new("grokAuth:disconnect");

#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceAuth {
    pub user_code: String,
    pub verification_uri: String,
    pub verification_uri_complete: Option<String>,
    /// Seconds.
    pub expires_in: f64,
    /// Seconds between polls.
    pub interval: f64,
}

/// Starts a device authorization; the user confirms the code on xAI's site.
pub const START_DEVICE_AUTH: Action<NoArgs, DeviceAuth> =
    Action::new("grokAuthActions:startDeviceAuth");

#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(tag = "status", rename_all = "lowercase")]
pub enum DevicePoll {
    Pending,
    Done { email: Option<String> },
    Expired,
    Denied,
}

/// One poll of the token endpoint; call every `interval` seconds while pending.
pub const POLL_DEVICE_AUTH: Action<NoArgs, DevicePoll> =
    Action::new("grokAuthActions:pollDeviceAuth");
