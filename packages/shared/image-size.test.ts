import assert from "node:assert/strict";
import { test } from "node:test";
import {
  IMAGE_SIZE_PRESETS,
  matchingSizePreset,
  presetSizes,
  resizeLocked,
  snapDimension,
} from "./image-size";

test("fine scale stops retain the preset and stay on the supported pixel grid", () => {
  for (const preset of IMAGE_SIZE_PRESETS) {
    for (const portrait of [false, true]) {
      const sizes = presetSizes(preset.x, preset.y, portrait);
      assert.ok(sizes.length > 1);
      assert.ok(
        sizes.some(
          (s) =>
            s.width === (portrait ? preset.height : preset.width) &&
            s.height === (portrait ? preset.width : preset.height),
        ),
      );
      for (const [index, size] of sizes.entries()) {
        for (const dimension of [size.width, size.height]) {
          assert.ok(dimension >= 512 && dimension <= 2048);
          assert.equal(dimension % 8, 0);
        }
        assert.equal(matchingSizePreset(size)?.id, preset.id);
        const expectedRatio = portrait ? preset.y / preset.x : preset.x / preset.y;
        assert.ok(Math.abs(size.width - size.height * expectedRatio) <= 4 * (1 + expectedRatio));
        if (index > 0)
          assert.ok(size.width > sizes[index - 1].width && size.height > sizes[index - 1].height);
      }
    }
  }
});

test("every preset offers 1.05x between 1.00x and 1.10x in either orientation", () => {
  for (const preset of IMAGE_SIZE_PRESETS) {
    for (const portrait of [false, true]) {
      const sizes = presetSizes(preset.x, preset.y, portrait);
      const base = sizes.findIndex(
        (size) =>
          size.width === (portrait ? preset.height : preset.width) &&
          size.height === (portrait ? preset.width : preset.height),
      );
      for (const [offset, scale] of [
        [1, 1.05],
        [2, 1.1],
      ]) {
        assert.deepEqual(sizes[base + offset], {
          width: snapDimension((portrait ? preset.height : preset.width) * scale),
          height: snapDimension((portrait ? preset.width : preset.height) * scale),
        });
      }
    }
  }
});

test("linked dimensions stop together at either bound instead of stretching", () => {
  assert.deepEqual(resizeLocked({ width: 1024, height: 768 }, "width", 100), {
    width: 680,
    height: 512,
  });
  assert.deepEqual(resizeLocked({ width: 1024, height: 768 }, "height", 2048), {
    width: 2048,
    height: 1536,
  });
  assert.deepEqual(resizeLocked({ width: 768, height: 1024 }, "width", 2048), {
    width: 1536,
    height: 2048,
  });
  assert.deepEqual(resizeLocked({ width: 1024, height: 768 }, "width", 1536), {
    width: 1536,
    height: 1152,
  });
});

test("arbitrary custom sizes stay custom; manual input is clamped and rounded", () => {
  assert.equal(matchingSizePreset({ width: 1000, height: 888 }), undefined);
  assert.equal(snapDimension(1027), 1024);
  assert.equal(snapDimension(9999), 2048);
  assert.equal(snapDimension(-100), 512);
  assert.equal(snapDimension(NaN), 512);
});
