//! Reads the claims of a JWT without verifying it. The client only needs the
//! audience and the lifetime to decide which token to ask for and when to
//! refresh it; Convex verifies the signature.

use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use serde::Deserialize;

#[derive(Clone, Debug, Default, Deserialize)]
pub struct Claims {
    /// Audience: one string or an array of them.
    #[serde(default, deserialize_with = "one_or_many")]
    pub aud: Vec<String>,
    pub sub: Option<String>,
    pub exp: Option<i64>,
    pub iat: Option<i64>,
}

impl Claims {
    pub fn has_audience(&self, audience: &str) -> bool {
        self.aud.iter().any(|aud| aud == audience)
    }

    /// The token's lifetime in seconds, from its own `iat`/`exp`. Counting it
    /// from the moment we asked for the token, rather than comparing `exp`
    /// with our clock, makes the refresh schedule immune to clock skew.
    pub fn lifetime_seconds(&self) -> Option<i64> {
        Some(self.exp? - self.iat?).filter(|seconds| *seconds > 0)
    }
}

pub fn claims(jwt: &str) -> Option<Claims> {
    let payload = jwt.split('.').nth(1)?;
    let bytes = URL_SAFE_NO_PAD.decode(payload.trim_end_matches('=')).ok()?;
    serde_json::from_slice(&bytes).ok()
}

fn one_or_many<'de, D>(deserializer: D) -> Result<Vec<String>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    #[derive(Deserialize)]
    #[serde(untagged)]
    enum OneOrMany {
        One(String),
        Many(Vec<String>),
    }
    Ok(match OneOrMany::deserialize(deserializer)? {
        OneOrMany::One(one) => vec![one],
        OneOrMany::Many(many) => many,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn jwt(payload: &str) -> String {
        format!("e30.{}.sig", URL_SAFE_NO_PAD.encode(payload))
    }

    #[test]
    fn reads_audience_as_a_string_or_an_array() {
        let single = claims(&jwt(r#"{"aud":"convex","iat":100,"exp":160}"#)).unwrap();
        assert!(single.has_audience("convex"));
        assert_eq!(single.lifetime_seconds(), Some(60));
        let many = claims(&jwt(r#"{"aud":["a","convex"]}"#)).unwrap();
        assert!(many.has_audience("convex"));
        assert_eq!(many.lifetime_seconds(), None);
    }

    #[test]
    fn rejects_garbage() {
        assert!(claims("not-a-jwt").is_none());
        assert!(claims("a.!!!.c").is_none());
    }
}
