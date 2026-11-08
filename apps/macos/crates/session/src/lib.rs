//! Who is signed in, and the token Convex authenticates with.
//!
//! - [`frontend_api`]: Clerk's Frontend API in native mode (no Rust SDK exists).
//! - [`handoff`]: the browser round trip that gets a sign-in ticket.
//! - [`tokens`]: the `Send + Sync` Convex token source with Clerk's retry policy.
//! - [`Session`]: the GPUI entity screens observe.

pub mod frontend_api;
pub mod handoff;
pub mod jwt;
mod session;
mod sign_in_view;
pub mod tokens;

pub use session::{Account, Session, SessionConfig, SessionEvent, SessionStatus, init};
pub use sign_in_view::SignInView;
pub use tokens::{ConvexTokens, TokenError};
