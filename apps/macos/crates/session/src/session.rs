//! The signed-in state of the app, as one GPUI entity.
//!
//! What persists is the Clerk *client* token plus the session id and a copy of
//! the account, all in one Keychain item. On launch the app trusts that copy at
//! once — so a cold start offline still opens on the user's own screens — and
//! checks it with Clerk in the background; only Clerk saying the session is gone
//! signs the user out.
//!
//! - **Sign-out wins.** It cancels the check or sign-in in flight, and every
//!   operation carries the generation it started under, so a late answer
//!   cannot sign anyone back in.
//! - **One Keychain writer.** Writes and deletions go through one queue, in
//!   the order they were asked for, so an old write can never land after a
//!   sign-out's deletion, or a late deletion remove a new sign-in.
//! - **Another user is another session.** When Clerk's session belongs to a
//!   different user than the remembered one, observers see `SignedOut` before
//!   the new `SignedIn`, and clear what they hold for the old user.

use std::{
    sync::Arc,
    time::{Duration, Instant},
};

use futures::{StreamExt as _, channel::mpsc};
use gpui_kit::{App, AppContext as _, Context, Entity, EventEmitter, Global, SharedString, Task};
use serde::{Deserialize, Serialize};
use url::Url;

use crate::{
    frontend_api::{Client, FrontendApi, FrontendApiError, User},
    handoff,
    tokens::ConvexTokens,
};

/// How long a started browser sign-in waits for its link; the ticket itself
/// lives two minutes, so anything later cannot succeed anyway.
const HANDOFF_WINDOW: Duration = Duration::from_secs(10 * 60);
const KEYCHAIN_USER: &str = "artsnack-native";
/// Waits between checks of a stored session that Clerk could not be asked
/// about, while nothing is on screen yet; then the user is asked to sign in.
const RESTORE_RETRY_DELAYS: [Duration; 3] = [
    Duration::from_secs(1),
    Duration::from_secs(3),
    Duration::from_secs(8),
];
/// No retry starts later than this after the first check: a request can hang
/// for its full 20 s, and the launch shows only a spinner meanwhile.
const RESTORE_PATIENCE: Duration = Duration::from_secs(20);
const SESSION_ENDED: &str = "Your session has ended. Sign in again.";
const RESTORE_FAILED: &str = "Could not reach Clerk to restore your session. Sign in again.";

/// Where the session talks to.
#[derive(Clone, Debug)]
pub struct SessionConfig {
    /// The Clerk Frontend API origin, e.g. `https://clerk.example.com`.
    pub frontend_api: Url,
    /// The web app that hosts `/desktop/handoff`, e.g. `https://artsnack.example.com`.
    pub web_app: Url,
}

/// The signed-in user, as far as the app needs to show it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Account {
    user_id: String,
    display_name: String,
    email: Option<String>,
    image_url: Option<String>,
}

impl Account {
    fn from_user(user: &User) -> Self {
        Self {
            user_id: user.id.clone(),
            display_name: user.display_name(),
            email: user.primary_email().map(str::to_string),
            image_url: user.image_url.clone(),
        }
    }

    pub fn user_id(&self) -> &str {
        &self.user_id
    }

    pub fn display_name(&self) -> SharedString {
        self.display_name.clone().into()
    }

    pub fn email(&self) -> Option<SharedString> {
        self.email.clone().map(Into::into)
    }

    pub fn image_url(&self) -> Option<SharedString> {
        self.image_url.clone().map(Into::into)
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum SessionStatus {
    /// Reading the Keychain at launch, or checking a stored client with Clerk.
    Restoring,
    SignedOut,
    /// The browser is open on the handoff page; waiting for its link.
    AwaitingBrowser,
    /// The link arrived; redeeming the ticket with Clerk.
    Completing,
    SignedIn(Account),
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum SessionEvent {
    /// Someone is signed in: on sign-in, and when the account's details
    /// change. A different user is always preceded by [`Self::SignedOut`].
    SignedIn(Account),
    SignedOut,
}

/// What is kept in the Keychain.
#[derive(Serialize, Deserialize)]
struct Stored {
    client_token: Option<String>,
    session_id: Option<String>,
    account: Option<Account>,
}

/// One change to the Keychain item; each replaces the whole item.
enum KeychainWrite {
    Store(Vec<u8>),
    Delete,
}

pub struct Session {
    config: SessionConfig,
    api: Arc<FrontendApi>,
    tokens: Arc<ConvexTokens>,
    status: SessionStatus,
    /// The last sign-in failure, shown on the sign-in screen.
    error: Option<SharedString>,
    pending_state: Option<(String, Instant)>,
    /// Bumped by every sign-in attempt, check and sign-out; an operation that
    /// finishes under an older value is ignored.
    generation: u64,
    operation: Option<Task<()>>,
    keychain: mpsc::UnboundedSender<KeychainWrite>,
    _keychain_writer: Task<()>,
    _persist_rotations: Task<()>,
    _session_ended: Task<()>,
}

impl EventEmitter<SessionEvent> for Session {}

struct GlobalSession(Entity<Session>);

impl Global for GlobalSession {}

/// Creates the session and starts restoring it from the Keychain.
pub fn init(config: SessionConfig, cx: &mut App) -> anyhow::Result<Entity<Session>> {
    let api = Arc::new(FrontendApi::new(config.frontend_api.clone(), None)?);
    let session = cx.new(|cx| Session::new(config, api, cx));
    cx.set_global(GlobalSession(session.clone()));
    session.update(cx, |session, cx| session.restore(cx));
    Ok(session)
}

impl Session {
    fn new(config: SessionConfig, api: Arc<FrontendApi>, cx: &mut Context<Self>) -> Self {
        let tokens = Arc::new(ConvexTokens::new(api.clone()));
        let (ended, mut session_ended) = mpsc::unbounded::<String>();
        tokens.set_ended_listener(ended);
        let session_ended = cx.spawn(async move |this, cx| {
            while let Some(ended_session) = session_ended.next().await {
                let handled = this.update(cx, |this, cx| {
                    // Only the session in use now; a report about one that was
                    // already replaced says nothing about this one.
                    let current = this.tokens.session_id();
                    if current.as_deref() == Some(ended_session.as_str())
                        && this.account().is_some()
                    {
                        this.end(Some(SESSION_ENDED.into()), cx);
                    }
                });
                if handled.is_err() {
                    break;
                }
            }
        });
        let (rotations, mut rotated) = mpsc::unbounded();
        api.set_rotation_listener(rotations);
        // A cleared token (`None`) deletes the item: `persist` follows the
        // token as it is now.
        let persist_rotations = cx.spawn(async move |this, cx| {
            while rotated.next().await.is_some() {
                if this.update(cx, |this, _| this.persist()).is_err() {
                    break;
                }
            }
        });
        let (keychain, writes) = mpsc::unbounded();
        let keychain_writer = keychain_writer(config.frontend_api.to_string(), writes, cx);
        Self {
            config,
            api,
            tokens,
            status: SessionStatus::Restoring,
            error: None,
            pending_state: None,
            generation: 0,
            operation: None,
            keychain,
            _keychain_writer: keychain_writer,
            _persist_rotations: persist_rotations,
            _session_ended: session_ended,
        }
    }

    pub fn global(cx: &App) -> Entity<Session> {
        cx.global::<GlobalSession>().0.clone()
    }

    pub fn status(&self) -> &SessionStatus {
        &self.status
    }

    pub fn account(&self) -> Option<&Account> {
        match &self.status {
            SessionStatus::SignedIn(account) => Some(account),
            _ => None,
        }
    }

    pub fn error(&self) -> Option<&SharedString> {
        self.error.as_ref()
    }

    /// The `Send + Sync` token source Convex authenticates through.
    pub fn convex_tokens(&self) -> Arc<ConvexTokens> {
        self.tokens.clone()
    }

    /// Opens the handoff page in the default browser and waits for its link.
    pub fn begin_sign_in(&mut self, cx: &mut Context<Self>) {
        let state = handoff::new_state();
        let url = handoff::handoff_url(&self.config.web_app, &state);
        self.pending_state = Some((state, Instant::now()));
        self.error = None;
        self.status = SessionStatus::AwaitingBrowser;
        cx.open_url(url.as_str());
        cx.notify();
    }

    /// Stops waiting for the browser.
    pub fn cancel_sign_in(&mut self, cx: &mut Context<Self>) {
        if self.status == SessionStatus::AwaitingBrowser {
            self.pending_state = None;
            self.status = SessionStatus::SignedOut;
            cx.notify();
        }
    }

    /// Handles URLs the system opened the app with. Only a sign-in link whose
    /// `state` is the one this app sent, within the handoff window, is used.
    pub fn handle_open_urls(&mut self, urls: &[String], cx: &mut Context<Self>) {
        for raw in urls {
            let Some(link) = handoff::parse_sign_in_link(raw) else {
                continue;
            };
            let expected = self
                .pending_state
                .as_ref()
                .filter(|(_, started)| started.elapsed() < HANDOFF_WINDOW)
                .map(|(state, _)| state.as_str());
            if expected != Some(link.state.as_str()) {
                tracing::warn!("ignored a sign-in link this app did not ask for");
                continue;
            }
            self.pending_state = None;
            self.redeem(link.ticket, cx);
            return;
        }
    }

    pub fn sign_out(&mut self, cx: &mut Context<Self>) {
        // Ending the session on Clerk's side is best effort: locally the user is
        // signed out either way. It runs under this client's own token, which
        // `end` clears from the shared client right away.
        if let (Some(client_token), Some(session_id)) =
            (self.api.client_token(), self.tokens.session_id())
        {
            let api = self.api.clone();
            artsnack_runtime::spawn(cx, async move {
                if let Err(error) = api.remove_session_as(&client_token, &session_id).await {
                    tracing::warn!(%error, "could not end the Clerk session");
                }
            })
            .detach();
        }
        self.pending_state = None;
        self.end(None, cx);
    }

    /// Signs out locally: cancels whatever was in flight, forgets the
    /// credentials and tells observers.
    fn end(&mut self, error: Option<SharedString>, cx: &mut Context<Self>) {
        self.operation = None;
        self.forget();
        self.set_signed_out(error, cx);
    }

    fn restore(&mut self, cx: &mut Context<Self>) {
        let key = self.config.frontend_api.to_string();
        let read = cx.read_credentials(&key);
        let generation = self.next_generation();
        self.operation = Some(cx.spawn(async move |this, cx| {
            let stored = match read.await {
                Ok(Some((_, bytes))) => serde_json::from_slice::<Stored>(&bytes).ok(),
                Ok(None) => None,
                Err(error) => {
                    tracing::warn!(?error, "could not read the Keychain");
                    None
                }
            };
            let _ = this.update(cx, |this, cx| {
                if this.generation == generation {
                    this.apply_stored(stored, cx);
                }
            });
        }));
    }

    fn apply_stored(&mut self, stored: Option<Stored>, cx: &mut Context<Self>) {
        let Some(Stored {
            client_token: Some(client_token),
            session_id,
            account,
        }) = stored
        else {
            self.set_signed_out(None, cx);
            return;
        };
        self.api.set_client_token(Some(client_token));
        if let (Some(session_id), Some(account)) = (session_id, account) {
            self.tokens.set_session(Some(session_id));
            self.set_signed_in(account, cx);
        }
        self.verify(cx);
    }

    /// Asks Clerk which session this client has now. While nothing is on
    /// screen yet (no stored account), a failure to reach Clerk is retried a
    /// few times, then the sign-in screen comes back with the reason.
    fn verify(&mut self, cx: &mut Context<Self>) {
        let generation = self.next_generation();
        let api = self.api.clone();
        self.operation = Some(cx.spawn(async move |this, cx| {
            let started = Instant::now();
            let mut delays = RESTORE_RETRY_DELAYS.iter();
            loop {
                let request = artsnack_runtime::spawn_result(cx, {
                    let api = api.clone();
                    async move { Ok(api.client().await) }
                });
                let result = request.await;
                let delay = delays
                    .next()
                    .filter(|_| started.elapsed() < RESTORE_PATIENCE);
                let again = this.update(cx, |this, cx| {
                    this.generation == generation && this.apply_check(result, delay.is_some(), cx)
                });
                match (again, delay) {
                    (Ok(true), Some(delay)) => cx.background_executor().timer(*delay).await,
                    _ => return,
                }
            }
        }));
    }

    /// Applies Clerk's answer about the stored client; true to ask again,
    /// which `may_retry` allows.
    fn apply_check(
        &mut self,
        result: anyhow::Result<Result<Option<Client>, FrontendApiError>>,
        may_retry: bool,
        cx: &mut Context<Self>,
    ) -> bool {
        let (error, transient) = match result {
            Ok(Ok(client)) => {
                self.apply_client(client, cx);
                return false;
            }
            Ok(Err(error)) if error.is_unauthorized() => {
                self.end(Some(SESSION_ENDED.into()), cx);
                return false;
            }
            Ok(Err(error)) => (error.to_string(), error.is_transient()),
            Err(error) => (error.to_string(), true),
        };
        if self.status != SessionStatus::Restoring {
            // Signed in from the stored copy: keep it; token refreshes retry
            // on their own.
            tracing::warn!(%error, "could not check the session with Clerk");
            return false;
        }
        if transient && may_retry {
            tracing::debug!(%error, "retrying the session check");
            return true;
        }
        tracing::warn!(%error, "could not restore the session");
        // The client token stays, so the next sign-in reuses this client.
        self.set_signed_out(Some(RESTORE_FAILED.into()), cx);
        false
    }

    fn apply_client(&mut self, client: Option<Client>, cx: &mut Context<Self>) {
        let active = client.as_ref().and_then(Client::active_session);
        let Some((session_id, user)) =
            active.and_then(|session| Some((session.id.clone(), session.user.as_ref()?)))
        else {
            self.forget();
            self.set_signed_out(None, cx);
            return;
        };
        // Compared with the session in use now, not the one the check started
        // with: anything may have changed while it was out.
        if self.tokens.session_id().as_deref() != Some(session_id.as_str()) {
            self.tokens.set_session(Some(session_id));
        }
        self.set_signed_in(Account::from_user(user), cx);
        self.persist();
    }

    fn redeem(&mut self, ticket: String, cx: &mut Context<Self>) {
        self.status = SessionStatus::Completing;
        self.error = None;
        cx.notify();

        let generation = self.next_generation();
        let api = self.api.clone();
        let request =
            artsnack_runtime::spawn_result(
                cx,
                async move { Ok(redeem_ticket(&api, &ticket).await) },
            );
        self.operation = Some(cx.spawn(async move |this, cx| {
            let result = request.await;
            let _ = this.update(cx, |this, cx| {
                if this.generation != generation {
                    return;
                }
                match result {
                    Ok(Ok((session_id, account))) => {
                        this.tokens.set_session(Some(session_id));
                        this.set_signed_in(account, cx);
                        this.persist();
                    }
                    Ok(Err(error)) => this.set_signed_out(Some(describe(&error)), cx),
                    Err(error) => this.set_signed_out(Some(error.to_string().into()), cx),
                }
            });
        }));
    }

    fn next_generation(&mut self) -> u64 {
        self.generation += 1;
        self.generation
    }

    fn set_signed_in(&mut self, account: Account, cx: &mut Context<Self>) {
        let previous = self.account().cloned();
        if previous
            .as_ref()
            .is_some_and(|previous| previous.user_id != account.user_id)
        {
            // Another user without a sign-out in between (the stored account
            // was one user, Clerk's session is another's): end the first in
            // every observer before the second begins.
            cx.emit(SessionEvent::SignedOut);
        }
        let changed = previous.as_ref() != Some(&account);
        self.status = SessionStatus::SignedIn(account.clone());
        self.error = None;
        if changed {
            cx.emit(SessionEvent::SignedIn(account));
        }
        cx.notify();
    }

    fn set_signed_out(&mut self, error: Option<SharedString>, cx: &mut Context<Self>) {
        let was_signed_in = self.account().is_some();
        self.status = SessionStatus::SignedOut;
        self.error = error;
        if was_signed_in {
            cx.emit(SessionEvent::SignedOut);
        }
        cx.notify();
    }

    /// Forgets the credentials: the session, the client token (so responses
    /// still out cannot rotate it back) and the Keychain item.
    fn forget(&mut self) {
        self.generation += 1;
        self.tokens.set_session(None);
        self.api.clear_client_token();
        self.write_keychain(KeychainWrite::Delete);
    }

    /// Queues the client token, session and account for the Keychain — or the
    /// item's deletion when there is no client token any more.
    fn persist(&mut self) {
        let Some(client_token) = self.api.client_token() else {
            self.write_keychain(KeychainWrite::Delete);
            return;
        };
        let stored = Stored {
            client_token: Some(client_token),
            session_id: self.tokens.session_id(),
            account: self.account().cloned(),
        };
        match serde_json::to_vec(&stored) {
            Ok(bytes) => self.write_keychain(KeychainWrite::Store(bytes)),
            Err(error) => tracing::error!(%error, "could not encode the session for the Keychain"),
        }
    }

    fn write_keychain(&self, write: KeychainWrite) {
        if self.keychain.unbounded_send(write).is_err() {
            tracing::error!("the Keychain writer has stopped");
        }
    }
}

/// Applies Keychain writes one at a time, in the order they were queued. Each
/// write replaces the whole item, so of several queued only the newest runs.
fn keychain_writer(
    url: String,
    mut writes: mpsc::UnboundedReceiver<KeychainWrite>,
    cx: &mut Context<Session>,
) -> Task<()> {
    cx.spawn(async move |_, cx| {
        while let Some(mut write) = writes.next().await {
            while let Ok(newer) = writes.try_recv() {
                write = newer;
            }
            let done = cx.update(|cx| match &write {
                KeychainWrite::Store(bytes) => cx.write_credentials(&url, KEYCHAIN_USER, bytes),
                KeychainWrite::Delete => cx.delete_credentials(&url),
            });
            if let Err(error) = done.await {
                tracing::warn!(?error, "could not update the Keychain");
            }
        }
    })
}

/// Exchanges a sign-in ticket for a session; returns its id and the user.
async fn redeem_ticket(
    api: &FrontendApi,
    ticket: &str,
) -> Result<(String, Account), FrontendApiError> {
    if api.client_token().is_none() {
        api.create_client().await?;
    }
    let sign_in = match api.sign_in_with_ticket(ticket).await {
        Err(error) if error.code() == Some("session_exists") => {
            api.remove_all_sessions().await?;
            api.sign_in_with_ticket(ticket).await?
        }
        other => other?,
    };
    let complete = sign_in
        .response
        .as_ref()
        .filter(|sign_in| sign_in.status == "complete")
        .and_then(|sign_in| sign_in.created_session_id.clone());
    let Some(session_id) = complete else {
        return Err(FrontendApiError::Clerk {
            status: reqwest::StatusCode::OK,
            code: "sign_in_incomplete".into(),
            message: "Clerk did not complete the sign-in".into(),
        });
    };
    let client = match sign_in.client {
        Some(client) => client,
        None => api.client().await?.ok_or(FrontendApiError::Clerk {
            status: reqwest::StatusCode::OK,
            code: "no_client".into(),
            message: "Clerk returned no client after sign-in".into(),
        })?,
    };
    let user = client
        .sessions
        .iter()
        .find(|session| session.id == session_id)
        .and_then(|session| session.user.as_ref())
        .ok_or(FrontendApiError::Clerk {
            status: reqwest::StatusCode::OK,
            code: "no_user".into(),
            message: "Clerk returned the session without its user".into(),
        })?;
    Ok((session_id, Account::from_user(user)))
}

/// A sign-in failure in words the user can act on.
fn describe(error: &FrontendApiError) -> SharedString {
    match error.code() {
        Some("ticket_expired_code" | "sign_in_token_expired") => {
            "The sign-in link expired. Start again.".into()
        }
        Some("sign_in_token_already_used_code" | "sign_in_token_already_used") => {
            "That sign-in link was already used. Start again.".into()
        }
        Some("native_api_disabled") => {
            "Native sign-in is turned off for this Clerk instance (Clerk dashboard → Native applications).".into()
        }
        _ => format!("Sign-in failed: {error}").into(),
    }
}
