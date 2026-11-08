//! `packages/backend/convex/savedSearches.ts`: named searches, synced to the
//! web and iOS apps. The intent is stored in its URL form
//! (`serializeSearchIntent`), so all three clients read each other's.

use serde::{Deserialize, Serialize};

use crate::{Mutation, NoArgs, Query, Row};

/// The longest name the server accepts (`MAX_TITLE`).
pub const MAX_TITLE_CHARS: usize = 80;

#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedSearch {
    #[serde(rename = "_id")]
    pub id: String,
    pub title: String,
    /// `q=…&negative=…&typos=1&sort=…&filters=…`.
    pub intent: String,
    pub created_at: f64,
    pub updated_at: f64,
}

impl Row for SavedSearch {
    fn row_id(&self) -> &str {
        &self.id
    }
}

/// Most recently updated first, at most 100.
pub const LIST: Query<NoArgs, Vec<SavedSearch>> = Query::new("savedSearches:list");

#[derive(Clone, Debug, Serialize)]
pub struct SaveArgs {
    /// Trimmed by the server; 1–80 characters.
    pub title: String,
    pub intent: String,
}

/// Saves under `title`, replacing the intent of an existing search of the same
/// name. Returns its id.
pub const SAVE: Mutation<SaveArgs, String> = Mutation::new("savedSearches:save");

#[derive(Clone, Debug, Serialize)]
pub struct RemoveArgs {
    pub id: String,
}

pub const REMOVE: Mutation<RemoveArgs, ()> = Mutation::new("savedSearches:remove");
