import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildH3VideoWorkflow,
  H3_BASE_FILES,
  H3_EXTRA_FILES,
  normalizeH3Settings,
} from "./h3-video";
import { buildLtxVideoWorkflow, LTX_BASE_FILES, normalizeLtxSettings } from "./ltx-video";
import { graphModelFiles } from "./video-graph-files";

const opts = { seed: 1, filenamePrefix: "t" };

test("an H3 graph with add-ons names the encoder, RIFE and upscaler it needs", () => {
  const graph = buildH3VideoWorkflow(
    normalizeH3Settings({ prompt: "x", interpolate: true, upscale: true }),
    {},
    opts,
  );
  const files = graphModelFiles(graph).map((entry) => entry.file);
  assert.ok(files.includes(H3_BASE_FILES.textEncoder));
  assert.ok(files.includes(H3_EXTRA_FILES.rife));
  assert.ok(files.includes(H3_EXTRA_FILES.latentUpscaler));
});

test("an LTX graph names its whole base set, once each", () => {
  const files = graphModelFiles(
    buildLtxVideoWorkflow(normalizeLtxSettings({ prompt: "x" }), {}, opts),
  );
  for (const file of [
    LTX_BASE_FILES.gemma,
    LTX_BASE_FILES.textProjection,
    LTX_BASE_FILES.videoVae,
    LTX_BASE_FILES.audioVae,
    LTX_BASE_FILES.spatialUpscaler,
  ]) {
    assert.ok(
      files.some((entry) => entry.file === file),
      file,
    );
  }
  const keys = files.map((entry) => `${entry.node}/${entry.input}/${entry.file}`);
  assert.equal(new Set(keys).size, keys.length);
});
