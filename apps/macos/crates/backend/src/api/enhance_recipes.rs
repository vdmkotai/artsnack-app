//! `packages/backend/convex/enhanceRecipes.ts`: the instructions behind the
//! prompt Enhance button, and which model runs them.

use serde::{Deserialize, Serialize};

use crate::{Mutation, NoArgs, Query, Row};

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RecipeMedia {
    Image,
    Video,
    #[default]
    Any,
}

impl RecipeMedia {
    pub const ALL: [Self; 3] = [Self::Any, Self::Image, Self::Video];

    pub fn label(self) -> &'static str {
        match self {
            Self::Any => "Any",
            Self::Image => "Image",
            Self::Video => "Video",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Recipe {
    #[serde(rename = "_id")]
    pub id: String,
    pub title: String,
    pub instructions: String,
    pub media: RecipeMedia,
    pub is_default: bool,
    /// Absent: the recipe uses the model set for every recipe.
    pub model_id: Option<String>,
    pub builtin_key: Option<String>,
}

impl Row for Recipe {
    fn row_id(&self) -> &str {
        &self.id
    }
}

/// Oldest first (the built-in order), at most 200.
pub const LIST: Query<NoArgs, Vec<Recipe>> = Query::new("enhanceRecipes:list");

#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecipeSettings {
    pub model_id: String,
    /// False until the built-ins (in their current version) were added.
    pub seeded: bool,
}

pub const SETTINGS: Query<NoArgs, Option<RecipeSettings>> = Query::new("enhanceRecipes:settings");

/// Adds the built-in recipes once (and newer built-ins later). Idempotent.
pub const ENSURE_SEEDED: Mutation<NoArgs, ()> = Mutation::new("enhanceRecipes:ensureSeeded");

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SetModelArgs {
    pub model_id: String,
}

pub const SET_MODEL: Mutation<SetModelArgs, ()> = Mutation::new("enhanceRecipes:setModel");

#[derive(Clone, Debug, Serialize)]
pub struct CreateArgs {
    pub title: String,
    pub instructions: String,
    pub media: RecipeMedia,
}

pub const CREATE: Mutation<CreateArgs, String> = Mutation::new("enhanceRecipes:create");

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateArgs {
    pub id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub instructions: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub media: Option<RecipeMedia>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub is_default: Option<bool>,
    /// `Some("")` clears it: the recipe follows the global model again.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model_id: Option<String>,
}

pub const UPDATE: Mutation<UpdateArgs, ()> = Mutation::new("enhanceRecipes:update");

#[derive(Clone, Debug, Serialize)]
pub struct RemoveArgs {
    pub id: String,
}

pub const REMOVE: Mutation<RemoveArgs, ()> = Mutation::new("enhanceRecipes:remove");

#[derive(Clone, Debug, Deserialize)]
pub struct Restored {
    pub added: f64,
}

/// Re-adds any built-in recipe that was deleted.
pub const RESTORE_BUILTINS: Mutation<NoArgs, Restored> =
    Mutation::new("enhanceRecipes:restoreBuiltins");
