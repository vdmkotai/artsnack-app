//! The browser handoff: Google refuses OAuth inside an app's own window, so
//! sign-in happens in the default browser on `/desktop/handoff`, which mints a
//! single-use, two-minute Clerk sign-in token and sends the browser to
//! `artsnack-native://sign-in?ticket=…&state=…`.
//!
//! The contract is `packages/shared/desktop-bridge.ts` (`nativeHandoffPath`,
//! `nativeSignInDeepLink`); keep the two in step.

use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use rand::RngCore as _;
use url::Url;

/// Registered in the app's Info.plist. Distinct from the Electron shell's
/// `artsnack://`, so a link meant for one is never opened by the other.
pub const NATIVE_URL_SCHEME: &str = "artsnack-native";

/// A fresh, unguessable `state`: 32 random bytes, URL-safe base64 (43 chars),
/// inside the handoff page's accepted shape `[A-Za-z0-9_-]{16,128}`.
pub fn new_state() -> String {
    let mut bytes = [0u8; 32];
    rand::rng().fill_bytes(&mut bytes);
    URL_SAFE_NO_PAD.encode(bytes)
}

/// `https://artsnack.example.com/desktop/handoff?client=native&state=…`
pub fn handoff_url(web_app: &Url, state: &str) -> Url {
    let mut url = web_app.clone();
    url.set_path("/desktop/handoff");
    url.query_pairs_mut()
        .clear()
        .append_pair("client", "native")
        .append_pair("state", state);
    url
}

#[derive(Debug, PartialEq, Eq)]
pub struct SignInLink {
    pub ticket: String,
    pub state: String,
}

/// Parses `artsnack-native://sign-in?ticket=…&state=…` (also the
/// `artsnack-native:///sign-in` form some launchers produce).
pub fn parse_sign_in_link(raw: &str) -> Option<SignInLink> {
    let url = Url::parse(raw).ok()?;
    if url.scheme() != NATIVE_URL_SCHEME {
        return None;
    }
    let route = match url.host_str() {
        Some(host) if !host.is_empty() => host.to_string(),
        _ => url.path().trim_start_matches('/').to_string(),
    };
    if route != "sign-in" {
        return None;
    }
    let mut ticket = None;
    let mut state = None;
    for (key, value) in url.query_pairs() {
        match key.as_ref() {
            "ticket" => ticket = Some(value.trim().to_string()),
            "state" => state = Some(value.trim().to_string()),
            _ => {}
        }
    }
    let ticket = ticket.filter(|ticket| !ticket.is_empty())?;
    let state = state.filter(|state| !state.is_empty())?;
    Some(SignInLink { ticket, state })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn state_matches_the_handoff_page_pattern() {
        let state = new_state();
        assert_eq!(state.len(), 43);
        assert!(
            state
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
        );
        assert_ne!(state, new_state());
    }

    #[test]
    fn builds_the_handoff_url() {
        let url = handoff_url(
            &Url::parse("https://artsnack.example.com").unwrap(),
            "abc_DEF-123",
        );
        assert_eq!(
            url.as_str(),
            "https://artsnack.example.com/desktop/handoff?client=native&state=abc_DEF-123"
        );
    }

    #[test]
    fn parses_both_link_forms_and_decodes_the_ticket() {
        let expected = SignInLink {
            ticket: "abc+def/ghi=".into(),
            state: "s1".into(),
        };
        assert_eq!(
            parse_sign_in_link("artsnack-native://sign-in?ticket=abc%2Bdef%2Fghi%3D&state=s1"),
            Some(expected)
        );
        assert!(parse_sign_in_link("artsnack-native:///sign-in?ticket=t&state=s").is_some());
    }

    #[test]
    fn rejects_other_schemes_routes_and_missing_parts() {
        assert!(parse_sign_in_link("artsnack://sign-in?ticket=t&state=s").is_none());
        assert!(parse_sign_in_link("artsnack-native://open?ticket=t&state=s").is_none());
        assert!(parse_sign_in_link("artsnack-native://sign-in?ticket=t").is_none());
        assert!(parse_sign_in_link("artsnack-native://sign-in?ticket=%20&state=s").is_none());
        assert!(parse_sign_in_link("not a url").is_none());
    }
}
