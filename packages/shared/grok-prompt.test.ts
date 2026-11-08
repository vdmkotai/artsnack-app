import assert from "node:assert/strict";
import test from "node:test";

import {
  getGrokMentionAtCaret,
  getGrokReferenceTagIndices,
  replaceGrokMention,
  restoreGrokReferenceTags,
  toGrokApiPrompt,
  toSeedanceApiPrompt,
  toTitleCaseOrdinalApiPrompt,
} from "./grok-prompt";

const taggedPrompt = "put @image1 into the pose @image2 while keeping the clothes from @image1";

test("normalizes reference tags only at the Grok API boundary", () => {
  assert.equal(
    toGrokApiPrompt(taggedPrompt),
    "put image 1 into the pose image 2 while keeping the clothes from image 1",
  );
  assert.deepEqual(getGrokReferenceTagIndices(taggedPrompt), [1, 2, 1]);
});

test("renders title-cased ordinal references for Wan 3.0", () => {
  assert.equal(
    toTitleCaseOrdinalApiPrompt("the person from @image1 enters the room from @image2"),
    "the person from Image 1 enters the room from Image 2",
  );
});

test("keeps reference tags for Seedance, which uses them natively", () => {
  assert.equal(
    toSeedanceApiPrompt(taggedPrompt),
    "put @Image1 into the pose @Image2 while keeping the clothes from @Image1",
  );
  // Spelling is normalised, and re-running changes nothing.
  assert.equal(toSeedanceApiPrompt("@image 3 and @IMAGE4"), "@Image3 and @Image4");
  assert.equal(
    toSeedanceApiPrompt(toSeedanceApiPrompt(taggedPrompt)),
    toSeedanceApiPrompt(taggedPrompt),
  );
  // An untagged prompt is untouched.
  assert.equal(toSeedanceApiPrompt("a plain prompt"), "a plain prompt");
});

test("restores tags in legacy prompts when persisted references are available", () => {
  assert.equal(
    restoreGrokReferenceTags("put image 1 into the pose image 2", 2),
    "put @image1 into the pose @image2",
  );
  assert.equal(restoreGrokReferenceTags(taggedPrompt, 2), taggedPrompt);
  assert.equal(
    restoreGrokReferenceTags("keep image 3 in the background", 2),
    "keep image 3 in the background",
  );
});

test("selects an entire existing reference tag from any caret position", () => {
  const prompt = "use @image1 here";
  assert.deepEqual(getGrokMentionAtCaret(prompt, 8), {
    start: 4,
    end: 11,
    query: "",
  });
  assert.deepEqual(getGrokMentionAtCaret(prompt, 11), {
    start: 4,
    end: 11,
    query: "",
  });
});

test("tracks only the typed prefix for a new reference tag", () => {
  assert.deepEqual(getGrokMentionAtCaret("use @ima", 8), {
    start: 4,
    end: 8,
    query: "ima",
  });
});

test("replaces a complete reference tag without changing surrounding spaces", () => {
  assert.deepEqual(replaceGrokMention("use @image1 here", { start: 4, end: 11, query: "" }, 2), {
    value: "use @image2 here",
    caret: 11,
  });
  assert.deepEqual(replaceGrokMention("use @ima", { start: 4, end: 8, query: "ima" }, 2), {
    value: "use @image2 ",
    caret: 12,
  });
});
