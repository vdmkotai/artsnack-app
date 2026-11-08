import assert from "node:assert/strict";
import test from "node:test";

import { getAtlasModel } from "./atlas-models";
import { validateAtlasReferences } from "./atlas-reference-validation";

test("Seedance 2.5 rejects an over-wide reference before submit", () => {
  const model = getAtlasModel("bytedance/seedance-2.5/reference-to-video");
  const issues = validateAtlasReferences(model, [{ width: 3000, height: 1000, bytes: 1_000 }]);

  assert.deepEqual(
    issues.map((issue) => issue.code),
    ["aspect"],
  );
  assert.match(issues[0].message, /too wide \(3:1\)/);
  assert.match(issues[0].message, /accepts 1:2\.5–2\.5:1/);
  assert.match(issues[0].message, /still attached/);
});

test("Seedance 2.5 accepts its exact aspect and dimension boundaries", () => {
  const model = getAtlasModel("bytedance/seedance-2.5/reference-to-video");
  assert.deepEqual(
    validateAtlasReferences(model, [
      { width: 300, height: 750, bytes: 29 * 1024 * 1024 },
      { width: 6000, height: 2400, bytes: 1_000 },
    ]),
    [],
  );
});

test("Seedance reports dimensions and file size independently", () => {
  const model = getAtlasModel("bytedance/seedance-2.5/reference-to-video");
  const issues = validateAtlasReferences(model, [
    { width: 299, height: 300, bytes: 31 * 1024 * 1024 },
  ]);
  assert.deepEqual(
    issues.map((issue) => issue.code),
    ["dimensions", "file-size"],
  );
});

test("Seedance's strict under-30MB limit rejects exactly 30MB", () => {
  const model = getAtlasModel("bytedance/seedance-2.5/reference-to-video");
  const issues = validateAtlasReferences(model, [
    { width: 1000, height: 1000, bytes: 30 * 1024 * 1024 },
  ]);
  assert.equal(issues[0]?.code, "file-size");
  assert.match(issues[0].message, /under 30MB/);
});

test("positional frame slots use each parameter's inherited limits", () => {
  const model = getAtlasModel("bytedance/seedance-2.5/image-to-video");
  const issues = validateAtlasReferences(model, [
    { width: 1000, height: 1000 },
    { width: 3000, height: 1000 },
  ]);
  assert.equal(issues.length, 1);
  assert.equal(issues[0].referenceIndex, 1);
  assert.equal(issues[0].paramName, "last_image");
  assert.equal(issues[0].code, "aspect");
});

test("different Atlas models keep their own input ranges", () => {
  const seedance = getAtlasModel("bytedance/seedance-2.5/image-to-video");
  const wan = getAtlasModel("alibaba/wan-2.7/image-to-video");
  const wide = { width: 7000, height: 1000, bytes: 1_000 };

  assert.equal(validateAtlasReferences(seedance, [wide])[0]?.code, "aspect");
  assert.deepEqual(validateAtlasReferences(wan, [wide]), []);
});

test("legacy metadata can still validate aspect ratio", () => {
  const model = getAtlasModel("bytedance/seedance-2.5/reference-to-video");
  assert.equal(validateAtlasReferences(model, [{ aspect: 4 }])[0]?.code, "aspect");
});

test("Wan 3.0 enforces its edge, aspect, and 20MB image limits", () => {
  const model = getAtlasModel("alibaba/wan-3.0/image-to-video");
  assert.deepEqual(
    validateAtlasReferences(model, [{ width: 8000, height: 1000, bytes: 20 * 1024 * 1024 }]),
    [],
  );

  const issues = validateAtlasReferences(model, [
    { width: 9000, height: 1000, bytes: 20 * 1024 * 1024 + 1 },
  ]);
  assert.deepEqual(issues.map((issue) => issue.code).sort(), ["aspect", "dimensions", "file-size"]);
});

test("Wan 3.0 applies the first-frame limits to its optional last frame", () => {
  const model = getAtlasModel("alibaba/wan-3.0/image-to-video");
  const issues = validateAtlasReferences(model, [
    { width: 1000, height: 1000, bytes: 1_000 },
    { width: 9000, height: 1000, bytes: 20 * 1024 * 1024 + 1 },
  ]);

  assert.ok(issues.length > 0);
  assert.ok(issues.every((issue) => issue.referenceIndex === 1));
  assert.ok(issues.every((issue) => issue.paramName === "last_image"));
  assert.deepEqual(issues.map((issue) => issue.code).sort(), ["aspect", "dimensions", "file-size"]);
});

test("Wan 3.0 accepts 1:8 exactly and rejects a taller image", () => {
  const model = getAtlasModel("alibaba/wan-3.0/image-to-video");
  assert.deepEqual(validateAtlasReferences(model, [{ width: 1000, height: 8000 }]), []);
  assert.equal(validateAtlasReferences(model, [{ width: 999, height: 8000 }])[0]?.code, "aspect");
});
