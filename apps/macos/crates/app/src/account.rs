//! Ties the session to the Convex connection: sign-in hands Convex the token
//! source, sign-out takes it away and forgets every cached query result, so the
//! next user never sees the previous one's data. The remembered results belong
//! to the signed-in user ([`QuerySnapshots::set_owner`]).

use std::{future::Future, pin::Pin, sync::Arc, time::Duration};

use artsnack_backend::{QuerySnapshots, TokenSource};
use artsnack_session::{ConvexTokens, Session, SessionConfig, SessionEvent, TokenError};
use futures::{StreamExt as _, channel::mpsc};
use gpui_kit::App;

use crate::environment::Environment;

/// Starts the session and the Convex connection and links them. `urls` carries
/// the URLs macOS opened the app with (the sign-in link among them).
pub fn init(
    environment: &Environment,
    mut urls: mpsc::UnboundedReceiver<Vec<String>>,
    cx: &mut App,
) {
    let backend = artsnack_backend::init(environment.convex_url.clone(), cx);
    let session = match artsnack_session::init(
        SessionConfig {
            frontend_api: environment.clerk_frontend_api.clone(),
            web_app: environment.web_app.clone(),
        },
        cx,
    ) {
        Ok(session) => session,
        Err(error) => {
            tracing::error!(?error, "could not start the session");
            return;
        }
    };

    let tokens = session.read(cx).convex_tokens();
    // The user Convex authenticates as: `SignedIn` also reports a changed name
    // or picture, which must not re-authenticate (and so re-run) every query.
    let mut authenticated: Option<String> = None;
    cx.subscribe(&session, move |_, event, cx| match event {
        SessionEvent::SignedIn(account) => {
            if authenticated.as_deref() == Some(account.user_id()) {
                return;
            }
            authenticated = Some(account.user_id().to_string());
            QuerySnapshots::set_owner(cx, Some(account.user_id()));
            let source: Arc<dyn TokenSource> = Arc::new(SessionTokens(tokens.clone()));
            backend.update(cx, |backend, cx| backend.sign_in(source, cx));
        }
        SessionEvent::SignedOut => {
            authenticated = None;
            backend.update(cx, |backend, cx| backend.sign_out(cx));
            QuerySnapshots::clear(cx);
        }
    })
    .detach();

    cx.spawn(async move |cx| {
        while let Some(batch) = urls.next().await {
            cx.update(|cx| {
                Session::global(cx).update(cx, |session, cx| session.handle_open_urls(&batch, cx));
            });
        }
    })
    .detach();
}

/// The session's Convex tokens, in the shape the Convex layer asks for.
struct SessionTokens(Arc<ConvexTokens>);

impl TokenSource for SessionTokens {
    fn token(
        &self,
        force_refresh: bool,
    ) -> Pin<Box<dyn Future<Output = anyhow::Result<Option<String>>> + Send>> {
        let tokens = self.0.clone();
        Box::pin(async move {
            match tokens.token(force_refresh).await {
                Ok(jwt) => Ok(Some(jwt)),
                Err(TokenError::SignedOut) => Ok(None),
                Err(error) => Err(error.into()),
            }
        })
    }

    fn fresh_for(&self) -> Option<Duration> {
        self.0.fresh_for()
    }
}
