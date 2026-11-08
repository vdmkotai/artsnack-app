import assert from "node:assert/strict";
import { test } from "node:test";
import { parseStoredReferences } from "./reference-store";

const ref = (over: Record<string, unknown> = {}) => ({
  id: "a1",
  blob: new Blob(["x"], { type: "image/jpeg" }),
  aspect: 1.5,
  selected: true,
  ...over,
});

test("keeps a well-formed reference", () => {
  const input = [ref()];
  const parsed = parseStoredReferences(input);
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].id, "a1");
  assert.equal(parsed[0].selected, true);
  assert.equal(parsed[0].aspect, 1.5);
});

test("keeps optional prepared dimensions for model preflight", () => {
  const parsed = parseStoredReferences([ref({ width: 2048, height: 819 })]);
  assert.equal(parsed[0].width, 2048);
  assert.equal(parsed[0].height, 819);
});

test("preserves selected: false rather than defaulting it true", () => {
  const parsed = parseStoredReferences([ref({ selected: false })]);
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].selected, false);
});

test("returns empty for anything that is not an array", () => {
  for (const value of [undefined, null, 0, "", {}, new Blob([])]) {
    assert.deepEqual(parseStoredReferences(value), []);
  }
});

test("drops entries whose shape drifted", () => {
  const cases: Array<Record<string, unknown>> = [
    { id: 1 }, // id retyped
    { blob: "not-a-blob" }, // blob serialised away
    { aspect: "1.5" }, // aspect retyped
    { aspect: Number.NaN }, // aspect unusable — would break sizing
    { aspect: Number.POSITIVE_INFINITY },
    { width: "2048" },
    { height: Number.NaN },
    { selected: "true" }, // selected retyped
  ];
  for (const over of cases) {
    assert.deepEqual(parseStoredReferences([ref(over)]), [], JSON.stringify(over));
  }
  assert.deepEqual(parseStoredReferences([null, undefined, 42]), []);
});

test("keeps the good entries when only some drifted", () => {
  const parsed = parseStoredReferences([
    ref({ id: "keep" }),
    ref({ blob: null }),
    ref({ id: "also" }),
  ]);
  assert.deepEqual(
    parsed.map((r) => r.id),
    ["keep", "also"],
  );
});

test("preserves the original image address across reference persistence", () => {
  const sourceUrl = "/api/images/generations/original.png";
  const parsed = parseStoredReferences([ref({ sourceUrl }), ref({ id: "legacy" })]);
  assert.equal(parsed[0].sourceUrl, sourceUrl);
  assert.equal(parsed[1].sourceUrl, undefined);
  assert.deepEqual(parseStoredReferences([ref({ sourceUrl: 42 })]), []);
});
