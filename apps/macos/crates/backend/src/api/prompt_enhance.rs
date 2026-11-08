//! `packages/backend/convex/promptEnhance.ts`: rewrites a prompt with a recipe
//! or a one-off instruction (Grok on the subscription, Atlas as the fallback).

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::Action;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EnhanceArgs {
    pub prompt: String,
    /// Exactly one of `recipe_id` and `instruction`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub recipe_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub instruction: Option<String>,
    /// `EnhanceContext` (packages/shared/prompt-enhance.ts): media, target
    /// model, duration, aspect ratio, reference count.
    pub context: Value,
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct EnhanceModelRef {
    pub label: String,
    /// "grok" | "atlas".
    pub provider: String,
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Enhanced {
    pub text: String,
    pub cost_usd: Option<f64>,
    pub model: EnhanceModelRef,
    pub fell_back: bool,
    pub reason: Option<String>,
}

pub const ENHANCE: Action<EnhanceArgs, Enhanced> = Action::new("promptEnhance:enhance");
