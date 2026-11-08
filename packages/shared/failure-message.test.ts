import assert from "node:assert/strict";
import test from "node:test";

import { describeFailure } from "./failure-message";

/** The shape that actually reached the grid: our prose, then fal's JSON, cut
 *  off mid-object by the 300-character clamp in classifyFalFailure. */
const MODERATION_ERROR =
  'Prompt rejected by ByteDance moderation: {"detail":[{"loc":["body","image"],"msg":"The content could not be processed because it contained material flagged by a content policy violation","url":"https://docs.fal.ai/errors#content_policy_violation","ct';

test("pulls the human sentence out of a truncated JSON body", () => {
  const { summary, hasMore } = describeFailure(MODERATION_ERROR);
  assert.equal(
    summary,
    "The content could not be processed because it contained material flagged by a content policy violation",
  );
  // No braces, no escaped quotes, no url.
  assert.ok(!summary.includes("{"));
  assert.ok(!summary.includes('"'));
  assert.ok(!summary.includes("http"));
  assert.equal(hasMore, true);
});

test("the full text is preserved for the details popover", () => {
  assert.equal(describeFailure(MODERATION_ERROR).full, MODERATION_ERROR);
});

test("several distinct messages are joined, duplicates dropped", () => {
  const raw =
    '{"detail":[{"msg":"The first thing went wrong"},{"msg":"The second thing went wrong"},{"msg":"The first thing went wrong"}]}';
  assert.equal(
    describeFailure(raw).summary,
    "The first thing went wrong · The second thing went wrong",
  );
});

test("machine-facing values are not mistaken for prose", () => {
  const raw = '{"detail":[{"msg":"content_policy_violation","url":"https://docs.fal.ai/errors"}]}';
  // Neither the code nor the url qualifies, so the prose prefix is used —
  // here there is none, so the raw text stands rather than a misleading token.
  assert.ok(!describeFailure(raw).summary.startsWith("content_policy_violation"));
});

test("a plain message is left alone and needs no popover", () => {
  const raw = "fal account is out of balance — top it up to keep generating";
  assert.deepEqual(describeFailure(raw), { summary: raw, full: raw, hasMore: false });
});

test("prose before the payload is used when the payload has no sentence", () => {
  const raw = 'fal rejected the request (HTTP 422): {"detail":[{"loc":["body","image_size"]}]}';
  assert.equal(describeFailure(raw).summary, "fal rejected the request (HTTP 422)");
  assert.equal(describeFailure(raw).hasMore, true);
});

test("escaped quotes and newlines are unescaped", () => {
  const raw = String.raw`{"msg":"The value \"image_size\" is invalid\nand was rejected"}`;
  assert.equal(describeFailure(raw).summary, 'The value "image_size" is invalid and was rejected');
});

test("an over-long sentence is clamped for the tile but kept in full", () => {
  const sentence = `${"a very long explanation ".repeat(20)}end`;
  const { summary, full, hasMore } = describeFailure(`{"msg":"${sentence}"}`);
  assert.ok(summary.length <= 161, `summary was ${summary.length} chars`);
  assert.ok(summary.endsWith("…"));
  assert.ok(full.includes("end"));
  assert.equal(hasMore, true);
});

test("a missing or empty error still renders something", () => {
  assert.equal(describeFailure(undefined).summary, "Unknown error");
  assert.equal(describeFailure("").summary, "Unknown error");
  assert.equal(describeFailure("   ").hasMore, false);
});
