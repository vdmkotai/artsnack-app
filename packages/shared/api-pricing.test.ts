import assert from "node:assert/strict";
import test from "node:test";

import { API_MODEL_IDS, getApiModel, videoResolutions, type ApiModelId } from "./api-models";
import { formatUsd, imageCostFromDimensions, imageCostUsd, videoCostUsd } from "./api-pricing";

const near = (actual: number, expected: number, tolerance = 0.005) =>
  assert.ok(Math.abs(actual - expected) <= tolerance, `expected ~${expected}, got ${actual}`);

test("flat per-image models scale linearly with the batch", () => {
  for (const [model, unit] of [
    ["seedream-4.5", 0.04],
    ["seedream-5-lite", 0.035],
  ] as const) {
    for (const count of [1, 2, 4, 6]) {
      near(imageCostUsd({ model, sizeTier: "2K", count, referenceCount: 0 }), unit * count);
    }
    // Neither resolution nor reference count moves these prices.
    near(imageCostUsd({ model, sizeTier: "4K", count: 4, referenceCount: 10 }), unit * 4);
  }
});

test("Pro's two size tiers differ by exactly 2x", () => {
  const cheap = imageCostUsd({
    model: "seedream-5-pro",
    sizeTier: "1K",
    count: 1,
    referenceCount: 0,
  });
  const expensive = imageCostUsd({
    model: "seedream-5-pro",
    sizeTier: "2K",
    count: 1,
    referenceCount: 0,
  });
  near(cheap, 0.0675);
  near(expensive, 0.135);
  near(expensive / cheap, 2);

  // The default the user chose: 4 images at 2K.
  near(
    imageCostUsd({ model: "seedream-5-pro", sizeTier: "2K", count: 4, referenceCount: 0 }),
    0.54,
  );
});

test("Pro charges for every reference beyond the first, per output image", () => {
  // 4 outputs, 3 references → 4 x (0.135 + 2 x 0.0045)
  near(
    imageCostUsd({ model: "seedream-5-pro", sizeTier: "2K", count: 4, referenceCount: 3 }),
    0.576,
  );
  // A single reference is free.
  near(
    imageCostUsd({ model: "seedream-5-pro", sizeTier: "2K", count: 1, referenceCount: 1 }),
    0.135,
  );
  // 10 references at 2K.
  near(
    imageCostUsd({ model: "seedream-5-pro", sizeTier: "2K", count: 4, referenceCount: 10 }),
    0.702,
  );
});

test("measured Pro cost flips brackets exactly at 1536 squared", () => {
  const atBoundary = imageCostFromDimensions("seedream-5-pro", [{ width: 1536, height: 1536 }], 0);
  const justOver = imageCostFromDimensions("seedream-5-pro", [{ width: 1536, height: 1552 }], 0);
  near(atBoundary, 0.0675);
  near(justOver, 0.135);
});

test("measured cost prices each output on its own size", () => {
  const mixed = imageCostFromDimensions(
    "seedream-5-pro",
    [
      { width: 1504, height: 1504 },
      { width: 2016, height: 2016 },
    ],
    0,
  );
  near(mixed, 0.0675 + 0.135);
});

test("Seedance prices match the published per-second rates", () => {
  const model: ApiModelId = "seedream-5-lite";
  // Standard 720p for 10s is the headline figure.
  near(videoCostUsd({ model, tier: "standard", resolution: "720p", durationSeconds: 10 }), 3.024);
  near(videoCostUsd({ model, tier: "standard", resolution: "720p", durationSeconds: 6 }), 1.814);
  near(videoCostUsd({ model, tier: "standard", resolution: "1080p", durationSeconds: 10 }), 6.804);
  near(videoCostUsd({ model, tier: "fast", resolution: "720p", durationSeconds: 10 }), 2.419);
  // The default: Mini 720p for 10s.
  near(videoCostUsd({ model, tier: "mini", resolution: "720p", durationSeconds: 10 }), 1.547);
  near(videoCostUsd({ model, tier: "mini", resolution: "480p", durationSeconds: 6 }), 0.4326);
});

test("Grok is billed by subscription, so it prices at zero rather than failing", () => {
  assert.equal(imageCostUsd({ model: "grok", sizeTier: "2k", count: 4, referenceCount: 3 }), 0);
  assert.equal(videoCostUsd({ model: "grok", resolution: "720p", durationSeconds: 10 }), 0);
});

/**
 * The before-the-click and after-the-fact functions have to agree on which
 * models they price at all — the measured one used to test only for Grok and
 * then throw on a Higgsfield model it had no dollar rate for.
 */
test("only fal models carry a dollar price, quoted or measured", () => {
  for (const id of API_MODEL_IDS) {
    const isFal = getApiModel(id).provider === "fal";
    const measured = imageCostFromDimensions(id, [{ width: 2048, height: 2048 }], 3);
    const quoted = imageCostUsd({
      model: id,
      sizeTier: getApiModel(id).image.defaultSizeTier,
      count: 1,
      referenceCount: 3,
    });
    assert.equal(measured > 0, isFal, `measured cost of ${id} disagrees with its provider`);
    assert.equal(quoted > 0, isFal, `quoted cost of ${id} disagrees with its provider`);
  }
});

test("an unpriceable combination throws instead of returning null", () => {
  assert.throws(
    () =>
      videoCostUsd({ model: "seedream-4.5", tier: "mini", resolution: "4k", durationSeconds: 6 }),
    /No video rate/,
  );
  assert.throws(
    () => imageCostUsd({ model: "seedream-5-pro", sizeTier: "4K", count: 1, referenceCount: 0 }),
    /Unknown size tier/,
  );
});

/**
 * The interface promises a price at every stage, for every configuration. This
 * walks the entire space the form can produce and insists each point has one.
 */
test("every configuration the form can reach has a finite price", () => {
  let checked = 0;

  for (const id of API_MODEL_IDS) {
    const model = getApiModel(id);

    for (const tier of model.image.sizeTiers) {
      for (const count of model.image.counts) {
        for (
          let referenceCount = 0;
          referenceCount <= model.image.maxReferences;
          referenceCount++
        ) {
          const cost = imageCostUsd({
            model: id,
            sizeTier: tier.value,
            count,
            referenceCount,
          });
          assert.ok(
            Number.isFinite(cost) && cost >= 0,
            `no price for ${id} ${tier.value} x${count} refs=${referenceCount}`,
          );
          checked++;
        }
      }
    }

    const video = model.video;
    const tiers = video.kind === "seedance" ? video.tiers : ([undefined] as const);
    for (const videoTier of tiers) {
      for (const resolution of videoResolutions(video, videoTier)) {
        for (const duration of video.durations) {
          const cost = videoCostUsd({
            model: id,
            tier: videoTier,
            resolution,
            durationSeconds: duration,
          });
          assert.ok(
            Number.isFinite(cost) && cost >= 0,
            `no price for ${id} ${videoTier} ${resolution} ${duration}s`,
          );
          checked++;
        }
      }
    }
  }

  // Guards against the loop silently covering nothing.
  assert.ok(checked > 400, `expected a broad sweep, only checked ${checked}`);
});

test("formatting never yields an empty or misleading price", () => {
  assert.equal(formatUsd(0), "$0");
  assert.equal(formatUsd(0.035), "$0.035");
  assert.equal(formatUsd(0.0045), "$0.0045");
  assert.equal(formatUsd(0.54), "$0.54");
  assert.equal(formatUsd(3.024), "$3.02");
  assert.equal(formatUsd(13.5), "$13.50");
});
