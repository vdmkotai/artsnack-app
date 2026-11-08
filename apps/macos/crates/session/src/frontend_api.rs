//! A minimal client for Clerk's Frontend API in native mode.
//!
//! There is no Rust Clerk SDK for clients; this speaks the documented HTTP API
//! (`clerk/openapi-specs`, fapi/2026-08-20) the way Clerk's own iOS and Expo
//! SDKs do:
//!
//! - every request carries `_is_native=1` and the client token in
//!   `Authorization` (empty on the very first request);
//! - every response may rotate that token in its own `Authorization` header,
//!   which is stored verbatim — an empty value or a bare `Bearer` clears it —
//!   unless the token was replaced or cleared locally while the request was out
//!   (a sign-out): a late answer never brings an old credential back;
//! - no `Origin` header, ever: FAPI rejects a request with both.
//!
//! The client token is the long-lived credential (kept in the Keychain by the
//! caller). Session JWTs minted from it live about a minute.

use std::time::Duration;

use futures::channel::mpsc::UnboundedSender;
use parking_lot::Mutex;
use reqwest::{Method, RequestBuilder, StatusCode, header::AUTHORIZATION};
use serde::{Deserialize, de::DeserializeOwned};
use url::Url;

/// The FAPI version Clerk's iOS SDK pins; response shapes below follow it.
const API_VERSION: &str = "2026-08-20";
const REQUEST_TIMEOUT: Duration = Duration::from_secs(20);

#[derive(Debug, thiserror::Error)]
pub enum FrontendApiError {
    #[error("Clerk: {message} ({code})")]
    Clerk {
        status: StatusCode,
        code: String,
        message: String,
    },
    #[error("Clerk answered HTTP {0} with no error details")]
    Status(StatusCode),
    #[error("could not reach Clerk: {0}")]
    Network(#[from] reqwest::Error),
}

impl FrontendApiError {
    /// The Clerk error code, e.g. `session_exists`, `ticket_expired_code`.
    pub fn code(&self) -> Option<&str> {
        match self {
            Self::Clerk { code, .. } => Some(code),
            _ => None,
        }
    }

    /// True when the client token itself is no longer accepted, so the user
    /// must sign in again rather than retry.
    pub fn is_unauthorized(&self) -> bool {
        match self {
            Self::Clerk { status, .. } | Self::Status(status) => {
                *status == StatusCode::UNAUTHORIZED || *status == StatusCode::FORBIDDEN
            }
            Self::Network(_) => false,
        }
    }

    /// Worth retrying: the network failed, Clerk was busy, or the server erred.
    pub fn is_transient(&self) -> bool {
        match self {
            Self::Network(error) => error.is_timeout() || error.is_connect() || error.is_request(),
            Self::Clerk { status, .. } | Self::Status(status) => {
                status.is_server_error()
                    || *status == StatusCode::TOO_MANY_REQUESTS
                    || *status == StatusCode::REQUEST_TIMEOUT
            }
        }
    }
}

#[derive(Deserialize)]
struct ErrorBody {
    #[serde(default)]
    errors: Vec<ErrorItem>,
}

#[derive(Deserialize)]
struct ErrorItem {
    #[serde(default)]
    code: String,
    #[serde(default)]
    message: String,
    #[serde(default)]
    long_message: String,
}

/// `{ response, client }`: most endpoints return the object they acted on plus
/// the whole client as it now stands.
#[derive(Debug, Deserialize)]
pub struct Wrapped<T> {
    pub response: Option<T>,
    pub client: Option<Client>,
}

#[derive(Clone, Debug, Deserialize)]
pub struct Client {
    pub id: String,
    #[serde(default)]
    pub sessions: Vec<Session>,
    pub last_active_session_id: Option<String>,
}

impl Client {
    /// The session to use: the last active one if it is still active,
    /// otherwise any active session.
    pub fn active_session(&self) -> Option<&Session> {
        let active = |session: &&Session| session.status == "active";
        self.last_active_session_id
            .as_deref()
            .and_then(|id| self.sessions.iter().find(|s| s.id == id))
            .filter(active)
            .or_else(|| self.sessions.iter().find(active))
    }
}

#[derive(Clone, Debug, Deserialize)]
pub struct Session {
    pub id: String,
    pub status: String,
    pub user: Option<User>,
}

#[derive(Clone, Debug, Deserialize)]
pub struct User {
    pub id: String,
    pub first_name: Option<String>,
    pub last_name: Option<String>,
    pub username: Option<String>,
    pub image_url: Option<String>,
    pub primary_email_address_id: Option<String>,
    #[serde(default)]
    pub email_addresses: Vec<EmailAddress>,
}

impl User {
    pub fn primary_email(&self) -> Option<&str> {
        let primary = self.primary_email_address_id.as_deref();
        self.email_addresses
            .iter()
            .find(|email| Some(email.id.as_str()) == primary)
            .or_else(|| self.email_addresses.first())
            .map(|email| email.email_address.as_str())
    }

    pub fn display_name(&self) -> String {
        let full = [self.first_name.as_deref(), self.last_name.as_deref()]
            .into_iter()
            .flatten()
            .filter(|part| !part.is_empty())
            .collect::<Vec<_>>()
            .join(" ");
        if !full.is_empty() {
            return full;
        }
        self.username
            .clone()
            .or_else(|| self.primary_email().map(str::to_string))
            .unwrap_or_else(|| self.id.clone())
    }
}

#[derive(Clone, Debug, Deserialize)]
pub struct EmailAddress {
    pub id: String,
    pub email_address: String,
}

#[derive(Debug, Deserialize)]
pub struct SignIn {
    pub status: String,
    pub created_session_id: Option<String>,
}

#[derive(Debug, Deserialize)]
struct TokenBody {
    jwt: String,
}

/// The client token, and how many times it was set or cleared locally.
struct Credential {
    generation: u64,
    token: Option<String>,
}

/// One FAPI client: a base URL and the current client token.
pub struct FrontendApi {
    base: Url,
    http: reqwest::Client,
    credential: Mutex<Credential>,
    /// Told about every rotation, so the owner can persist the new token even
    /// when it arrived on a background token refresh.
    rotations: Mutex<Option<UnboundedSender<Option<String>>>>,
}

impl FrontendApi {
    /// `base` is the instance's Frontend API origin, e.g. `https://clerk.example.com`.
    pub fn new(base: Url, client_token: Option<String>) -> anyhow::Result<Self> {
        let http = reqwest::Client::builder()
            .timeout(REQUEST_TIMEOUT)
            .user_agent(concat!("ArtSnack-macOS/", env!("CARGO_PKG_VERSION")))
            .build()?;
        Ok(Self {
            base,
            http,
            credential: Mutex::new(Credential {
                generation: 0,
                token: client_token,
            }),
            rotations: Mutex::new(None),
        })
    }

    /// Sends every change of the client token (`None` when Clerk cleared it).
    pub fn set_rotation_listener(&self, listener: UnboundedSender<Option<String>>) {
        *self.rotations.lock() = Some(listener);
    }

    pub fn base(&self) -> &Url {
        &self.base
    }

    /// The current client token, to persist after a request rotated it.
    pub fn client_token(&self) -> Option<String> {
        self.credential.lock().token.clone()
    }

    /// Forgets the client token. Responses to requests sent before this can
    /// no longer rotate it back in.
    pub fn clear_client_token(&self) {
        self.set_client_token(None);
    }

    /// Replaces the client token. Responses to requests sent before this can
    /// no longer rotate it.
    pub fn set_client_token(&self, token: Option<String>) {
        let mut credential = self.credential.lock();
        credential.generation += 1;
        credential.token = token;
    }

    /// `GET /v1/client`: the client this token identifies, if any.
    pub async fn client(&self) -> Result<Option<Client>, FrontendApiError> {
        let wrapped: Wrapped<Client> = self.send(Method::GET, "/v1/client", None).await?;
        Ok(wrapped.response.or(wrapped.client))
    }

    /// `POST /v1/client`: creates a client when there is no token yet.
    pub async fn create_client(&self) -> Result<Option<Client>, FrontendApiError> {
        let wrapped: Wrapped<Client> = self.send(Method::POST, "/v1/client", Some(&[])).await?;
        Ok(wrapped.response.or(wrapped.client))
    }

    /// `POST /v1/client/sign_ins` with the ticket strategy: redeems a sign-in
    /// token minted by the backend (our `/desktop/handoff` page).
    pub async fn sign_in_with_ticket(
        &self,
        ticket: &str,
    ) -> Result<Wrapped<SignIn>, FrontendApiError> {
        self.send(
            Method::POST,
            "/v1/client/sign_ins",
            Some(&[("strategy", "ticket"), ("ticket", ticket)]),
        )
        .await
    }

    /// `POST /v1/client/sessions/{id}/tokens[/{template}]`: a fresh session JWT.
    pub async fn session_token(
        &self,
        session_id: &str,
        template: Option<&str>,
    ) -> Result<String, FrontendApiError> {
        let path = match template {
            Some(template) => format!("/v1/client/sessions/{session_id}/tokens/{template}"),
            None => format!("/v1/client/sessions/{session_id}/tokens"),
        };
        let body: TokenBody = self.send(Method::POST, &path, Some(&[])).await?;
        Ok(body.jwt)
    }

    /// `POST /v1/client/sessions/{id}/remove`: signs this session out.
    pub async fn remove_session(&self, session_id: &str) -> Result<(), FrontendApiError> {
        let path = format!("/v1/client/sessions/{session_id}/remove");
        let _: serde_json::Value = self.send(Method::POST, &path, Some(&[])).await?;
        Ok(())
    }

    /// [`Self::remove_session`] as the client `client_token` identifies,
    /// whatever the shared token is now: sign-out clears that at once, while
    /// this request is still on its way. Rotations in the answer are ignored.
    pub async fn remove_session_as(
        &self,
        client_token: &str,
        session_id: &str,
    ) -> Result<(), FrontendApiError> {
        let path = format!("/v1/client/sessions/{session_id}/remove");
        let _: serde_json::Value = self
            .request(Method::POST, &path, Some(&[]), client_token, None)
            .await?;
        Ok(())
    }

    /// `DELETE /v1/client/sessions`: removes every session but keeps the client,
    /// which a ticket sign-in needs when a stale one is still around
    /// (`session_exists`).
    pub async fn remove_all_sessions(&self) -> Result<(), FrontendApiError> {
        let _: serde_json::Value = self
            .send(Method::DELETE, "/v1/client/sessions", None)
            .await?;
        Ok(())
    }

    /// Sends with the shared client token and takes any rotation it answers
    /// with, if the token was not replaced locally in the meantime.
    async fn send<T: DeserializeOwned>(
        &self,
        method: Method,
        path: &str,
        form: Option<&[(&str, &str)]>,
    ) -> Result<T, FrontendApiError> {
        let (generation, token) = {
            let credential = self.credential.lock();
            (credential.generation, credential.token.clone())
        };
        self.request(
            method,
            path,
            form,
            token.as_deref().unwrap_or_default(),
            Some(generation),
        )
        .await
    }

    /// Sends with `token`; `rotate` is the credential generation the request
    /// belongs to, or `None` to ignore a rotated token in the answer.
    async fn request<T: DeserializeOwned>(
        &self,
        method: Method,
        path: &str,
        form: Option<&[(&str, &str)]>,
        token: &str,
        rotate: Option<u64>,
    ) -> Result<T, FrontendApiError> {
        let mut url = self.base.clone();
        url.set_path(path);
        url.query_pairs_mut().append_pair("_is_native", "1");

        let mut request: RequestBuilder = self
            .http
            .request(method, url)
            .header(AUTHORIZATION, token)
            .header("Clerk-API-Version", API_VERSION);
        if let Some(form) = form {
            request = request.form(form);
        }

        let response = request.send().await?;
        if let Some(generation) = rotate {
            self.store_rotated_token(generation, response.headers().get(AUTHORIZATION));
        }

        let status = response.status();
        let bytes = response.bytes().await?;
        if status.is_success() {
            return serde_json::from_slice(&bytes).map_err(|error| FrontendApiError::Clerk {
                status,
                code: "unexpected_response".into(),
                message: format!("unreadable response from Clerk: {error}"),
            });
        }
        let error = serde_json::from_slice::<ErrorBody>(&bytes)
            .ok()
            .and_then(|body| body.errors.into_iter().next());
        Err(match error {
            Some(item) => FrontendApiError::Clerk {
                status,
                message: if item.long_message.is_empty() {
                    item.message
                } else {
                    item.long_message
                },
                code: item.code,
            },
            None => FrontendApiError::Status(status),
        })
    }

    fn store_rotated_token(&self, generation: u64, header: Option<&reqwest::header::HeaderValue>) {
        let Some(value) = header.and_then(|value| value.to_str().ok()) else {
            return;
        };
        let value = value.trim();
        let next = if value.is_empty() || value.eq_ignore_ascii_case("bearer") {
            None
        } else {
            Some(value.to_string())
        };
        let mut credential = self.credential.lock();
        // Signed out, or signed in again, while this request was out.
        if credential.generation != generation || credential.token == next {
            return;
        }
        credential.token = next.clone();
        drop(credential);
        if let Some(listener) = self.rotations.lock().as_ref() {
            let _ = listener.unbounded_send(next);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn session(id: &str, status: &str) -> Session {
        Session {
            id: id.into(),
            status: status.into(),
            user: None,
        }
    }

    #[test]
    fn prefers_the_last_active_session_when_it_is_still_active() {
        let client = Client {
            id: "client".into(),
            sessions: vec![session("a", "active"), session("b", "active")],
            last_active_session_id: Some("b".into()),
        };
        assert_eq!(client.active_session().map(|s| s.id.as_str()), Some("b"));
    }

    #[test]
    fn falls_back_to_any_active_session() {
        let client = Client {
            id: "client".into(),
            sessions: vec![session("a", "active"), session("b", "ended")],
            last_active_session_id: Some("b".into()),
        };
        assert_eq!(client.active_session().map(|s| s.id.as_str()), Some("a"));
    }

    #[test]
    fn a_late_rotation_cannot_restore_a_cleared_token() {
        let api = FrontendApi::new(Url::parse("https://clerk.example.com").unwrap(), None)
            .expect("a client builds");
        api.set_client_token(Some("first".into()));
        let before_sign_out = api.credential.lock().generation;
        api.clear_client_token();
        let rotated = reqwest::header::HeaderValue::from_static("rotated");
        api.store_rotated_token(before_sign_out, Some(&rotated));
        assert_eq!(api.client_token(), None);

        let current = api.credential.lock().generation;
        api.store_rotated_token(current, Some(&rotated));
        assert_eq!(api.client_token().as_deref(), Some("rotated"));
    }

    #[test]
    fn no_active_session_means_signed_out() {
        let client = Client {
            id: "client".into(),
            sessions: vec![session("a", "revoked")],
            last_active_session_id: None,
        };
        assert!(client.active_session().is_none());
    }
}
