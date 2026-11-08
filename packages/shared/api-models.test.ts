import assert from "node:assert/strict";
import test from "node:test";

import {
  API_MODELS,
  API_MODEL_IDS,
  PRO_CHEAP_TIER_MAX_PIXELS,
  SEEDREAM_LIMITS,
  getApiModel,
  imageAspectRatios,
  imageDimensions,
  imageMaxReferences,
  isApiModelId,
  maxAttachableReferences,
  nearestRatio,
  ratioValue,
  resolveImageRatio,
  seedanceEndpoint,
  seedanceMode,
  seedreamEndpoint,
  videoResolutions,
} from "./api-models";

const SEEDREAM_IDS = ["seedream-4.5", "seedream-5-lite", "seedream-5-pro"] as const;

test("every size table stays inside the model's documented pixel envelope", () => {
  for (const id of SEEDREAM_IDS) {
    const caps = getApiModel(id).image;
    assert.equal(caps.kind, "seedream");
    if (caps.kind !== "seedream") return;
    const limits = SEEDREAM_LIMITS[id];

    for (const [tier, table] of Object.entries(caps.ratioPixels)) {
      for (const [ratio, { width, height }] of Object.entries(table)) {
        const where = `${id} ${tier} ${ratio} ${width}x${height}`;
        const area = width * height;

        assert.ok(width >= limits.minSide, `${where}: width below ${limits.minSide}`);
        assert.ok(height >= limits.minSide, `${where}: height below ${limits.minSide}`);
        assert.ok(width <= limits.maxSide, `${where}: width above ${limits.maxSide}`);
        assert.ok(height <= limits.maxSide, `${where}: height above ${limits.maxSide}`);
        assert.ok(area >= limits.minArea, `${where}: area ${area} below ${limits.minArea}`);
        assert.ok(area <= limits.maxArea, `${where}: area ${area} above ${limits.maxArea}`);
        assert.equal(width % 16, 0, `${where}: width not a multiple of 16`);
        assert.equal(height % 16, 0, `${where}: height not a multiple of 16`);

        const nominal = ratioValue(ratio);
        assert.ok(nominal !== null, `${where}: unparsable ratio`);
        const deviation = Math.abs(width / height / nominal! - 1);
        assert.ok(deviation < 0.02, `${where}: ratio off by ${(deviation * 100).toFixed(2)}%`);
      }
    }
  }
});

test("every size table covers every offered aspect ratio", () => {
  for (const id of SEEDREAM_IDS) {
    const caps = getApiModel(id).image;
    if (caps.kind !== "seedream") return;
    const concrete = caps.aspectRatios.filter((ratio) => ratio !== "auto");
    for (const tier of caps.sizeTiers) {
      for (const ratio of concrete) {
        assert.ok(caps.ratioPixels[tier.value]?.[ratio], `${id} ${tier.value} is missing ${ratio}`);
      }
    }
  }
});

test("Pro's tiers land on the price bracket they advertise", () => {
  const caps = getApiModel("seedream-5-pro").image;
  if (caps.kind !== "seedream") return;

  for (const [ratio, size] of Object.entries(caps.ratioPixels["1K"])) {
    assert.ok(
      size.width * size.height <= PRO_CHEAP_TIER_MAX_PIXELS,
      `1K ${ratio} spills into the expensive bracket`,
    );
  }
  for (const [ratio, size] of Object.entries(caps.ratioPixels["2K"])) {
    assert.ok(
      size.width * size.height > PRO_CHEAP_TIER_MAX_PIXELS,
      `2K ${ratio} is priced as 2K but sized as 1K`,
    );
  }
});

test("resolves auto ratios without ever returning auto", () => {
  const caps = getApiModel("seedream-4.5").image;

  // No reference: nothing to match, so square.
  assert.equal(resolveImageRatio("auto", caps.aspectRatios), "1:1");
  // Portrait reference (3:4) snaps to the nearest offered portrait ratio.
  assert.equal(resolveImageRatio("auto", caps.aspectRatios, 0.75), "3:4");
  // Wide reference.
  assert.equal(resolveImageRatio("auto", caps.aspectRatios, 16 / 9), "16:9");
  // An explicit ratio is left alone.
  assert.equal(resolveImageRatio("2:3", caps.aspectRatios), "2:3");

  for (const ratio of caps.aspectRatios) {
    assert.notEqual(resolveImageRatio(ratio, caps.aspectRatios, 1.5), "auto");
  }
});

test("nearestRatio treats 2:1 and 1:2 as equally distant from square", () => {
  const allowed = ["1:1", "2:1", "1:2"];
  assert.equal(nearestRatio(2, allowed), "2:1");
  assert.equal(nearestRatio(0.5, allowed), "1:2");
  assert.equal(nearestRatio(1.05, allowed), "1:1");
});

test("picks the Seedance endpoint from the reference count", () => {
  const caps = getApiModel("seedream-5-lite").video;
  assert.equal(caps.kind, "seedance");
  if (caps.kind !== "seedance") return;

  assert.equal(seedanceMode(0), "text");
  assert.equal(seedanceMode(1), "image");
  assert.equal(seedanceMode(2), "reference");

  assert.equal(seedanceEndpoint(caps, "mini", 0), "bytedance/seedance-2.0/mini/text-to-video");
  assert.equal(seedanceEndpoint(caps, "fast", 1), "bytedance/seedance-2.0/fast/image-to-video");
  assert.equal(seedanceEndpoint(caps, "standard", 5), "bytedance/seedance-2.0/reference-to-video");
});

test("picks the Seedream endpoint from the reference count", () => {
  const caps = getApiModel("seedream-5-pro").image;
  if (caps.kind !== "seedream") return;
  assert.equal(seedreamEndpoint(caps, 0), "bytedance/seedream/v5/pro/text-to-image");
  assert.equal(seedreamEndpoint(caps, 3), "bytedance/seedream/v5/pro/edit");
});

test("only Standard offers 1080p and 4k", () => {
  const caps = getApiModel("seedream-4.5").video;
  if (caps.kind !== "seedance") return;
  assert.deepEqual([...videoResolutions(caps, "mini")], ["480p", "720p"]);
  assert.deepEqual([...videoResolutions(caps, "fast")], ["480p", "720p"]);
  assert.deepEqual([...videoResolutions(caps, "standard")], ["480p", "720p", "1080p", "4k"]);
});

test("Grok's 1080p stops at reference-to-video", () => {
  const caps = getApiModel("grok").video;
  if (caps.kind !== "grok") return;

  // Text-to-video (none) and image-to-video (one) both render 1080p on the 1.5
  // model, which now carries every mode.
  for (const referenceCount of [0, 1]) {
    assert.deepEqual(
      [...videoResolutions(caps, undefined, undefined, undefined, referenceCount)],
      ["480p", "720p", "1080p"],
      `expected 1080p on offer with ${referenceCount} references`,
    );
  }

  // Two or more references make it reference-to-video, which the endpoint
  // refuses at 1080p ("not supported for reference-to-video requests").
  for (const referenceCount of [2, 7]) {
    assert.deepEqual(
      [...videoResolutions(caps, undefined, undefined, undefined, referenceCount)],
      ["480p", "720p"],
      `expected 720p ceiling with ${referenceCount} references`,
    );
  }

  // Callers that do not know the count get the conservative answer rather than
  // an option that would be refused at submit.
  assert.deepEqual([...videoResolutions(caps, undefined)], ["480p", "720p"]);

  // A preset voice makes the job reference-to-video no matter how many images
  // ride along (probed live 2026-08-16), so one voice costs 1080p even at zero
  // references.
  assert.deepEqual(
    [...videoResolutions(caps, undefined, undefined, undefined, 0, 1)],
    ["480p", "720p"],
  );
  assert.deepEqual(
    [...videoResolutions(caps, undefined, undefined, undefined, 1, 0)],
    ["480p", "720p", "1080p"],
  );
});

test("Grok's voice roster matches what the endpoint publishes", () => {
  const caps = getApiModel("grok").video;
  if (caps.kind !== "grok") return;
  // The endpoint lists its roster on an unknown voice_id; this is that list.
  assert.equal(caps.voices.length, 26);
  assert.equal(caps.maxVoices, 3);
  for (const voice of ["ara", "eve", "leo", "rex", "atlas"]) {
    assert.ok(caps.voices.includes(voice), `expected ${voice} in the roster`);
  }
});

test("Grok's quality switch carries both model generations", () => {
  const caps = getApiModel("grok").image;
  if (caps.kind !== "grok") return;
  // Quality stays on the menu: xAI retires the slug on 2026-11-02 but keeps it
  // resolving (to 2.0 at low), and the owner still uses it.
  assert.deepEqual(
    caps.qualities.map((quality) => quality.value),
    ["standard", "quality", "v2-low", "v2-medium", "v2-auto"],
  );
});

test("Grok 2.0 takes five edit sources and two more ratios; the legacy pair does not", () => {
  const caps = getApiModel("grok").image;
  for (const quality of ["standard", "quality"]) {
    assert.equal(imageMaxReferences(caps, quality), 3);
    const ratios = imageAspectRatios(caps, quality);
    assert.ok(!ratios.includes("21:9") && !ratios.includes("5:2"), `${quality} has no 21:9/5:2`);
    // The phone ratios are in the general table with no model named.
    for (const ratio of ["19.5:9", "9:19.5", "20:9", "9:20", "2:1", "1:2", "auto"]) {
      assert.ok(ratios.includes(ratio), `${quality} offers ${ratio}`);
    }
  }
  for (const quality of ["v2-low", "v2-medium", "v2-auto"]) {
    assert.equal(imageMaxReferences(caps, quality), 5);
    for (const ratio of ["21:9", "5:2", "19.5:9", "9:20"]) {
      assert.ok(imageAspectRatios(caps, quality).includes(ratio), `${quality} offers ${ratio}`);
    }
  }
  // An unknown quality reads as the legacy caps — never the wider ones.
  assert.equal(imageMaxReferences(caps, "ultra"), 3);
  // Other models ignore the quality argument entirely.
  const seedream = getApiModel("seedream-4.5").image;
  assert.equal(imageMaxReferences(seedream, "v2-low"), seedream.maxReferences);
  assert.deepEqual(imageAspectRatios(seedream, "v2-low"), seedream.aspectRatios);
});

test("Grok video offers every ratio the 1.5 family takes, 21:9 and 5:2 included", () => {
  const ratios = getApiModel("grok").video.aspectRatios;
  for (const ratio of ["4:3", "3:4", "3:2", "2:3", "16:9", "9:16", "1:1", "21:9", "5:2"]) {
    assert.ok(ratios.includes(ratio), `expected ${ratio} on offer`);
  }
  assert.ok(!ratios.includes("auto"));
});

test("Grok video takes any whole second from 1 to 15", () => {
  assert.deepEqual(
    [...getApiModel("grok").video.durations],
    Array.from({ length: 15 }, (_, index) => index + 1),
  );
  // Defaults stay cheap: 1080p and 15s burn subscription quota far faster, and
  // should be chosen rather than inherited.
  assert.equal(getApiModel("grok").video.defaultDuration, 6);
  assert.equal(getApiModel("grok").video.defaultResolution, "480p");
});

test("duration lists never offer auto, because it has no price", () => {
  for (const id of API_MODEL_IDS) {
    for (const seconds of getApiModel(id).video.durations) {
      assert.equal(typeof seconds, "number");
      assert.ok(Number.isFinite(seconds) && seconds > 0);
    }
  }
});

test("model capabilities match the vendor schemas they were read from", () => {
  const lite = getApiModel("seedream-5-lite").image;
  const pro = getApiModel("seedream-5-pro").image;
  const v45 = getApiModel("seedream-4.5").image;
  if (lite.kind !== "seedream" || pro.kind !== "seedream" || v45.kind !== "seedream") return;

  // Only 4.5 declares a seed input.
  assert.equal(v45.supportsSeed, true);
  assert.equal(lite.supportsSeed, false);
  assert.equal(pro.supportsSeed, false);
  // Pro's schema omits max_images.
  assert.equal(pro.supportsMaxImages, false);
  // Only Pro takes output_format.
  assert.equal(pro.supportsOutputFormat, true);
  assert.equal(lite.supportsOutputFormat, false);
  assert.equal(v45.supportsOutputFormat, false);

  const video = getApiModel("seedream-4.5").video;
  if (video.kind !== "seedance") return;
  // Mini's schema has no bitrate_mode.
  assert.equal(video.bitrateModeByTier.mini, false);
  assert.equal(video.bitrateModeByTier.fast, true);
  assert.equal(video.bitrateModeByTier.standard, true);
});

test("unknown model ids are rejected rather than silently defaulted", () => {
  assert.equal(isApiModelId("seedream-4.5"), true);
  assert.equal(isApiModelId("seedream-9"), false);
  assert.throws(() => getApiModel("seedream-9"), /Unknown API model/);
});

test("attachment cap is the larger of the model's two limits", () => {
  // 1.5 takes fourteen images; 2.0's five edit sources fit under it.
  assert.equal(maxAttachableReferences(API_MODELS.grok), 14);
  assert.equal(maxAttachableReferences(API_MODELS["seedream-5-pro"]), 10);
});

test("imageDimensions rejects tiers and ratios the model has no table for", () => {
  const caps = getApiModel("seedream-5-pro").image;
  if (caps.kind !== "seedream") return;
  assert.deepEqual(imageDimensions(caps, "2K", "1:1"), { width: 2016, height: 2016 });
  assert.throws(() => imageDimensions(caps, "4K", "1:1"), /Unknown size tier/);
  assert.throws(() => imageDimensions(caps, "2K", "21:9"), /Unknown aspect ratio/);
});
