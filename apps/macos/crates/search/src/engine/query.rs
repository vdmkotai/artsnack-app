//! The query language (`parseSearchQuery`):
//!
//! ```text
//! dog beach          AND (a comma works too)
//! dog|fox beach    OR inside one requirement
//! -scarf              broad exclusion
//! "dog"              exact token
//! "red dress"         exact phrase
//! ```
//!
//! Parentheses are rejected on purpose: silently interpreting a malformed
//! query is worse than saying where it stopped making sense.

use std::{fmt, sync::Arc};

use super::text::{is_js_space, is_word_char, normalize_search_text};

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SearchTerm {
    /// Normalised.
    pub value: Arc<str>,
    pub quoted: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SearchGroup {
    pub excluded: bool,
    pub alternatives: Vec<SearchTerm>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ParsedSearchQuery {
    pub groups: Vec<SearchGroup>,
    /// Each requirement as the echo under the input shows it: `dog OR fox`.
    pub required: Vec<String>,
    pub excluded: Vec<String>,
}

/// Where a query stopped making sense.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SearchSyntaxError {
    pub message: &'static str,
    /// Offset in UTF-16 code units, as the web reports it.
    pub at: usize,
}

impl fmt::Display for SearchSyntaxError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.message)
    }
}

impl std::error::Error for SearchSyntaxError {}

pub fn parse_search_query(input: &str) -> Result<ParsedSearchQuery, SearchSyntaxError> {
    let chars: Vec<char> = input.chars().collect();
    // Error offsets are reported in UTF-16 units; most queries are ASCII.
    let offset = |ix: usize| {
        chars[..ix.min(chars.len())]
            .iter()
            .map(|c| c.len_utf16())
            .sum()
    };
    let fail = |message: &'static str, ix: usize| {
        Err(SearchSyntaxError {
            message,
            at: offset(ix),
        })
    };
    let at = |ix: usize| chars.get(ix).copied();
    let is_separator = |ix: usize| matches!(at(ix), Some(c) if c == ',' || is_js_space(c));

    let mut groups = Vec::new();
    let mut ix = 0;
    while is_separator(ix) {
        ix += 1;
    }
    while ix < chars.len() {
        let start = ix;
        let mut excluded = false;
        if at(ix) == Some('-') {
            excluded = true;
            ix += 1;
            if ix >= chars.len() || is_separator(ix) {
                return fail(
                    "Add a word or quoted phrase after \u{2018}-\u{2019}.",
                    start,
                );
            }
        }

        let mut alternatives = Vec::new();
        loop {
            if at(ix) == Some('-') {
                return fail(
                    "Put \u{2018}-\u{2019} before the whole excluded expression, not after \u{2018}|\u{2019}.",
                    ix,
                );
            }

            let quoted;
            let mut raw = String::new();
            if at(ix) == Some('"') {
                quoted = true;
                let quote_start = ix;
                ix += 1;
                while ix < chars.len() && chars[ix] != '"' {
                    raw.push(chars[ix]);
                    ix += 1;
                }
                if ix >= chars.len() {
                    return fail("Close the quoted phrase with another quote.", quote_start);
                }
                ix += 1;
            } else {
                quoted = false;
                let value_start = ix;
                while let Some(c) = at(ix) {
                    if c == '|' || c == ',' || is_js_space(c) {
                        break;
                    }
                    if c == '"' {
                        return fail("A quote must start a new term.", ix);
                    }
                    if c == '(' || c == ')' {
                        return fail(
                            "Parentheses are not supported. Use \u{2018}|\u{2019} for alternatives.",
                            ix,
                        );
                    }
                    raw.push(c);
                    ix += 1;
                }
                if ix == value_start {
                    return fail("Expected a search term.", ix);
                }
            }

            let value = normalize_search_text(&raw);
            if value.is_empty() || !value.chars().any(is_word_char) {
                return fail("A search term must contain a letter or number.", start);
            }
            alternatives.push(SearchTerm {
                value: value.into(),
                quoted,
            });

            if at(ix) != Some('|') {
                break;
            }
            ix += 1;
            match at(ix) {
                None => return fail("Add an alternative after \u{2018}|\u{2019}.", ix),
                Some(c) if c == ',' || c == '|' || is_js_space(c) => {
                    return fail("Add an alternative after \u{2018}|\u{2019}.", ix);
                }
                Some(_) => {}
            }
        }

        groups.push(SearchGroup {
            excluded,
            alternatives,
        });
        while is_separator(ix) {
            ix += 1;
        }
    }

    let describe = |group: &SearchGroup| {
        group
            .alternatives
            .iter()
            .map(|term| {
                if term.quoted {
                    format!("\u{201c}{}\u{201d}", term.value)
                } else {
                    term.value.to_string()
                }
            })
            .collect::<Vec<_>>()
            .join(" OR ")
    };
    let required = groups
        .iter()
        .filter(|group| !group.excluded)
        .map(describe)
        .collect();
    let excluded = groups
        .iter()
        .filter(|group| group.excluded)
        .map(describe)
        .collect();
    Ok(ParsedSearchQuery {
        groups,
        required,
        excluded,
    })
}
