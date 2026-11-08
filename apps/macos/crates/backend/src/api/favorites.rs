//! `packages/backend/convex/favorites.ts` and `favoriteFolders.ts`.

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::{Mutation, NoArgs, PaginatedQuery, Query, Row};

/// Where a favourite came from (`FavoriteProvider` in favorites.ts).
pub mod provider {
    pub const SELF_HOSTED: &str = "self-hosted";
    pub const GROK: &str = "grok";
    pub const FAL: &str = "fal";
    pub const HIGGSFIELD: &str = "higgsfield";
    pub const ATLAS: &str = "atlas";
    pub const ENHANCE: &str = "enhance";

    /// The chip and badge label (`FAVORITE_PROVIDER_LABELS`).
    pub fn label(provider: &str) -> &str {
        match provider {
            SELF_HOSTED => "Self-hosted",
            GROK => "Grok",
            FAL => "fal",
            HIGGSFIELD => "Higgsfield",
            ATLAS => "Atlas",
            ENHANCE => "Enhanced",
            other => other,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MediaType {
    Image,
    Video,
}

/// One enriched row of `listFavorites` (`EnrichedFavorite`).
#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Favorite {
    #[serde(rename = "_id")]
    pub id: String,
    pub b2_key: String,
    pub created_at: f64,
    pub folder_id: Option<String>,
    pub media_type: MediaType,
    /// `"W:H"` when the source recorded it.
    pub aspect_ratio: Option<String>,
    pub prompt: Option<String>,
    pub provider: String,
    pub checkpoint: Option<String>,
    /// The self-hosted form, for Reproduce. Shape: `formStateValidator`.
    pub form_state: Option<Value>,
    pub generation_id: Option<String>,
    pub api_generation_id: Option<String>,
    pub enhancement_id: Option<String>,
}

impl Row for Favorite {
    fn row_id(&self) -> &str {
        &self.id
    }
}

/// Which favourites to list. `folder_id`: `None` for all, `Some("none")` for
/// unfiled, else a folder id.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FavoriteFilter {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub folder_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub media_type: Option<MediaType>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub providers: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub checkpoints: Vec<String>,
}

impl FavoriteFilter {
    pub const UNFILED: &'static str = "none";

    /// True when any column filter (not the folder) is set.
    pub fn has_column_filters(&self) -> bool {
        self.media_type.is_some() || !self.providers.is_empty() || !self.checkpoints.is_empty()
    }

    /// The predicate the server applies (`packages/shared/favorite-filters.ts`),
    /// so rows already held can be narrowed in the same frame a chip is clicked.
    pub fn matches(&self, favorite: &Favorite) -> bool {
        let in_folder = match self.folder_id.as_deref() {
            None => true,
            Some(Self::UNFILED) => favorite.folder_id.is_none(),
            Some(folder) => favorite.folder_id.as_deref() == Some(folder),
        };
        if !in_folder {
            return false;
        }
        if let Some(media_type) = self.media_type
            && favorite.media_type != media_type
        {
            return false;
        }
        if !self.providers.is_empty() && !self.providers.contains(&favorite.provider) {
            return false;
        }
        if !self.checkpoints.is_empty() {
            match &favorite.checkpoint {
                Some(checkpoint) if self.checkpoints.contains(checkpoint) => {}
                _ => return false,
            }
        }
        true
    }
}

pub const LIST_FAVORITES: PaginatedQuery<FavoriteFilter, Favorite> =
    PaginatedQuery::new("favorites:listFavorites");

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FacetsArgs {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub folder_id: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct Facet {
    pub value: String,
    pub count: f64,
}

#[derive(Clone, Debug, Default, PartialEq, Deserialize)]
pub struct MediaTypeCounts {
    pub image: f64,
    pub video: f64,
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Facets {
    pub total: f64,
    pub media_types: MediaTypeCounts,
    pub providers: Vec<Facet>,
    pub checkpoints: Vec<Facet>,
}

pub const FACETS: Query<FacetsArgs, Facets> = Query::new("favorites:facets");

/// Every favourited B2 key (newest 5000), for hearts on every grid.
pub const MY_KEYS: Query<NoArgs, Vec<String>> = Query::new("favorites:myKeys");

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToggleArgs {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub generation_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub api_generation_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub enhancement_id: Option<String>,
    pub b2_key: String,
}

#[derive(Clone, Debug, Deserialize)]
pub struct ToggleResult {
    pub favorited: bool,
}

pub const TOGGLE: Mutation<ToggleArgs, ToggleResult> = Mutation::new("favorites:toggle");

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoveByKeyArgs {
    pub b2_key: String,
}

/// Removes, never inserts — for "Remove" buttons, where a toggle on a row that
/// is already gone would re-create it.
pub const REMOVE_BY_KEY: Mutation<RemoveByKeyArgs, ()> = Mutation::new("favorites:removeByKey");

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoveManyArgs {
    pub favorite_ids: Vec<String>,
}

pub const REMOVE_MANY: Mutation<RemoveManyArgs, ()> = Mutation::new("favorites:removeMany");

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MoveToFolderArgs {
    pub favorite_ids: Vec<String>,
    /// `None` moves them back to unfiled.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub folder_id: Option<String>,
}

pub const MOVE_TO_FOLDER: Mutation<MoveToFolderArgs, ()> = Mutation::new("favorites:moveToFolder");

// --- favoriteFolders.ts -----------------------------------------------------

#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Folder {
    #[serde(rename = "_id")]
    pub id: String,
    pub name: String,
    pub created_at: f64,
    pub count: f64,
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct Folders {
    pub folders: Vec<Folder>,
    pub unfiled: f64,
    pub total: f64,
}

pub const LIST_FOLDERS: Query<NoArgs, Folders> = Query::new("favoriteFolders:list");

#[derive(Clone, Debug, Serialize)]
pub struct CreateFolderArgs {
    pub name: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreatedFolder {
    pub folder_id: String,
}

/// Idempotent by name: creating an existing name returns that folder.
pub const CREATE_FOLDER: Mutation<CreateFolderArgs, CreatedFolder> =
    Mutation::new("favoriteFolders:create");

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RenameFolderArgs {
    pub folder_id: String,
    pub name: String,
}

pub const RENAME_FOLDER: Mutation<RenameFolderArgs, ()> = Mutation::new("favoriteFolders:rename");

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoveFolderArgs {
    pub folder_id: String,
}

/// Deletes the folder; its favourites go back to unfiled.
pub const REMOVE_FOLDER: Mutation<RemoveFolderArgs, ()> = Mutation::new("favoriteFolders:remove");

/// `shortCheckpointName`: no directory, no weights extension.
pub fn short_checkpoint_name(name: &str) -> &str {
    let base = name.rsplit('/').next().unwrap_or(name);
    for extension in [".safetensors", ".ckpt", ".pt"] {
        // `get` rather than slicing: the cut can fall inside a multi-byte
        // character of a name like `猫模型.ckpt`.
        let stem = base
            .len()
            .checked_sub(extension.len())
            .filter(|cut| *cut > 0)
            .and_then(|cut| Some((base.get(..cut)?, base.get(cut..)?)));
        if let Some((stem, suffix)) = stem
            && suffix.eq_ignore_ascii_case(extension)
        {
            return stem;
        }
    }
    base
}

#[cfg(test)]
mod tests {
    use super::*;

    fn favorite(
        folder: Option<&str>,
        media: MediaType,
        provider: &str,
        checkpoint: Option<&str>,
    ) -> Favorite {
        Favorite {
            id: "f".into(),
            b2_key: "k".into(),
            created_at: 0.0,
            folder_id: folder.map(Into::into),
            media_type: media,
            aspect_ratio: None,
            prompt: None,
            provider: provider.into(),
            checkpoint: checkpoint.map(Into::into),
            form_state: None,
            generation_id: None,
            api_generation_id: None,
            enhancement_id: None,
        }
    }

    #[test]
    fn filters_match_the_shared_predicate() {
        let row = favorite(
            Some("f1"),
            MediaType::Image,
            "self-hosted",
            Some("a.safetensors"),
        );
        let unfiled = favorite(None, MediaType::Video, "grok", None);
        let all = FavoriteFilter::default();
        assert!(all.matches(&row) && all.matches(&unfiled));

        let only_unfiled = FavoriteFilter {
            folder_id: Some("none".into()),
            ..Default::default()
        };
        assert!(!only_unfiled.matches(&row) && only_unfiled.matches(&unfiled));

        let checkpoint = FavoriteFilter {
            checkpoints: vec!["a.safetensors".into()],
            ..Default::default()
        };
        assert!(checkpoint.matches(&row));
        assert!(
            !checkpoint.matches(&unfiled),
            "rows without a checkpoint are excluded"
        );

        let videos = FavoriteFilter {
            media_type: Some(MediaType::Video),
            providers: vec!["grok".into()],
            ..Default::default()
        };
        assert!(videos.matches(&unfiled) && !videos.matches(&row));
    }

    #[test]
    fn shortens_checkpoint_names() {
        assert_eq!(
            short_checkpoint_name("SDXL/juggernaut_v9.safetensors"),
            "juggernaut_v9"
        );
        assert_eq!(short_checkpoint_name("model.CKPT"), "model");
        assert_eq!(short_checkpoint_name("plain"), "plain");
        assert_eq!(short_checkpoint_name(".ckpt"), ".ckpt");
    }

    #[test]
    fn shortens_names_with_multi_byte_characters() {
        assert_eq!(short_checkpoint_name("猫模型.ckpt"), "猫模型");
        assert_eq!(short_checkpoint_name("SDXL/猫.safetensors"), "猫");
        assert_eq!(short_checkpoint_name("模型"), "模型");
        assert_eq!(short_checkpoint_name("ü.pt"), "ü");
    }

    #[test]
    fn filter_arguments_serialize_like_the_web() {
        let filter = FavoriteFilter {
            folder_id: Some("none".into()),
            media_type: Some(MediaType::Image),
            ..Default::default()
        };
        assert_eq!(
            serde_json::to_string(&filter).unwrap(),
            r#"{"folderId":"none","mediaType":"image"}"#
        );
    }
}
