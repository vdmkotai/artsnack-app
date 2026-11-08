//! The one form prompts and query terms are compared in, and the per-document
//! index built from it.
//!
//! JavaScript semantics are reproduced where they decide a match: NFKC, then
//! lower case; `\p{L}` and `\p{N}` (not Rust's `is_alphanumeric`, which also
//! counts many combining marks); lengths in UTF-16 code units for the typo
//! rules.

use std::cmp::Ordering;

use icu_normalizer::{ComposingNormalizerBorrowed, DecomposingNormalizerBorrowed};
use icu_properties::{
    CodePointMapData,
    props::{GeneralCategory, GeneralCategoryGroup},
};

/// `[\p{L}\p{N}]`.
pub fn is_word_char(character: char) -> bool {
    if character.is_ascii() {
        return character.is_ascii_alphanumeric();
    }
    let category = CodePointMapData::<GeneralCategory>::new().get(character);
    GeneralCategoryGroup::Letter.contains(category)
        || GeneralCategoryGroup::Number.contains(category)
}

/// JavaScript's `\s`: WhiteSpace and LineTerminator. Unlike Rust's
/// `is_whitespace` it includes U+FEFF and leaves out U+0085.
pub fn is_js_space(character: char) -> bool {
    matches!(
        character,
        '\t' | '\n' | '\u{0B}' | '\u{0C}' | '\r' | ' ' | '\u{A0}' | '\u{1680}' | '\u{2000}'
            ..='\u{200A}'
                | '\u{2028}'
                | '\u{2029}'
                | '\u{202F}'
                | '\u{205F}'
                | '\u{3000}'
                | '\u{FEFF}'
    )
}

/// NFKC, lower case, and every run of anything but letters and digits
/// (punctuation, `_`, `-`, spaces) folded into one space, trimmed.
pub fn normalize_search_text(value: &str) -> String {
    let compatible = ComposingNormalizerBorrowed::new_nfkc().normalize(value);
    let lower = compatible.to_lowercase();
    let mut normalized = String::with_capacity(lower.len());
    let mut gap = false;
    for character in lower.chars() {
        if is_word_char(character) {
            if gap && !normalized.is_empty() {
                normalized.push(' ');
            }
            gap = false;
            normalized.push(character);
        } else {
            gap = true;
        }
    }
    normalized
}

pub fn tokenize_search_text(value: &str) -> Vec<String> {
    let normalized = normalize_search_text(value);
    if normalized.is_empty() {
        Vec::new()
    } else {
        normalized.split(' ').map(str::to_string).collect()
    }
}

/// Length in UTF-16 code units, JavaScript's `string.length`.
pub(crate) fn js_length(value: &str) -> usize {
    value.chars().map(char::len_utf16).sum()
}

/// A normalised text and its distinct tokens, built once per document.
///
/// The tokens are byte ranges into the text, sorted by token, so the index
/// costs a few bytes per word rather than a string and a hash-set entry each —
/// the catalogue is the user's whole history, all of it in memory.
#[derive(Debug)]
pub(crate) struct IndexedText {
    normalized: Box<str>,
    tokens: Box<[(u32, u32)]>,
}

impl IndexedText {
    pub fn new(text: &str) -> Self {
        let normalized = normalize_search_text(text);
        let mut tokens: Vec<(u32, u32)> = Vec::new();
        let mut start = 0usize;
        if !normalized.is_empty() {
            for (ix, character) in normalized.char_indices() {
                if character == ' ' {
                    tokens.push((start as u32, ix as u32));
                    start = ix + 1;
                }
            }
            tokens.push((start as u32, normalized.len() as u32));
        }
        tokens.sort_by(|left, right| slice(&normalized, *left).cmp(slice(&normalized, *right)));
        tokens.dedup_by(|left, right| slice(&normalized, *left) == slice(&normalized, *right));
        Self {
            normalized: normalized.into_boxed_str(),
            tokens: tokens.into_boxed_slice(),
        }
    }

    pub fn contains(&self, term: &str) -> bool {
        self.normalized.contains(term)
    }

    pub fn has_token(&self, term: &str) -> bool {
        self.tokens
            .binary_search_by(|range| slice(&self.normalized, *range).cmp(term))
            .is_ok()
    }

    /// Distinct tokens. A fuzzy match only asks whether any token is close,
    /// so their order does not matter.
    pub fn tokens(&self) -> impl Iterator<Item = &str> {
        self.tokens
            .iter()
            .map(|range| slice(&self.normalized, *range))
    }
}

fn slice(text: &str, (start, end): (u32, u32)) -> &str {
    &text[start as usize..end as usize]
}

/// A query term for the typo rule, measured once per search rather than once
/// per token it is compared with.
pub(crate) struct FuzzyTerm<'a> {
    text: &'a str,
    /// Length in UTF-16 code units.
    units: usize,
    ascii: bool,
}

impl<'a> FuzzyTerm<'a> {
    pub fn new(text: &'a str) -> Self {
        Self {
            text,
            units: js_length(text),
            ascii: text.is_ascii(),
        }
    }

    /// Length in UTF-16 code units, as the web's `term.length`.
    pub fn units(&self) -> usize {
        self.units
    }

    /// The typo rule: equal, or one insertion, deletion or substitution apart,
    /// counted in UTF-16 code units as the web counts them. Lengths are
    /// compared first, and nothing is allocated for a pair.
    pub fn is_within_one_of(&self, token: &str) -> bool {
        if self.text == token {
            return true;
        }
        if self.ascii && token.is_ascii() {
            return within_one(self.text.bytes(), self.units, token.bytes(), token.len());
        }
        let token_units = js_length(token);
        if self.units.abs_diff(token_units) > 1 {
            return false;
        }
        within_one(
            self.text.encode_utf16(),
            self.units,
            token.encode_utf16(),
            token_units,
        )
    }
}

/// [`FuzzyTerm::is_within_one_of`] for two strings.
#[cfg(test)]
pub(crate) fn edit_distance_at_most_one(left: &str, right: &str) -> bool {
    FuzzyTerm::new(left).is_within_one_of(right)
}

/// One edit at most between two sequences of `left_len` and `right_len`
/// units, walked once in step.
fn within_one<T: PartialEq>(
    left: impl Iterator<Item = T>,
    left_len: usize,
    right: impl Iterator<Item = T>,
    right_len: usize,
) -> bool {
    if left_len.abs_diff(right_len) > 1 {
        return false;
    }
    if left_len == right_len {
        // Only substitutions can bridge equal lengths.
        return left.zip(right).filter(|(a, b)| a != b).take(2).count() <= 1;
    }
    if left_len < right_len {
        one_insertion(left.peekable(), right)
    } else {
        one_insertion(right.peekable(), left)
    }
}

/// Whether `long` is `short` with at most one unit inserted.
fn one_insertion<T: PartialEq>(
    mut short: std::iter::Peekable<impl Iterator<Item = T>>,
    long: impl Iterator<Item = T>,
) -> bool {
    let mut skipped = false;
    for unit in long {
        if short.peek() == Some(&unit) {
            short.next();
        } else if skipped {
            return false;
        } else {
            skipped = true;
        }
    }
    short.next().is_none()
}

/// Spaces aside, the ASCII punctuation and symbols in the order of the CLDR
/// root collation, which `Intl.Collator()` uses for English and for every
/// locale that leaves them alone: `a_b` sorts before `a-b`, `$` after `~`.
/// Checked against Node's ICU (`orders_facet_ties_like_a_collator`).
const ASCII_PUNCTUATION: &str = "_-,;:!?.'\"()[]{}@*/\\&#%`^+<=>|~$";

/// Above every code point: one band of punctuation weights per entry of
/// [`ASCII_PUNCTUATION`].
const BAND: u32 = 0x20_0000;

/// A punctuation or symbol character's primary weight. ASCII has its CLDR
/// place; anything else follows the ASCII character of its kind (a dash after
/// `-`, a currency sign after `$`), by code point — close to CLDR for the
/// characters facet values hold, and never out of its class.
fn punctuation_weight(character: char, category: GeneralCategory) -> u32 {
    let anchor = |ascii: char| ASCII_PUNCTUATION.find(ascii).unwrap_or(0) as u32;
    if character.is_ascii()
        && let Some(ix) = ASCII_PUNCTUATION.find(character)
    {
        return ix as u32 * BAND;
    }
    let kind = match category {
        GeneralCategory::ConnectorPunctuation => '_',
        GeneralCategory::DashPunctuation => '-',
        GeneralCategory::OpenPunctuation => '(',
        GeneralCategory::ClosePunctuation => ')',
        GeneralCategory::InitialPunctuation | GeneralCategory::FinalPunctuation => '"',
        GeneralCategory::OtherPunctuation => '.',
        GeneralCategory::MathSymbol => '+',
        GeneralCategory::ModifierSymbol => '^',
        GeneralCategory::CurrencySymbol => '$',
        _ => '&',
    };
    anchor(kind) * BAND + 1 + character as u32
}

/// A sort key that orders facet values the way `Intl.Collator().compare` does
/// for the strings facets hold: spaces, then punctuation and symbols (in CLDR
/// order), then digits, then letters; letters without regard to case or
/// accents first, then accents, then lower case before upper case.
///
/// Not a full collator — there is no ICU collation data in the build — but
/// the parts facet values exercise: model, checkpoint and LoRA names.
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub(crate) struct CollationKey {
    /// Class (space, punctuation, digit, letter), then the weight within it.
    primary: Vec<(u8, u32)>,
    secondary: Vec<char>,
    tertiary: Vec<u8>,
    raw: String,
}

impl CollationKey {
    pub fn new(value: &str) -> Self {
        let decomposed = DecomposingNormalizerBorrowed::new_nfd().normalize(value);
        let mut primary = Vec::with_capacity(decomposed.len());
        let mut secondary = Vec::new();
        let mut tertiary = Vec::with_capacity(decomposed.len());
        for character in decomposed.chars() {
            let category = CodePointMapData::<GeneralCategory>::new().get(character);
            if GeneralCategoryGroup::Mark.contains(category) {
                secondary.push(character);
                continue;
            }
            let lower = character.to_lowercase().next().unwrap_or(character) as u32;
            let weight = if is_js_space(character) {
                (0, character as u32)
            } else if GeneralCategoryGroup::Number.contains(category) {
                (2, lower)
            } else if GeneralCategoryGroup::Letter.contains(category) {
                (3, lower)
            } else {
                (1, punctuation_weight(character, category))
            };
            primary.push(weight);
            tertiary.push(if character.is_uppercase() { 1 } else { 0 });
        }
        Self {
            primary,
            secondary,
            tertiary,
            raw: value.to_string(),
        }
    }
}

/// [`CollationKey`] order for two strings, when no key is cached.
#[cfg(test)]
pub(crate) fn collate(left: &str, right: &str) -> Ordering {
    CollationKey::new(left).cmp(&CollationKey::new(right))
}

/// Orders numbers as JavaScript comparators do: a `NaN` difference is "equal".
pub(crate) fn compare_numbers(left: f64, right: f64) -> Ordering {
    left.partial_cmp(&right).unwrap_or(Ordering::Equal)
}
