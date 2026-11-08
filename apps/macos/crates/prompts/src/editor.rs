//! What a card editing a server row must get right (both prompt and recipe
//! cards use it):
//!
//! - it saves when the field loses focus, not on every keystroke;
//! - a remote edit (another device, the web) is adopted only while the card is
//!   not being edited, so it never overwrites what the user is typing;
//! - "dirty" is measured against the last server state the card adopted, so a
//!   save that comes back unchanged clears it;
//! - a field is marked saved only when its save succeeded, for the text that
//!   was sent; the server's own form of it (trimmed, defaulted) is adopted when
//!   nothing was typed since, so the card does not stay dirty over whitespace;
//! - saves go out one at a time, and a failed one keeps what was typed — the
//!   card says so and offers Retry ([`Saves`]).

use gpui_kit::SharedString;

/// The server's value as last adopted, and the local one.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Tracked {
    adopted: String,
    local: String,
}

impl Tracked {
    pub fn new(value: &str) -> Self {
        Self {
            adopted: value.to_string(),
            local: value.to_string(),
        }
    }

    pub fn local(&self) -> &str {
        &self.local
    }

    pub fn is_dirty(&self) -> bool {
        self.local != self.adopted
    }

    /// The user typed.
    pub fn edit(&mut self, value: &str) {
        self.local = value.to_string();
    }

    /// The server sent `value`. Returns the text the field should now show if
    /// it must change (only when not dirty and the value is new).
    pub fn server(&mut self, value: &str) -> Option<String> {
        if self.adopted == value {
            return None;
        }
        let dirty = self.is_dirty();
        self.adopted = value.to_string();
        if dirty {
            // Keep what the user is typing; it is now dirty against the new value.
            None
        } else {
            self.local = value.to_string();
            Some(self.local.clone())
        }
    }

    /// A save of `sent` (the local text when it went out) succeeded, and the
    /// server stores it as `stored`. Returns the text the field should show
    /// when it must change: only if nothing was typed since, and the server's
    /// form differs from what was typed.
    pub fn saved(&mut self, sent: &str, stored: &str) -> Option<String> {
        self.adopted = stored.to_string();
        if self.local == sent && self.local != stored {
            self.local = stored.to_string();
            return Some(self.local.clone());
        }
        None
    }

    /// Back to the server's value, for an edit that cannot be saved at all.
    pub fn revert(&mut self) -> String {
        self.local = self.adopted.clone();
        self.local.clone()
    }
}

/// A card's saves: one in flight at a time, another after it when there were
/// edits meanwhile, and the last failure until the next attempt.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Saves {
    in_flight: bool,
    again: bool,
    failed: Option<SharedString>,
}

impl Saves {
    /// Whether a save may go out now. While one is out, remembers to save
    /// again once it is back.
    pub fn begin(&mut self) -> bool {
        if self.in_flight {
            self.again = true;
            return false;
        }
        self.in_flight = true;
        self.failed = None;
        true
    }

    /// The save came back. Returns whether to save again (there were edits
    /// meanwhile). A failure is kept until the next attempt, and edits made
    /// meanwhile wait for it.
    pub fn finish(&mut self, result: Result<(), SharedString>) -> bool {
        self.in_flight = false;
        let again = std::mem::take(&mut self.again);
        match result {
            Ok(()) => again,
            Err(message) => {
                self.failed = Some(message);
                false
            }
        }
    }

    pub fn is_saving(&self) -> bool {
        self.in_flight
    }

    pub fn failed(&self) -> Option<&SharedString> {
        self.failed.as_ref()
    }
}

#[cfg(test)]
mod tests {
    use super::{Saves, Tracked};

    #[test]
    fn remote_edits_apply_only_when_clean() {
        let mut field = Tracked::new("a");
        assert_eq!(field.server("b"), Some("b".into()));
        field.edit("mine");
        assert_eq!(field.server("c"), None);
        assert_eq!(field.local(), "mine");
        assert!(field.is_dirty());
    }

    #[test]
    fn a_save_adopts_the_servers_form_only_when_nothing_was_typed_since() {
        let mut field = Tracked::new("a");
        field.edit("b  ");
        assert_eq!(field.saved("b  ", "b"), Some("b".into()));
        assert!(!field.is_dirty());

        field.edit("c ");
        // Typed on while the save was out: the newer text stays, still dirty.
        field.edit("cd");
        assert_eq!(field.saved("c ", "c"), None);
        assert_eq!(field.local(), "cd");
        assert!(field.is_dirty());
    }

    #[test]
    fn the_echo_of_a_save_before_its_answer_changes_nothing_typed() {
        let mut field = Tracked::new("a");
        field.edit("b ");
        // The live list brings the stored text before the mutation resolves.
        assert_eq!(field.server("b"), None);
        assert_eq!(field.saved("b ", "b"), Some("b".into()));
        assert!(!field.is_dirty());
    }

    #[test]
    fn reverting() {
        let mut field = Tracked::new("a");
        field.edit("");
        assert_eq!(field.revert(), "a");
        assert!(!field.is_dirty());
    }

    #[test]
    fn saves_go_one_at_a_time_and_a_failure_waits_for_retry() {
        let mut saves = Saves::default();
        assert!(saves.begin());
        assert!(!saves.begin(), "a second save waits for the first");
        assert!(saves.finish(Ok(())), "edits made meanwhile go out next");
        assert!(saves.begin());
        assert!(!saves.begin());
        assert!(!saves.finish(Err("offline".into())), "no automatic retry");
        assert_eq!(saves.failed().map(|m| m.as_ref()), Some("offline"));
        assert!(saves.begin(), "Retry clears the failure");
        assert_eq!(saves.failed(), None);
    }
}
