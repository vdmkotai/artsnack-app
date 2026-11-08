import assert from "node:assert/strict";
import test from "node:test";
import { atlasDefaults, getAtlasModel } from "./atlas-models";
import { buildAtlasRequest } from "./atlas-payload";
import { TENCENT_UPSCALER, tencentLongEdge, tencentOutputSize } from "./tencent-upscale";

const defaults = atlasDefaults(getAtlasModel(TENCENT_UPSCALER));
const request = (params: typeof defaults) =>
  buildAtlasRequest({
    model: TENCENT_UPSCALER,
    params,
    referenceUrls: ["https://media.example/source.png"],
  }).body;

test("5K preserves landscape, portrait and square proportions", () => {
  for (const [source, expected] of [
    [
      { width: 2048, height: 1536 },
      { width: 5120, height: 3840 },
    ],
    [
      { width: 1536, height: 2048 },
      { width: 3840, height: 5120 },
    ],
    [
      { width: 2048, height: 2048 },
      { width: 5120, height: 5120 },
    ],
    [
      { width: 2560, height: 1440 },
      { width: 5120, height: 2880 },
    ],
  ])
    assert.deepEqual(tencentOutputSize(tencentLongEdge(5120), source), expected);
});

test("7.5 is a multiplier and the preview exposes the actual large output", () => {
  assert.deepEqual(
    tencentOutputSize({ ...defaults, percent: 7.5 }, { width: 2048, height: 1536 }),
    { width: 15360, height: 11520 },
  );
});

test("scale mode does not send one-pixel placeholders or stale dimension targets", () => {
  const body = request({ ...defaults, percent: 7.5, width: 5120, long_side: 8192 });
  assert.equal(body.percent, 7.5);
  for (const key of ["width", "height", "long_side", "short_side"]) assert.ok(!(key in body));
  assert.equal(body.image_url, "https://media.example/source.png");
});

test("5K preset replaces a saved stretch request and excludes the stale multiplier", () => {
  const params = {
    ...defaults,
    mode: "fixed",
    width: 9000,
    height: 3000,
    short_side: 6000,
    percent: 7.5,
    ...tencentLongEdge(5120),
  };
  const body = request(params);
  assert.equal(body.mode, "aspect");
  assert.equal(body.long_side, 5120);
  for (const key of ["percent", "width", "height", "short_side"]) assert.ok(!(key in body));
});

test("legacy fixed settings do not claim an aspect-preserving preview", () => {
  const params = { ...defaults, mode: "fixed", width: 5000, height: 2000 };
  assert.equal(tencentOutputSize(params, { width: 2048, height: 2048 }), null);
  const body = request(params);
  assert.equal(body.width, 5000);
  assert.equal(body.height, 2000);
  assert.ok(!("long_side" in body));
});

test("unknown source dimensions and conflicting legacy targets are not guessed", () => {
  assert.equal(tencentOutputSize(tencentLongEdge(5120)), null);
  assert.equal(
    tencentOutputSize(
      { mode: "aspect", width: 3000, long_side: 5120 },
      { width: 2048, height: 1024 },
    ),
    null,
  );
  assert.throws(() => request({ ...defaults, mode: "aspect" }), /Choose an output size/);
});
