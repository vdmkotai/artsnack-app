//! `packages/backend/convex/atlas.ts`, `atlasFavorites.ts` and
//! `atlasBalance.ts`: Atlas Cloud jobs, starred models and the account balance.

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::{Action, Mutation, NoArgs, Query};

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StartArgs {
    /// Vendor slug, e.g. "alibaba/wan-2.5/image-to-video".
    pub model: String,
    pub prompt: String,
    pub params: Map<String, Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reference_storage_ids: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reference_source_keys: Option<Vec<Option<String>>>,
    /// Independent submissions of the same settings, each billed in full.
    pub jobs: f64,
}

/// Inserts the rows and schedules the jobs; returns the first row's id.
pub const START: Mutation<StartArgs, String> = Mutation::new("atlas:start");

/// Starred model ids.
pub const FAVORITES: Query<NoArgs, Vec<String>> = Query::new("atlasFavorites:list");

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToggleFavoriteArgs {
    pub model_id: String,
}

/// Returns whether the model is starred now.
pub const TOGGLE_FAVORITE: Mutation<ToggleFavoriteArgs, bool> =
    Mutation::new("atlasFavorites:toggle");

#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct AtlasBalance {
    pub available: Option<f64>,
    pub cash: Option<f64>,
    pub bonus: Option<f64>,
    /// Held by generations still running.
    pub frozen: Option<f64>,
    pub currency: String,
}

/// `None` when Atlas did not answer.
pub const BALANCE: Action<NoArgs, Option<AtlasBalance>> = Action::new("atlasBalance:get");
