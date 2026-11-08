//! `packages/backend/convex/savedPrompts.ts`: the prompt library.

use serde::{Deserialize, Serialize};

use crate::{Mutation, NoArgs, Query, Row};

#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedPrompt {
    #[serde(rename = "_id")]
    pub id: String,
    pub title: String,
    pub text: String,
    pub created_at: f64,
    pub updated_at: f64,
}

impl Row for SavedPrompt {
    fn row_id(&self) -> &str {
        &self.id
    }
}

/// Newest first, at most 500.
pub const LIST: Query<NoArgs, Vec<SavedPrompt>> = Query::new("savedPrompts:list");

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveArgs {
    pub text: String,
    /// Derived from the first line when absent.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    /// The "New prompt" button: a fresh card every time, no dedupe.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub allow_duplicate: Option<bool>,
}

#[derive(Clone, Debug, Deserialize)]
pub struct Saved {
    pub id: String,
    pub duplicate: bool,
}

pub const SAVE: Mutation<SaveArgs, Saved> = Mutation::new("savedPrompts:save");

#[derive(Clone, Debug, Default, Serialize)]
pub struct UpdateArgs {
    pub id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
}

pub const UPDATE: Mutation<UpdateArgs, ()> = Mutation::new("savedPrompts:update");

#[derive(Clone, Debug, Serialize)]
pub struct RemoveArgs {
    pub id: String,
}

pub const REMOVE: Mutation<RemoveArgs, ()> = Mutation::new("savedPrompts:remove");
