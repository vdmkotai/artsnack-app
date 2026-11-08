import assert from "node:assert/strict";
import test from "node:test";
import { normalizeReferenceSourceKeys } from "./generation-references";

test("reference origins preserve mixed uploads and generated outputs in slot order", () => {
  const keys = [null, "atlas/second.png", "generations/third.png", null];
  assert.deepEqual(normalizeReferenceSourceKeys(keys, 4), keys);
  assert.equal(normalizeReferenceSourceKeys(undefined, 2), undefined);
  assert.equal(normalizeReferenceSourceKeys([], 0), undefined);
});

test("invalid origins cannot shift slots or introduce external URLs", () => {
  assert.throws(() => normalizeReferenceSourceKeys(["fal/second.png"], 2));
  for (const key of [
    "https://example.com/fal/x.png",
    "blob:upload",
    "fal/../private",
    "fal/x?token=secret",
    "grok-references/copy.jpg",
  ]) {
    assert.throws(() => normalizeReferenceSourceKeys([key], 1));
  }
});
