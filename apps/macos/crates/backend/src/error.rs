use gpui_kit::SharedString;

/// Why a Convex call produced no result.
#[derive(Clone, Debug, thiserror::Error)]
pub enum CallError {
    /// The function threw. `message` is what the user should see.
    #[error("{message}")]
    Function {
        message: String,
        /// The `ConvexError` payload, when the function threw one.
        data: Option<serde_json::Value>,
    },
    /// No answer within the deadline; the call may still complete server-side.
    #[error("the server did not answer in time")]
    Timeout,
    /// The connection to Convex could not be opened.
    #[error("not connected: {0}")]
    Disconnected(String),
    #[error("could not encode the arguments: {0}")]
    Encode(String),
    #[error("unexpected response from the server: {0}")]
    Decode(String),
}

/// What `authz.ts` throws for a signed-in account that is not on the allowlist.
const NO_ACCESS: &str = "This account does not have access";

impl CallError {
    pub(crate) fn from_result(result: convex::FunctionResult) -> Result<serde_json::Value, Self> {
        match result {
            convex::FunctionResult::Value(value) => Ok(value.export()),
            convex::FunctionResult::ErrorMessage(message) => Err(Self::Function {
                message: clean_message(&message),
                data: None,
            }),
            convex::FunctionResult::ConvexError(error) => {
                let data = error.data.export();
                Err(Self::Function {
                    message: convex_error_message(&error.message, &data),
                    data: Some(data),
                })
            }
        }
    }

    /// True for the allowlist rejection: the user is signed in but not let in.
    pub fn is_no_access(&self) -> bool {
        matches!(self, Self::Function { message, .. } if message.contains(NO_ACCESS))
    }

    pub fn is_invalid_cursor(&self) -> bool {
        match self {
            Self::Function { message, data } => {
                message.contains("InvalidCursor")
                    || data
                        .as_ref()
                        .and_then(|data| data.get("paginationError"))
                        .and_then(|value| value.as_str())
                        == Some("InvalidCursor")
            }
            _ => false,
        }
    }

    pub fn user_message(&self) -> SharedString {
        self.to_string().into()
    }
}

/// A `ConvexError` thrown with a string says it in its data. Its message is
/// redacted on a production deployment (convex-rs's own note on the field),
/// so the data is what a person gets to read whenever it is a sentence.
fn convex_error_message(message: &str, data: &serde_json::Value) -> String {
    match data.as_str().map(str::trim) {
        Some(text) if !text.is_empty() => text.to_string(),
        _ => clean_message(message),
    }
}

/// Server errors arrive as `[Request ID: …] Server Error\nUncaught Error: msg\n    at …`.
/// Keep only the message a person can act on.
fn clean_message(raw: &str) -> String {
    let line = raw
        .lines()
        .find_map(|line| {
            let line = line.trim();
            line.strip_prefix("Uncaught Error: ")
                .or_else(|| line.strip_prefix("Uncaught ConvexError: "))
                .or_else(|| line.strip_prefix("Error: "))
        })
        .unwrap_or(raw);
    line.trim().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_only_the_thrown_message() {
        let raw = "[Request ID: 1a2b] Server Error\nUncaught Error: This account does not have access\n    at requireAllowedUser (../authz.ts:40:12)";
        assert_eq!(clean_message(raw), "This account does not have access");
        assert_eq!(clean_message("plain"), "plain");
    }

    #[test]
    fn a_convex_error_reads_its_data() {
        let data = serde_json::json!("Atlas balance is empty — top it up");
        assert_eq!(
            convex_error_message("Server Error", &data),
            "Atlas balance is empty — top it up"
        );
        let raw = "[Request ID: 1a2b] Server Error\nUncaught ConvexError: kept\n    at x";
        assert_eq!(
            convex_error_message(raw, &serde_json::json!({ "code": 1 })),
            "kept"
        );
    }

    #[test]
    fn recognises_the_allowlist_rejection() {
        let error = CallError::Function {
            message: "This account does not have access".into(),
            data: None,
        };
        assert!(error.is_no_access());
        assert!(!CallError::Timeout.is_no_access());
    }
}
