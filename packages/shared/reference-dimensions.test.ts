import assert from "node:assert/strict";
import { test } from "node:test";
import { referenceDimensions } from "./reference-dimensions";

test("portrait and landscape references fit both provider edges", () => {
  assert.deepEqual(referenceDimensions(1024, 2048, "grok"), { width: 384, height: 768 });
  assert.deepEqual(referenceDimensions(2048, 1024, "grok"), { width: 768, height: 384 });
  assert.deepEqual(referenceDimensions(100, 100, "grok"), { width: 256, height: 256 });
  assert.deepEqual(referenceDimensions(100, 10000, "grok"), { width: 256, height: 768 });
  assert.deepEqual(referenceDimensions(1024, 2048, "fal"), { width: 1024, height: 2048 });
  assert.throws(() => referenceDimensions(0, 100, "grok"));
});
