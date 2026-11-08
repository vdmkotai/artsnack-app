//! One Convex connection for the whole app.
//!
//! The WebSocket and its worker run on the I/O runtime (convex-rs starts them
//! with `tokio::spawn`); everything else — subscribing, reading results,
//! calling mutations — only exchanges messages with that worker over channels.
//! Results are read, compared and decoded on GPUI's background executor, so the
//! main thread only receives finished values.
//!
//! Auth follows the web app's rules:
//! - queries wait for the first token (the web's `expectAuth`): the gate opens
//!   only after the token source produced a token and Convex was handed it, so
//!   nothing a signed-in screen asks for runs anonymously first;
//! - tokens are fetched here, on the I/O runtime, one refresh at a time, shortly
//!   before the current one expires — never inside convex-rs's worker, which
//!   awaits an auth fetcher inline and serves no query, mutation or socket
//!   message while it does. Convex is only ever handed a token already in hand.

use std::{future::Future, pin::Pin, sync::Arc, time::Duration};

use convex::{AuthenticationToken, ConvexClient, ConvexClientBuilder, WebSocketState};
use futures::{
    FutureExt as _,
    channel::oneshot,
    future::{LocalBoxFuture, Shared},
};
use gpui_kit::{App, AppContext as _, Context, Entity, EventEmitter, Global, Task};
use serde::{Serialize, de::DeserializeOwned};

use crate::{
    error::CallError,
    function::{Action, Mutation, Query, decode, encode_args},
};

/// How long a one-shot query may take, waiting for sign-in included.
const QUERY_DEADLINE: Duration = Duration::from_secs(30);
/// How long a mutation may take before the UI stops waiting (the web's
/// `withServerTimeout`), waiting for sign-in included. The write may still
/// land; the next query result shows it.
const MUTATION_DEADLINE: Duration = Duration::from_secs(30);
/// Actions call providers and can be slow (pod launches, image description).
const ACTION_DEADLINE: Duration = Duration::from_secs(120);
/// Look at the token at least this often, so a token that went stale while the
/// Mac slept (monotonic timers do not run then) is replaced soon after waking.
const MAX_AUTH_RECHECK: Duration = Duration::from_secs(10);
const MIN_AUTH_RECHECK: Duration = Duration::from_secs(1);
/// Backoff between failed token fetches (each one already retried for 45 s).
const AUTH_RETRY_DELAYS: [Duration; 4] = [
    Duration::from_secs(2),
    Duration::from_secs(5),
    Duration::from_secs(15),
    Duration::from_secs(30),
];

/// Supplies Convex with tokens.
pub trait TokenSource: Send + Sync + 'static {
    /// A token: the cached one while it is fresh (unless `force_refresh`),
    /// otherwise a new one. `Ok(None)` means signed out.
    fn token(
        &self,
        force_refresh: bool,
    ) -> Pin<Box<dyn Future<Output = anyhow::Result<Option<String>>> + Send>>;
    /// How much longer the current token stays fresh; `None` without one.
    fn fresh_for(&self) -> Option<Duration>;
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ConnectionStatus {
    Connecting,
    Connected,
    /// The connection dropped and is being re-established; results on screen
    /// are the last ones received.
    Reconnecting,
    /// The client could not even be created (a bad deployment URL).
    Failed,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum BackendEvent {
    StatusChanged(ConnectionStatus),
}

type ConnectFuture = Shared<LocalBoxFuture<'static, Result<ConvexClient, Arc<str>>>>;
type ClientWaiter = oneshot::Sender<Result<ConvexClient, CallError>>;

pub struct Backend {
    connect: ConnectFuture,
    status: ConnectionStatus,
    /// Why the client could not be created; every call fails with it.
    failure: Option<Arc<str>>,
    /// The client once it is connected *and* authenticated; queries wait here.
    authenticated: Option<ConvexClient>,
    waiting: Vec<ClientWaiter>,
    auth_task: Option<Task<()>>,
    /// Signalled when the socket connects, so a token fetch that failed
    /// offline is tried again at once instead of after its backoff.
    connected: Arc<tokio::sync::Notify>,
    _status_task: Task<()>,
}

impl EventEmitter<BackendEvent> for Backend {}

struct GlobalBackend(Entity<Backend>);

impl Global for GlobalBackend {}

/// Opens the connection to `deployment_url` (`https://….convex.cloud`).
pub fn init(deployment_url: String, cx: &mut App) -> Entity<Backend> {
    let backend = cx.new(|cx| Backend::new(deployment_url, cx));
    cx.set_global(GlobalBackend(backend.clone()));
    backend
}

impl Backend {
    fn new(deployment_url: String, cx: &mut Context<Self>) -> Self {
        let (state_sender, mut state_receiver) = tokio::sync::mpsc::channel(8);
        let build = artsnack_runtime::spawn_result(cx, async move {
            ConvexClientBuilder::new(&deployment_url)
                .with_client_id(concat!("artsnack-macos-", env!("CARGO_PKG_VERSION")))
                .with_on_state_change(state_sender)
                .build()
                .await
        });
        let connect: ConnectFuture = async move {
            build.await.map_err(|error| {
                tracing::error!(?error, "could not create the Convex client");
                Arc::<str>::from(error.to_string())
            })
        }
        .boxed_local()
        .shared();

        let connected = Arc::new(tokio::sync::Notify::new());
        let status_task = cx.spawn(async move |this, cx| {
            while let Some(state) = state_receiver.recv().await {
                let updated = this.update(cx, |this, cx| {
                    let status = match state {
                        WebSocketState::Connected => ConnectionStatus::Connected,
                        WebSocketState::Connecting
                            if this.status == ConnectionStatus::Connecting =>
                        {
                            ConnectionStatus::Connecting
                        }
                        WebSocketState::Connecting => ConnectionStatus::Reconnecting,
                    };
                    if status == ConnectionStatus::Connected {
                        this.connected.notify_waiters();
                    }
                    this.set_status(status, cx);
                });
                if updated.is_err() {
                    break;
                }
            }
        });

        let failed = connect.clone();
        cx.spawn(async move |this, cx| {
            if let Err(error) = failed.await {
                let _ = this.update(cx, |this, cx| this.fail(error, cx));
            }
        })
        .detach();

        Self {
            connect,
            status: ConnectionStatus::Connecting,
            failure: None,
            authenticated: None,
            waiting: Vec::new(),
            auth_task: None,
            connected,
            _status_task: status_task,
        }
    }

    pub fn global(cx: &App) -> Entity<Backend> {
        cx.global::<GlobalBackend>().0.clone()
    }

    pub fn status(&self) -> ConnectionStatus {
        self.status
    }

    fn set_status(&mut self, status: ConnectionStatus, cx: &mut Context<Self>) {
        if self.status != status {
            self.status = status;
            cx.emit(BackendEvent::StatusChanged(status));
            cx.notify();
        }
    }

    /// The client will never exist: everything waiting for it fails now, and
    /// every later call fails at once.
    fn fail(&mut self, error: Arc<str>, cx: &mut Context<Self>) {
        for waiter in self.waiting.drain(..) {
            let _ = waiter.send(Err(CallError::Disconnected(error.to_string())));
        }
        self.failure = Some(error);
        self.set_status(ConnectionStatus::Failed, cx);
    }

    /// Authenticates with tokens from `source` from now on. Calls made from
    /// here on wait until Convex has its first token. Call on sign-in.
    pub fn sign_in(&mut self, source: Arc<dyn TokenSource>, cx: &mut Context<Self>) {
        self.authenticated = None;
        let connect = self.connect.clone();
        let connected = self.connected.clone();
        self.auth_task = Some(cx.spawn(async move |this, cx| {
            let Ok(mut client) = connect.await else {
                return;
            };
            // The token Convex holds now; a new one is pushed only when it differs.
            let mut pushed: Option<String> = None;
            let mut failures = 0usize;
            loop {
                let fetched = artsnack_runtime::spawn(cx, source.token(false)).await;
                let wait = match fetched {
                    Ok(Ok(Some(jwt))) => {
                        failures = 0;
                        if pushed.as_deref() != Some(jwt.as_str()) {
                            client
                                .set_auth_callback(Some(fetcher(jwt.clone(), source.clone())))
                                .await;
                            pushed = Some(jwt);
                        }
                        // The Authenticate message is queued ahead of anything a
                        // released caller sends, so it runs under this identity.
                        if this.update(cx, |this, _| this.open_gate(&client)).is_err() {
                            return;
                        }
                        source
                            .fresh_for()
                            .unwrap_or_default()
                            .clamp(MIN_AUTH_RECHECK, MAX_AUTH_RECHECK)
                    }
                    // Signed out: the session signs the backend out as well.
                    Ok(Ok(None)) => return,
                    Ok(Err(error)) => {
                        tracing::warn!(%error, "could not get a Convex token");
                        failures += 1;
                        AUTH_RETRY_DELAYS[(failures - 1).min(AUTH_RETRY_DELAYS.len() - 1)]
                    }
                    Err(error) => {
                        tracing::warn!(%error, "the Convex token request did not run");
                        failures += 1;
                        AUTH_RETRY_DELAYS[(failures - 1).min(AUTH_RETRY_DELAYS.len() - 1)]
                    }
                };
                let timer = cx.background_executor().timer(wait);
                futures::select_biased! {
                    _ = timer.fuse() => {}
                    _ = connected.notified().fuse() => {}
                }
            }
        }));
    }

    /// Drops authentication: running queries re-run anonymously (and come back
    /// empty or rejected), and new calls wait for the next sign-in.
    pub fn sign_out(&mut self, cx: &mut Context<Self>) {
        self.auth_task = None;
        self.authenticated = None;
        self.waiting.retain(|waiter| !waiter.is_canceled());
        let connect = self.connect.clone();
        cx.spawn(async move |_, _| {
            if let Ok(mut client) = connect.await {
                client.set_auth_callback(None).await;
            }
        })
        .detach();
    }

    fn open_gate(&mut self, client: &ConvexClient) {
        if self.authenticated.is_some() {
            return;
        }
        self.authenticated = Some(client.clone());
        for waiter in self.waiting.drain(..) {
            let _ = waiter.send(Ok(client.clone()));
        }
    }

    /// The client, once connected and authenticated. The future is `Send`, so
    /// background work can wait on it.
    pub(crate) fn authenticated_client(
        &mut self,
    ) -> impl Future<Output = Result<ConvexClient, CallError>> + Send + use<> {
        let ready = if let Some(error) = &self.failure {
            Ok(Err(CallError::Disconnected(error.to_string())))
        } else if let Some(client) = &self.authenticated {
            Ok(Ok(client.clone()))
        } else {
            // Callers that gave up (a closed screen) leave a cancelled sender.
            self.waiting.retain(|waiter| !waiter.is_canceled());
            let (sender, receiver) = oneshot::channel();
            self.waiting.push(sender);
            Err(receiver)
        };
        async move {
            match ready {
                Ok(result) => result,
                Err(receiver) => receiver
                    .await
                    .unwrap_or_else(|_| Err(CallError::Disconnected("signed out".into()))),
            }
        }
    }

    /// One page of a paginated query, read once (no subscription): for
    /// scanning a history for a row, as the web's `findInHistory` does.
    pub fn query_page<Args, T>(
        &mut self,
        query: crate::PaginatedQuery<Args, T>,
        args: &Args,
        num_items: usize,
        cursor: Option<String>,
        cx: &mut Context<Self>,
    ) -> Task<Result<crate::Page<T>, CallError>>
    where
        Args: Serialize,
        T: DeserializeOwned + Send + 'static,
    {
        let mut json = serde_json::to_value(args).unwrap_or_default();
        if !json.is_object() {
            json = serde_json::Value::Object(Default::default());
        }
        json["paginationOpts"] = serde_json::json!({ "numItems": num_items, "cursor": cursor });
        self.query(
            Query::<serde_json::Value, crate::Page<T>>::new(query.path()),
            &json,
            cx,
        )
    }

    /// Runs a query once and returns its current result, or
    /// [`CallError::Timeout`] after 30 s.
    pub fn query<Args, Output>(
        &mut self,
        query: Query<Args, Output>,
        args: &Args,
        cx: &mut Context<Self>,
    ) -> Task<Result<Output, CallError>>
    where
        Args: Serialize,
        Output: DeserializeOwned + Send + 'static,
    {
        let args = encode_args(args);
        let path = query.path();
        let client = self.authenticated_client();
        call(client, QUERY_DEADLINE, cx, move |mut client| async move {
            client
                .query(path, args?)
                .await
                .map_err(|error| CallError::Disconnected(error.to_string()))
        })
    }

    /// Runs a mutation. The returned task resolves once the write is visible to
    /// every live query, or with [`CallError::Timeout`] after 30 s.
    pub fn mutate<Args, Output>(
        &mut self,
        mutation: Mutation<Args, Output>,
        args: &Args,
        cx: &mut Context<Self>,
    ) -> Task<Result<Output, CallError>>
    where
        Args: Serialize,
        Output: DeserializeOwned + Send + 'static,
    {
        let args = encode_args(args);
        let path = mutation.path();
        let client = self.authenticated_client();
        call(
            client,
            MUTATION_DEADLINE,
            cx,
            move |mut client| async move {
                client
                    .mutation(path, args?)
                    .await
                    .map_err(|error| CallError::Disconnected(error.to_string()))
            },
        )
    }

    /// Runs an action. Actions may spend money, so they are never retried here.
    pub fn act<Args, Output>(
        &mut self,
        action: Action<Args, Output>,
        args: &Args,
        cx: &mut Context<Self>,
    ) -> Task<Result<Output, CallError>>
    where
        Args: Serialize,
        Output: DeserializeOwned + Send + 'static,
    {
        self.act_within(action, args, ACTION_DEADLINE, cx)
    }

    /// [`Self::act`] with its own deadline, for actions that block until a
    /// long job is done (an enhancement waits for the pod).
    pub fn act_within<Args, Output>(
        &mut self,
        action: Action<Args, Output>,
        args: &Args,
        deadline: Duration,
        cx: &mut Context<Self>,
    ) -> Task<Result<Output, CallError>>
    where
        Args: Serialize,
        Output: DeserializeOwned + Send + 'static,
    {
        let args = encode_args(args);
        let path = action.path();
        let client = self.authenticated_client();
        call(client, deadline, cx, move |mut client| async move {
            client
                .action(path, args?)
                .await
                .map_err(|error| CallError::Disconnected(error.to_string()))
        })
    }
}

/// Runs one call off the main thread: waits for the authenticated client,
/// sends, and decodes the answer, all within `deadline` — offline, a call fails
/// with [`CallError::Timeout`] instead of waiting forever.
fn call<Output, Run, Fut>(
    client: impl Future<Output = Result<ConvexClient, CallError>> + Send + 'static,
    deadline: Duration,
    cx: &App,
    run: Run,
) -> Task<Result<Output, CallError>>
where
    Output: DeserializeOwned + Send + 'static,
    Run: FnOnce(ConvexClient) -> Fut + Send + 'static,
    Fut: Future<Output = Result<convex::FunctionResult, CallError>> + Send,
{
    let timer = cx.background_executor().timer(deadline);
    cx.background_spawn(async move {
        let call = async move {
            let result = run(client.await?).await?;
            decode(CallError::from_result(result)?)
        };
        futures::select_biased! {
            result = call.fuse() => result,
            _ = timer.fuse() => Err(CallError::Timeout),
        }
    })
}

/// What Convex keeps to authenticate with. convex-rs calls it with `false`
/// right after it is handed over — it then returns the token the driver just
/// fetched, without waiting — and with `true` from inside its worker when the
/// socket reconnects. The token may have expired while the socket was down, so
/// that call asks the source, which answers from its cache while the token is
/// fresh; only a stale token waits for Clerk, and the wait holds up the
/// reconnect alone (the JS client pauses its socket the same way).
fn fetcher(jwt: String, source: Arc<dyn TokenSource>) -> convex::AuthTokenFetcher {
    Box::new(move |reconnecting| {
        if !reconnecting {
            let jwt = jwt.clone();
            return Box::pin(async move { Ok(AuthenticationToken::User(jwt)) });
        }
        let token = source.token(false);
        Box::pin(async move {
            Ok(match token.await? {
                Some(jwt) => AuthenticationToken::User(jwt),
                None => AuthenticationToken::None,
            })
        })
    })
}
