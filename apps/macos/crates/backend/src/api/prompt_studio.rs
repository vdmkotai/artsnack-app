//! `packages/backend/convex/promptStudio.ts` and `promptStudioRun.ts`: the
//! Prompt Studio chat that writes prompts ("Write with AI" on the API tab).
//! The rules behind them — labels, the reply format, the diff — are
//! `packages/shared/prompt-studio.ts`; the server gives out every label.

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::{Action, Mutation, NoArgs, Query};

/// One prompt the model proposed (`StudioVariant`).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StudioVariant {
    /// "1", "2", "3"; a revision of 2 is "2.1".
    pub label: String,
    /// In the user's language.
    pub title: String,
    /// In the user's language.
    pub summary: String,
    /// The prompt itself, in English.
    pub prompt: String,
    /// For a revision: what changed, in the user's language.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub changes: Option<String>,
    /// The variant this one revises.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent_label: Option<String>,
}

/// One message of a session (`StudioMessage`).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "role", rename_all = "lowercase")]
pub enum StudioMessage {
    #[serde(rename_all = "camelCase")]
    User {
        text: String,
        /// The label of the variant the message answers.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        reply_to: Option<String>,
        /// How many references the model was shown with it.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        image_count: Option<f64>,
        at: f64,
    },
    #[serde(rename_all = "camelCase")]
    Assistant {
        variants: Vec<StudioVariant>,
        /// The model's label, e.g. "Grok 4.6".
        model: String,
        /// "grok" (the subscription) or "atlas".
        provider: String,
        fell_back: bool,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        reason: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        cost_usd: Option<f64>,
        duration_ms: f64,
        at: f64,
    },
}

/// A session row (`promptStudioSessions`), as `promptStudio:get` returns it.
#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StudioSession {
    #[serde(rename = "_id")]
    pub id: String,
    pub title: String,
    /// "image" or "video".
    pub media: String,
    pub messages: Vec<StudioMessage>,
    pub updated_at: f64,
}

/// One row of History (`promptStudio:list`).
#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StudioSessionSummary {
    #[serde(rename = "_id")]
    pub id: String,
    pub title: String,
    pub media: String,
    pub updated_at: f64,
    /// How many messages the user sent.
    pub rounds: f64,
}

/// The 30 most recently used sessions, newest first.
pub const LIST: Query<NoArgs, Vec<StudioSessionSummary>> = Query::new("promptStudio:list");

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionArgs {
    pub session_id: String,
}

/// Null for a session that is gone or not the caller's. Any string is
/// accepted: a remembered id that no longer parses reads as gone.
pub const GET: Query<SessionArgs, Option<StudioSession>> = Query::new("promptStudio:get");

pub const REMOVE: Mutation<SessionArgs, ()> = Mutation::new("promptStudio:remove");

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SendArgs {
    /// Absent starts a session.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    /// At most `MAX_STUDIO_TEXT` (4000) UTF-16 units once trimmed.
    pub text: String,
    /// The label of the variant being refined.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reply_to: Option<String>,
    /// 1, 2 or 3.
    pub variant_count: u32,
    /// An Enhance recipe the prompts must follow.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub format_id: Option<String>,
    /// An `ENHANCE_MODELS` id.
    pub model_id: String,
    /// `StudioContext`, exactly the fields `studioContextValidator` lists.
    pub context: Value,
    /// The prompt in the form, when it is to be read along.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub current_prompt: Option<String>,
    /// Up to four `data:image/jpeg;base64,…` URLs at the `studio` profile,
    /// only for a model with `vision`. Never stored.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub images: Option<Vec<String>>,
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SendResult {
    pub session_id: String,
    /// The labels the new variants were given.
    pub labels: Vec<String>,
    /// The model that answered, by label.
    pub model: String,
    /// The subscription did not answer and Atlas did.
    pub fell_back: bool,
    pub reason: Option<String>,
    pub cost_usd: Option<f64>,
}

/// One turn: the message in, a set of labelled variants appended to the
/// session. Retries once by itself when the model's answer is not the JSON
/// it asked for; may take minutes.
pub const SEND: Action<SendArgs, SendResult> = Action::new("promptStudioRun:send");

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_session_reads_both_kinds_of_message() {
        let session: StudioSession = serde_json::from_value(serde_json::json!({
            "_id": "k1", "_creationTime": 1.0, "userId": "u", "title": "Desert dance",
            "media": "video", "createdAt": 1.0, "updatedAt": 2.0,
            "sending": { "id": "x", "until": 5.0 },
            "messages": [
                { "role": "user", "text": "@image1 dances", "imageCount": 1, "at": 1.0 },
                {
                    "role": "assistant", "model": "Grok 4.6", "provider": "grok",
                    "fellBack": false, "durationMs": 4200, "at": 2.0,
                    "variants": [
                        { "label": "1", "title": "Ветер", "summary": "s", "prompt": "p" },
                        { "label": "1.1", "title": "t", "summary": "s", "prompt": "p",
                          "changes": "slower", "parentLabel": "1" }
                    ]
                }
            ]
        }))
        .unwrap();
        assert_eq!(session.messages.len(), 2);
        let StudioMessage::Assistant { variants, .. } = &session.messages[1] else {
            panic!("expected the model's answer");
        };
        assert_eq!(variants[1].parent_label.as_deref(), Some("1"));
    }

    #[test]
    fn send_leaves_out_what_is_unset() {
        let args = SendArgs {
            session_id: None,
            text: "hi".into(),
            reply_to: None,
            variant_count: 3,
            format_id: None,
            model_id: "grok:grok-4.6".into(),
            context: serde_json::json!({ "media": "image" }),
            current_prompt: None,
            images: None,
        };
        assert_eq!(
            serde_json::to_string(&args).unwrap(),
            r#"{"text":"hi","variantCount":3,"modelId":"grok:grok-4.6","context":{"media":"image"}}"#
        );
    }
}
