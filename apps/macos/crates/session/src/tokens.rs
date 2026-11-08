//! The token Convex authenticates with: a Clerk session JWT whose audience is
//! `convex`, about a minute long.
//!
//! This half of the session is `Send + Sync` and lives on the I/O runtime, so
//! convex-rs can call it from its own worker when it reconnects. It mirrors the
//! web's `apps/web/lib/convex-token.ts`: one request in flight, retried through
//! transient failures for up to 45 s, each attempt cut at 20 s, backoff from
//! 0.5 s to 8 s — a refresh that lands on a laptop waking from sleep must not
//! leave the app anonymous.
//!
//! - **Freshness survives sleep.** A token is fresh for its own lifetime
//!   (`exp - iat`, so the Mac's clock skew does not matter) minus a margin,
//!   counted from when it was *requested*, on two clocks: the monotonic one
//!   (immune to the wall clock being set) and the wall clock — on macOS the
//!   monotonic clock stops while the Mac sleeps, the wall clock does not. A
//!   token is used only while both say it is fresh, so after waking it is not.
//! - **Bound to its session.** Every session change starts a new generation. A
//!   refresh that was out when the session changed neither caches its token
//!   nor reports its session as ended: it starts over for the new session.

use std::{
    sync::Arc,
    time::{Duration, Instant, SystemTime},
};

use futures::channel::mpsc::UnboundedSender;
use parking_lot::Mutex;

use crate::{frontend_api::FrontendApi, jwt};

pub const CONVEX_AUDIENCE: &str = "convex";
const CONVEX_TEMPLATE: &str = "convex";

const RETRY_DEADLINE: Duration = Duration::from_secs(45);
const ATTEMPT_TIMEOUT: Duration = Duration::from_secs(20);
const MAX_RETRY_DELAY: Duration = Duration::from_secs(8);
/// Refresh this long before the token would expire.
const REFRESH_MARGIN: Duration = Duration::from_secs(15);
/// Used when a token carries no readable lifetime.
const FALLBACK_LIFETIME: Duration = Duration::from_secs(60);

/// A point in time on both clocks.
#[derive(Clone, Copy, Debug)]
struct Moment {
    monotonic: Instant,
    wall: SystemTime,
}

impl Moment {
    fn now() -> Self {
        Self {
            monotonic: Instant::now(),
            wall: SystemTime::now(),
        }
    }

    fn after(self, duration: Duration) -> Self {
        Self {
            monotonic: self.monotonic + duration,
            wall: self.wall + duration,
        }
    }

    /// How long until `self`, by whichever clock says it is sooner.
    fn remaining_from(self, now: Moment) -> Duration {
        let monotonic = self.monotonic.saturating_duration_since(now.monotonic);
        let wall = self.wall.duration_since(now.wall).unwrap_or_default();
        monotonic.min(wall)
    }
}

#[derive(Clone)]
struct Cached {
    jwt: String,
    refresh_at: Moment,
}

impl Cached {
    /// `requested` is when the request for `jwt` went out: the token was
    /// minted after that, so it lives at least its lifetime from then.
    fn new(jwt: String, requested: Moment) -> Self {
        let lifetime = jwt::claims(&jwt)
            .and_then(|claims| claims.lifetime_seconds())
            .map(|seconds| Duration::from_secs(seconds as u64))
            .unwrap_or(FALLBACK_LIFETIME);
        Self {
            refresh_at: requested.after(lifetime.saturating_sub(REFRESH_MARGIN)),
            jwt,
        }
    }

    fn fresh_for(&self, now: Moment) -> Duration {
        self.refresh_at.remaining_from(now)
    }
}

/// Why no token could be produced.
#[derive(Debug, thiserror::Error)]
pub enum TokenError {
    /// Nobody is signed in; Convex should run unauthenticated.
    #[error("not signed in")]
    SignedOut,
    /// Clerk no longer accepts this session: sign in again.
    #[error("the Clerk session has ended")]
    SessionEnded,
    /// Retries ran out (offline, Clerk down). Try again later.
    #[error("could not refresh the sign-in token: {0}")]
    Unavailable(String),
}

struct State {
    /// Bumped by every session change; work started under an older one is void.
    generation: u64,
    session_id: Option<String>,
    cached: Option<Cached>,
    /// How many tokens were fetched, so a caller that waited out another's
    /// refresh can tell it got a new one.
    fetched: u64,
}

impl State {
    fn fresh_jwt(&self, now: Moment) -> Option<String> {
        self.cached
            .as_ref()
            .filter(|cached| !cached.fresh_for(now).is_zero())
            .map(|cached| cached.jwt.clone())
    }
}

pub struct ConvexTokens {
    api: Arc<FrontendApi>,
    state: Mutex<State>,
    /// Serializes refreshes so concurrent callers share one request.
    refreshing: tokio::sync::Mutex<()>,
    /// Whether to mint from the `convex` JWT template. Starts false (Clerk's
    /// Convex integration sets `aud=convex` on the plain session token) and
    /// flips if the plain token turns out to carry another audience — the same
    /// test as Convex's own Clerk adapter.
    use_template: Mutex<bool>,
    /// Told the session id when Clerk says that session is over, so the owner
    /// can sign out.
    ended: Mutex<Option<UnboundedSender<String>>>,
}

impl ConvexTokens {
    pub fn new(api: Arc<FrontendApi>) -> Self {
        Self {
            api,
            state: Mutex::new(State {
                generation: 0,
                session_id: None,
                cached: None,
                fetched: 0,
            }),
            refreshing: tokio::sync::Mutex::new(()),
            use_template: Mutex::new(false),
            ended: Mutex::new(None),
        }
    }

    /// Receives the session id whenever a refresh finds that session ended.
    /// Only the current session is ever reported.
    pub fn set_ended_listener(&self, listener: UnboundedSender<String>) {
        *self.ended.lock() = Some(listener);
    }

    pub fn set_session(&self, session_id: Option<String>) {
        let mut state = self.state.lock();
        state.generation += 1;
        state.session_id = session_id;
        state.cached = None;
    }

    pub fn session_id(&self) -> Option<String> {
        self.state.lock().session_id.clone()
    }

    /// How much longer the current token stays fresh; `None` without one.
    pub fn fresh_for(&self) -> Option<Duration> {
        let now = Moment::now();
        self.state
            .lock()
            .cached
            .as_ref()
            .map(|cached| cached.fresh_for(now))
    }

    /// A token for Convex: the cached one while it is fresh, otherwise a new one.
    /// `force` skips the cache (Convex asks for that after an auth error), but
    /// a refresh that finished while this call waited for it counts as new.
    pub async fn token(&self, force: bool) -> Result<String, TokenError> {
        let seen = self.state.lock().fetched;
        if !force && let Some(jwt) = self.state.lock().fresh_jwt(Moment::now()) {
            return Ok(jwt);
        }
        let _guard = self.refreshing.lock().await;
        loop {
            let (generation, session_id) = {
                let state = self.state.lock();
                if (!force || state.fetched != seen)
                    && let Some(jwt) = state.fresh_jwt(Moment::now())
                {
                    return Ok(jwt);
                }
                (state.generation, state.session_id.clone())
            };
            let session_id = session_id.ok_or(TokenError::SignedOut)?;
            let requested = Moment::now();
            let outcome = self.fetch_with_retries(&session_id).await;

            let mut state = self.state.lock();
            if state.generation != generation {
                // Signed out or into another session while the request was
                // out: its token, or its "ended", belongs to nobody now.
                continue;
            }
            return match outcome {
                Ok(jwt) => {
                    state.cached = Some(Cached::new(jwt.clone(), requested));
                    state.fetched += 1;
                    Ok(jwt)
                }
                Err(TokenError::SessionEnded) => {
                    // Reported under the state lock, so it cannot race a
                    // session change.
                    if let Some(listener) = self.ended.lock().as_ref() {
                        let _ = listener.unbounded_send(session_id);
                    }
                    Err(TokenError::SessionEnded)
                }
                Err(error) => Err(error),
            };
        }
    }

    async fn fetch_with_retries(&self, session_id: &str) -> Result<String, TokenError> {
        let deadline = Instant::now() + RETRY_DEADLINE;
        let mut attempt = 0u32;
        loop {
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return Err(TokenError::Unavailable("timed out".into()));
            }
            let outcome =
                tokio::time::timeout(remaining.min(ATTEMPT_TIMEOUT), self.fetch(session_id)).await;
            let error = match outcome {
                Ok(Ok(jwt)) => return Ok(jwt),
                Ok(Err(error)) => error,
                Err(_) => TokenError::Unavailable("Clerk did not answer in time".into()),
            };
            if matches!(error, TokenError::SessionEnded | TokenError::SignedOut) {
                return Err(error);
            }
            let left = deadline.saturating_duration_since(Instant::now());
            if left.is_zero() {
                return Err(error);
            }
            tracing::debug!(%error, attempt, "retrying the Convex token");
            tokio::time::sleep(retry_delay(attempt).min(left)).await;
            attempt += 1;
        }
    }

    async fn fetch(&self, session_id: &str) -> Result<String, TokenError> {
        let use_template = *self.use_template.lock();
        let template = use_template.then_some(CONVEX_TEMPLATE);
        let jwt = self
            .api
            .session_token(session_id, template)
            .await
            .map_err(|error| {
                if error.is_unauthorized() {
                    TokenError::SessionEnded
                } else {
                    TokenError::Unavailable(error.to_string())
                }
            })?;
        if use_template {
            return Ok(jwt);
        }
        let is_for_convex =
            jwt::claims(&jwt).is_some_and(|claims| claims.has_audience(CONVEX_AUDIENCE));
        if is_for_convex {
            return Ok(jwt);
        }
        // The plain session token is not for Convex: use the template from now on.
        *self.use_template.lock() = true;
        self.api
            .session_token(session_id, Some(CONVEX_TEMPLATE))
            .await
            .map_err(|error| {
                if error.is_unauthorized() {
                    TokenError::SessionEnded
                } else {
                    TokenError::Unavailable(error.to_string())
                }
            })
    }
}

/// The delay before retry number `attempt` (0-based): 0.5 s doubling to 8 s.
fn retry_delay(attempt: u32) -> Duration {
    Duration::from_millis(500u64.saturating_mul(1u64 << attempt.min(5))).min(MAX_RETRY_DELAY)
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};

    fn jwt(lifetime: i64) -> String {
        let payload = format!(r#"{{"aud":"convex","iat":1000,"exp":{}}}"#, 1000 + lifetime);
        format!("e30.{}.sig", URL_SAFE_NO_PAD.encode(payload))
    }

    #[test]
    fn backoff_doubles_from_half_a_second_to_eight() {
        let delays: Vec<_> = (0..7).map(retry_delay).collect();
        assert_eq!(
            delays,
            [500, 1000, 2000, 4000, 8000, 8000, 8000].map(Duration::from_millis)
        );
    }

    #[test]
    fn freshness_counts_from_the_request_minus_the_margin() {
        let requested = Moment::now();
        let cached = Cached::new(jwt(60), requested);
        assert_eq!(cached.fresh_for(requested), Duration::from_secs(45));
    }

    #[test]
    fn a_token_is_stale_once_the_wall_clock_passes_it() {
        // The monotonic clock stood still (the Mac slept); the wall clock did not.
        let requested = Moment::now();
        let cached = Cached::new(jwt(60), requested);
        let woke = Moment {
            monotonic: requested.monotonic + Duration::from_secs(5),
            wall: requested.wall + Duration::from_secs(2 * 60 * 60),
        };
        assert!(cached.fresh_for(woke).is_zero());
    }

    #[test]
    fn a_token_is_stale_once_the_monotonic_clock_passes_it() {
        // The wall clock was set back; elapsed time still counts.
        let requested = Moment::now();
        let cached = Cached::new(jwt(60), requested);
        let later = Moment {
            monotonic: requested.monotonic + Duration::from_secs(50),
            wall: requested.wall,
        };
        assert!(cached.fresh_for(later).is_zero());
    }
}
