/**
 * The `@imageN` reference tags the prompt editor writes, and their translation
 * at each vendor boundary.
 *
 * Two questions this module deliberately does not answer:
 *
 * A tag that points past the attached references — `@image3` with two selected
 * — is **not** clamped or dropped here. Provider payload builders refuse it
 * with a message naming the offending index, because silently renumbering or
 * deleting part of someone's prompt is worse than refusing to run it. So by
 * the time `toGrokApiPrompt`/`toSeedanceApiPrompt` see a prompt, every index in
 * it is known to be in range, and they translate whatever they are given.
 *
 * An unrelated `@` — a handle, an email — is left alone by every function here:
 * only `@` immediately followed by `image` and digits matches. The editor's
 * `getGrokMentionAtCaret` is the exception, and only while the caret sits in
 * that token: it treats any alphanumeric `@word` as an in-progress mention so
 * the picker can filter on it, and the picker is dismissable.
 */
const GROK_REFERENCE_TAG_REGEX = /@image\s?(\d+)\b/gi;

export type GrokMentionRange = { start: number; end: number; query: string };

export function getGrokMentionAtCaret(prompt: string, caret: number): GrokMentionRange | null {
  for (const match of prompt.matchAll(GROK_REFERENCE_TAG_REGEX)) {
    const start = match.index;
    const end = start + match[0].length;
    if (caret >= start && caret <= end) return { start, end, query: "" };
  }

  let start = caret;
  while (start > 0 && !/\s/.test(prompt[start - 1])) start--;
  const token = prompt.slice(start, caret);
  if (!token.startsWith("@")) return null;
  const query = token.slice(1);
  if (!/^[a-zA-Z0-9]*$/.test(query)) return null;
  return { start, end: caret, query: query.toLowerCase() };
}

export function replaceGrokMention(
  prompt: string,
  mention: GrokMentionRange,
  referenceIndex: number,
): { value: string; caret: number } {
  const current = prompt.slice(mention.start, mention.end);
  const isExistingMention = /^@image\s?\d+\b$/i.test(current);
  const replacement = `@image${referenceIndex}${isExistingMention ? "" : " "}`;
  return {
    value: prompt.slice(0, mention.start) + replacement + prompt.slice(mention.end),
    caret: mention.start + replacement.length,
  };
}

/**
 * Every tag in `prompt` with its range (UTF-16, as JavaScript indexes strings)
 * and the 1-based reference it names — what an editor needs to mark the tags
 * up without re-stating the pattern.
 */
export function findReferenceTags(
  prompt: string,
): { start: number; end: number; referenceIndex: number }[] {
  return [...prompt.matchAll(GROK_REFERENCE_TAG_REGEX)].map((match) => ({
    start: match.index,
    end: match.index + match[0].length,
    referenceIndex: Number(match[1]),
  }));
}

export function getGrokReferenceTagIndices(prompt: string): number[] {
  return [...prompt.matchAll(GROK_REFERENCE_TAG_REGEX)].map((match) => Number(match[1]));
}

/**
 * Removes the editor's tags entirely.
 *
 * For the models that take an ordered reference list and parse nothing out of
 * the prompt — every image-edit endpoint in Atlas's catalogue. Leaving a tag in
 * would send `@image1` as three words of instruction. The surrounding spacing
 * is tidied so "a girl @image1 walks" does not become "a girl  walks".
 */
export function stripReferenceTags(prompt: string): string {
  return prompt.replace(/\s*@image\s?\d+\b/gi, "").replace(/[ \t]{2,}/g, " ");
}

export function toGrokApiPrompt(prompt: string): string {
  return prompt.replace(GROK_REFERENCE_TAG_REGEX, "image $1");
}

/**
 * `toGrokApiPrompt` through a renumbering: `ordinals[n - 1]` is the `image N`
 * that `@imageN` becomes. Grok video numbers a pinned first frame and then the
 * references, so once frames are pinned the editor's positions and the API's
 * ordinals stop being the same numbers. A tag with no ordinal keeps its own —
 * callers refuse those before sending (grokVideoIssues).
 */
export function toGrokApiPromptMapped(
  prompt: string,
  ordinals: readonly (number | null)[],
): string {
  return prompt.replace(GROK_REFERENCE_TAG_REGEX, (_match, index: string) => {
    const ordinal = ordinals[Number(index) - 1];
    return `image ${ordinal ?? index}`;
  });
}

/** Converts editor tags to the title-cased ordinal syntax Wan 3.0 documents. */
export function toTitleCaseOrdinalApiPrompt(prompt: string): string {
  return prompt.replace(GROK_REFERENCE_TAG_REGEX, "Image $1");
}

/**
 * Seedance's reference-to-video endpoint documents `@Image1`, `@Image2` tags in
 * the prompt itself, which is the same idea as our editor's tags — only the
 * capital I differs. So unlike Grok and Seedream, we keep the marker and just
 * normalise its spelling.
 */
export function toSeedanceApiPrompt(prompt: string): string {
  return prompt.replace(GROK_REFERENCE_TAG_REGEX, (_match, index: string) => `@Image${index}`);
}

/**
 * Inverse of `toGrokApiPrompt`, for reloading a stored generation back into the
 * editor. It gives up rather than guesses: a prompt that already carries any
 * `@imageN` tag is returned untouched, and a bare "image 4" with three
 * references stays prose, because it is at least as likely to be the subject of
 * the sentence as a lost tag.
 */
export function restoreGrokReferenceTags(prompt: string, referenceCount: number): string {
  if (referenceCount < 1 || getGrokReferenceTagIndices(prompt).length > 0) return prompt;

  return prompt.replace(/\bimage\s+(\d+)\b/gi, (match, index: string) => {
    const referenceIndex = Number(index);
    return referenceIndex >= 1 && referenceIndex <= referenceCount
      ? `@image${referenceIndex}`
      : match;
  });
}
