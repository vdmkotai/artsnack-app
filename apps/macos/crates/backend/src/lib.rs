//! The Convex client layer.
//!
//! - [`Backend`]: the one connection, its auth and status; one-shot queries,
//!   mutations and actions.
//! - [`LiveQuery`]: a subscription as an entity views observe.
//! - [`LivePaginatedQuery`]: the native `usePaginatedQuery`.
//! - [`QuerySnapshots`]: the last result of each query, for instant revisits.
//! - [`api`]: every Convex function the app calls, typed.

pub mod api;
mod connection;
mod error;
mod feed;
mod function;
mod live_query;
mod paginated;
mod rows;
mod snapshots;

pub use connection::{Backend, BackendEvent, ConnectionStatus, TokenSource, init};
pub use error::CallError;
pub use function::{Action, Mutation, NoArgs, Query};
pub use live_query::{LiveQuery, QueryState};
pub use paginated::{LivePaginatedQuery, Page, PaginatedQuery, PaginationStatus};
pub use rows::{Row, RowCache};
pub use snapshots::QuerySnapshots;
