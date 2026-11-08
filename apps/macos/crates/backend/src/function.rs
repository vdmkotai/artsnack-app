//! Typed handles for Convex functions.
//!
//! convex-rs speaks in function paths and loose values. Each function the app
//! calls is declared once as a constant with its argument and result types, so
//! a call site cannot pass the wrong shape or misread the result:
//!
//! ```ignore
//! pub const LIST_FOLDERS: Query<NoArgs, Vec<Folder>> = Query::new("favoriteFolders:list");
//! ```
//!
//! The backend has no `returns:` validators, so result types are written by
//! hand from the function source; unknown fields are ignored, which also keeps
//! bookkeeping fields (leases, progress stamps) out of row equality.

use std::{collections::BTreeMap, marker::PhantomData};

use serde::{Serialize, de::DeserializeOwned};

use crate::error::CallError;

/// A query: subscribe to it, or read it once.
pub struct Query<Args, Output> {
    path: &'static str,
    _types: PhantomData<fn(Args) -> Output>,
}

/// A mutation: a transactional write.
pub struct Mutation<Args, Output> {
    path: &'static str,
    _types: PhantomData<fn(Args) -> Output>,
}

/// An action: may call third-party services and spend money; never retried.
pub struct Action<Args, Output> {
    path: &'static str,
    _types: PhantomData<fn(Args) -> Output>,
}

macro_rules! function_kind {
    ($kind:ident) => {
        impl<Args, Output> $kind<Args, Output> {
            /// `path` is `module:function`, e.g. `favorites:listFavorites`.
            pub const fn new(path: &'static str) -> Self {
                Self {
                    path,
                    _types: PhantomData,
                }
            }

            pub fn path(&self) -> &'static str {
                self.path
            }
        }

        impl<Args, Output> Clone for $kind<Args, Output> {
            fn clone(&self) -> Self {
                *self
            }
        }

        impl<Args, Output> Copy for $kind<Args, Output> {}
    };
}

function_kind!(Query);
function_kind!(Mutation);
function_kind!(Action);

/// Arguments for functions that take none.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize)]
pub struct NoArgs {}

/// Serializes arguments into the form convex-rs sends: a map of Convex values.
pub(crate) fn encode_args<Args: Serialize>(
    args: &Args,
) -> Result<BTreeMap<String, convex::Value>, CallError> {
    let json = serde_json::to_value(args).map_err(|error| CallError::Encode(error.to_string()))?;
    let json = match json {
        serde_json::Value::Object(_) => json,
        serde_json::Value::Null => serde_json::Value::Object(Default::default()),
        other => {
            return Err(CallError::Encode(format!(
                "arguments must serialize to an object, got {other}"
            )));
        }
    };
    match convex::Value::try_from(json).map_err(|error| CallError::Encode(error.to_string()))? {
        convex::Value::Object(map) => Ok(map),
        _ => unreachable!("an object stays an object"),
    }
}

/// The JSON form of arguments, used as part of a query's identity.
pub(crate) fn args_key<Args: Serialize>(args: &Args) -> String {
    serde_json::to_string(args).unwrap_or_default()
}

/// Decodes a function result into its declared type.
pub(crate) fn decode<Output: DeserializeOwned>(
    value: serde_json::Value,
) -> Result<Output, CallError> {
    serde_json::from_value(value).map_err(|error| CallError::Decode(error.to_string()))
}
