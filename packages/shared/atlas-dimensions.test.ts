import assert from "node:assert/strict";
import test from "node:test";

import { ATLAS_MODELS, atlasParam, getAtlasModel, type AtlasParam } from "./atlas-models";
import {
  ATLAS_RATIOS,
  ATLAS_SIZE_TIERS,
  clampDimensions,
  dimensionsFor,
  dimensionPresets,
  formatDimensions,
  matchPreset,
  parseDimensions,
} from "./atlas-dimensions";

const plain: AtlasParam = { name: "size", kind: "dimensions", label: "Size", required: false };

test("dimensions round-trip through the vendor's spelling", () => {
  assert.deepEqual(parseDimensions("1024*1024"), { width: 1024, height: 1024 });
  // Tolerated on input because people type them; never produced on output.
  assert.deepEqual(parseDimensions(" 1280 x 720 "), { width: 1280, height: 720 });
  assert.deepEqual(parseDimensions("1280×720"), { width: 1280, height: 720 });
  assert.equal(formatDimensions({ width: 1280, height: 720 }), "1280*720");

  assert.equal(parseDimensions("large"), null);
  assert.equal(parseDimensions(""), null);
  assert.equal(parseDimensions(undefined), null);
});

test("every preset is a legal size for its model", () => {
  for (const model of ATLAS_MODELS) {
    for (const param of model.params) {
      if (param.kind !== "dimensions") continue;
      const minSide = param.minSide ?? 512;
      const maxSide = param.maxSide ?? 2048;
      for (const tier of ATLAS_SIZE_TIERS) {
        for (const preset of dimensionPresets(param, tier.value)) {
          const { width, height } = preset.size;
          assert.ok(width % 16 === 0 && height % 16 === 0, `${model.id} ${preset.value} off-grid`);
          assert.ok(width >= minSide && height >= minSide, `${model.id} ${preset.value} too small`);
          assert.ok(width <= maxSide && height <= maxSide, `${model.id} ${preset.value} too large`);
          if (param.maxPixels) {
            assert.ok(
              width * height <= param.maxPixels,
              `${model.id} ${preset.value} is ${width * height}px, over ${param.maxPixels}`,
            );
          }
        }
      }
    }
  }
});

test("the area cap scales both sides, keeping the shape the user picked", () => {
  // The two MAI endpoints cap the product at 1,049,088 with a minimum side of
  // 768 — a combination no default preset satisfies by accident.
  const model = getAtlasModel("microsoft/mai-image-2.5/text-to-image");
  const param = atlasParam(model, "size");
  assert.ok(param && param.kind === "dimensions");

  const wide = dimensionsFor(param, "16:9", "2K");
  assert.ok(wide.width * wide.height <= param.maxPixels!, "area cap ignored");
  // Still recognisably 16:9 rather than squashed to the nearest legal box.
  assert.ok(Math.abs(wide.width / wide.height - 16 / 9) < 0.25, `got ${wide.width}x${wide.height}`);
});

test("a preset is recognised on the way back in, and a hand-typed size is not", () => {
  const preset = dimensionsFor(plain, "16:9", "1K");
  const matched = matchPreset(plain, formatDimensions(preset));
  assert.deepEqual(matched, { ratio: "16:9", tier: "1K" });

  // A number the user typed must not light up a preset it does not equal, or
  // changing the tier would silently move them off their own size.
  assert.equal(matchPreset(plain, "1200*800"), null);
});

test("hand-typed sizes are snapped and clamped, not rejected", () => {
  assert.deepEqual(clampDimensions(plain, "1000*1000"), { width: 1008, height: 1008 });
  assert.deepEqual(clampDimensions(plain, "99999*99999"), { width: 2048, height: 2048 });
  assert.deepEqual(clampDimensions(plain, "10*10"), { width: 512, height: 512 });
  assert.equal(clampDimensions(plain, "nonsense"), null);
});

test("every ratio is offered and every one is distinct", () => {
  const presets = dimensionPresets(plain, "1K");
  assert.equal(presets.length, ATLAS_RATIOS.length);
  assert.equal(new Set(presets.map((preset) => preset.value)).size, presets.length);
});

test("a ratio a model cannot produce is not offered", () => {
  // MAI wants a minimum side of 768 and caps the area at 1,049,088. 21:9 needs
  // 1792x768 to clear the minimum, which is 1.38MP — impossible at any scale.
  const model = getAtlasModel("microsoft/mai-image-2.5/text-to-image");
  const param = atlasParam(model, "size");
  assert.ok(param && param.kind === "dimensions");

  const ratios = dimensionPresets(param, "2K").map((preset) => preset.ratio);
  assert.ok(!ratios.includes("21:9"), "21:9 cannot exist here and must not be offered");
  assert.ok(ratios.includes("1:1"), "square must always survive");

  // A model that states no limits keeps the full set.
  assert.equal(dimensionPresets(plain, "1K").length, ATLAS_RATIOS.length);
});

test("every model with a size picker offers at least one ratio", () => {
  for (const model of ATLAS_MODELS) {
    for (const param of model.params) {
      if (param.kind !== "dimensions") continue;
      assert.ok(
        dimensionPresets(param, "1K").length > 0,
        `${model.id} has a size control with nothing in it`,
      );
    }
  }
});
