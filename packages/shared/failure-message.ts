/**
 * Turns a vendor error into something a result tile can show.
 *
 * fal reports rejections as a JSON body, which we store verbatim because it is
 * the only record of what actually happened. It is not, however, something to
 * put in front of someone — it arrives as one unbroken string of braces and
 * escaped quotes, and our own classifier has already truncated it mid-object.
 * So the tile gets the human sentence buried inside it, and the full text moves
 * behind a "Details" popover.
 */

const MAX_SUMMARY_LENGTH = 160;

/** Matches "msg": "…" and friends even in JSON we truncated mid-object. */
const MESSAGE_FIELD = /"(?:msg|message|detail|error)"\s*:\s*"((?:[^"\\]|\\.)*)"/g;

export type FailureMessage = {
  /** One readable line for the tile. */
  summary: string;
  /** The original text, for the popover. */
  full: string;
  /** True when the popover would show more than the summary does. */
  hasMore: boolean;
};

function unescapeJsonString(value: string): string {
  return value
    .replace(/\\"/g, '"')
    .replace(/\\n/g, " ")
    .replace(/\\t/g, " ")
    .replace(/\\\\/g, "\\")
    .replace(/\s+/g, " ")
    .trim();
}

/** Human sentences hidden inside the payload, deduplicated and joined. */
function extractMessages(raw: string): string[] {
  const found = new Set<string>();
  for (const match of raw.matchAll(MESSAGE_FIELD)) {
    const value = unescapeJsonString(match[1]);
    // Skip machine-facing values: error codes, urls, single tokens.
    if (value.length < 12 || /^https?:\/\//.test(value) || !value.includes(" ")) continue;
    found.add(value);
  }
  return [...found];
}

/** The prose fal's payload was appended to, e.g. "Prompt rejected by …". */
function leadingProse(raw: string): string {
  const jsonStart = raw.search(/[[{]/);
  const prefix = (jsonStart === -1 ? raw : raw.slice(0, jsonStart)).trim();
  return prefix.replace(/[:\s]+$/, "");
}

export function describeFailure(raw: string | undefined): FailureMessage {
  const full = (raw ?? "").trim();
  if (!full) {
    return { summary: "Unknown error", full: "Unknown error", hasMore: false };
  }

  const messages = extractMessages(full);
  const candidate = messages.length > 0 ? messages.join(" · ") : leadingProse(full) || full;

  const summary =
    candidate.length > MAX_SUMMARY_LENGTH
      ? `${candidate.slice(0, MAX_SUMMARY_LENGTH).trimEnd()}…`
      : candidate;

  return { summary, full, hasMore: summary !== full };
}
