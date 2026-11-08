//! `packages/backend/convex/selfHostedSelection.ts`: choosing which ready
//! backend new self-hosted generations use. The `current` query is declared
//! with the status button's types as [`super::runpod_backends::SELECTION`].

use serde::Serialize;

use crate::{Mutation, api::runpod_backends::Provider};

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct SetArgs {
    pub provider: Provider,
}

/// Fails unless the provider's image backend is ready.
pub const SET: Mutation<SetArgs, Provider> = Mutation::new("selfHostedSelection:set");
