//! `packages/backend/convex/featureFlags.ts`: per-account switches that hide
//! API providers from the switcher (`packages/shared/feature-flags.ts`).

use serde::{Deserialize, Serialize};

use crate::{Mutation, NoArgs, Query};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum FeatureFlag {
    Higgsfield,
    Fal,
}

impl FeatureFlag {
    pub const ALL: [Self; 2] = [Self::Higgsfield, Self::Fal];

    pub fn label(self) -> &'static str {
        match self {
            Self::Higgsfield => "Higgsfield",
            Self::Fal => "fal.ai",
        }
    }

    pub fn description(self) -> &'static str {
        match self {
            Self::Higgsfield => "Show the Higgsfield tab in the API provider switcher.",
            Self::Fal => {
                "Show the fal.ai tab (Seedream and Seedance) in the API provider switcher."
            }
        }
    }
}

/// Every flag defaults to on; the server fills the defaults in.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
pub struct FeatureFlags {
    pub higgsfield: bool,
    pub fal: bool,
}

impl FeatureFlags {
    pub fn get(&self, flag: FeatureFlag) -> bool {
        match flag {
            FeatureFlag::Higgsfield => self.higgsfield,
            FeatureFlag::Fal => self.fal,
        }
    }

    pub fn with(mut self, flag: FeatureFlag, enabled: bool) -> Self {
        match flag {
            FeatureFlag::Higgsfield => self.higgsfield = enabled,
            FeatureFlag::Fal => self.fal = enabled,
        }
        self
    }
}

/// The caller's flags, or null when signed out.
pub const MINE: Query<NoArgs, Option<FeatureFlags>> = Query::new("featureFlags:mine");

#[derive(Clone, Debug, Serialize)]
pub struct SetFlagArgs {
    pub key: FeatureFlag,
    pub enabled: bool,
}

pub const SET: Mutation<SetFlagArgs, ()> = Mutation::new("featureFlags:set");
