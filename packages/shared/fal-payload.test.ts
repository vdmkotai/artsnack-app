import assert from "node:assert/strict";
import test from "node:test";

import { buildSeedanceRequest, buildSeedreamRequest } from "./fal-payload";

const REF = "https://cdn.example/ref.jpg";

test("Seedream sends explicit pixels, never an auto_* preset", () => {
  const { endpoint, payload } = buildSeedreamRequest({
    model: "seedream-5-pro",
    prompt: "a cat",
    aspectRatio: "16:9",
    sizeTier: "2K",
    count: 2,
    referenceUrls: [],
  });

  assert.equal(endpoint, "bytedance/seedream/v5/pro/text-to-image");
  assert.deepEqual(payload.image_size, { width: 2688, height: 1504 });
  assert.equal(payload.num_images, 2);
  // fal's safety checker is left at its default.
  assert.equal("enable_safety_checker" in payload, false);
  assert.equal(typeof payload.image_size, "object");
});

test("an auto ratio is settled from the first reference", () => {
  const portrait = buildSeedreamRequest({
    model: "seedream-4.5",
    prompt: "x",
    aspectRatio: "auto",
    sizeTier: "2K",
    count: 1,
    referenceUrls: [REF],
    referenceAspect: 0.75,
  });
  assert.deepEqual(portrait.payload.image_size, { width: 1920, height: 2560 });

  const noReference = buildSeedreamRequest({
    model: "seedream-4.5",
    prompt: "x",
    aspectRatio: "auto",
    sizeTier: "2K",
    count: 1,
    referenceUrls: [],
  });
  assert.deepEqual(noReference.payload.image_size, { width: 2048, height: 2048 });
});

test("Seedream switches to the edit endpoint when references are attached", () => {
  const { endpoint, payload } = buildSeedreamRequest({
    model: "seedream-5-lite",
    prompt: "x",
    aspectRatio: "1:1",
    sizeTier: "2K",
    count: 1,
    referenceUrls: [REF, REF],
  });
  assert.equal(endpoint, "fal-ai/bytedance/seedream/v5/lite/edit");
  assert.deepEqual(payload.image_urls, [REF, REF]);
});

test("Seedream omits fields the target model does not declare", () => {
  // Lite and 4.5 have no output_format; only Pro does.
  for (const model of ["seedream-4.5", "seedream-5-lite"] as const) {
    const { payload } = buildSeedreamRequest({
      model,
      prompt: "x",
      aspectRatio: "1:1",
      sizeTier: "2K",
      count: 1,
      referenceUrls: [],
    });
    assert.ok(!("output_format" in payload), `${model} must not send output_format`);
  }

  const pro = buildSeedreamRequest({
    model: "seedream-5-pro",
    prompt: "x",
    aspectRatio: "1:1",
    sizeTier: "2K",
    count: 1,
    referenceUrls: [],
  });
  assert.equal(pro.payload.output_format, "png");

  // No model gets seed or max_images — Lite and Pro would reject them.
  for (const model of ["seedream-4.5", "seedream-5-lite", "seedream-5-pro"] as const) {
    const { payload } = buildSeedreamRequest({
      model,
      prompt: "x",
      aspectRatio: "1:1",
      sizeTier: "2K",
      count: 1,
      referenceUrls: [],
    });
    assert.ok(!("seed" in payload), `${model} must not send seed`);
    assert.ok(!("max_images" in payload), `${model} must not send max_images`);
  }
});

test("Seedream caps references at the documented 10", () => {
  const many = Array.from({ length: 14 }, (_, index) => `${REF}?${index}`);
  const { payload } = buildSeedreamRequest({
    model: "seedream-5-pro",
    prompt: "x",
    aspectRatio: "1:1",
    sizeTier: "2K",
    count: 1,
    referenceUrls: many,
  });
  assert.equal((payload.image_urls as string[]).length, 10);
});

test("Seedream keeps ordinal tags the model understands", () => {
  const { payload } = buildSeedreamRequest({
    model: "seedream-4.5",
    prompt: "put @image1 next to @image2",
    aspectRatio: "1:1",
    sizeTier: "2K",
    count: 1,
    referenceUrls: [REF, REF],
  });
  assert.equal(payload.prompt, "put image 1 next to image 2");
});

// ---------------------------------------------------------------------------

const seedance = (overrides: Partial<Parameters<typeof buildSeedanceRequest>[0]> = {}) =>
  buildSeedanceRequest({
    model: "seedream-4.5",
    prompt: "a cat",
    aspectRatio: "16:9",
    durationSeconds: 10,
    resolution: "720p",
    tier: "mini",
    generateAudio: true,
    bitrateMode: "standard",
    referenceUrls: [],
    ...overrides,
  });

test("Seedance duration is a string, not a number", () => {
  const { payload } = seedance({ durationSeconds: 15 });
  assert.equal(payload.duration, "15");
  assert.equal(typeof payload.duration, "string");
});

test("Seedance picks its endpoint from the reference count", () => {
  assert.equal(seedance().endpoint, "bytedance/seedance-2.0/mini/text-to-video");
  assert.equal(
    seedance({ referenceUrls: [REF] }).endpoint,
    "bytedance/seedance-2.0/mini/image-to-video",
  );
  assert.equal(
    seedance({ referenceUrls: [REF, REF] }).endpoint,
    "bytedance/seedance-2.0/mini/reference-to-video",
  );
  assert.equal(
    seedance({ tier: "standard", referenceUrls: [REF, REF] }).endpoint,
    "bytedance/seedance-2.0/reference-to-video",
  );
});

test("a single reference becomes the first frame and defines the shape", () => {
  const { payload } = seedance({ referenceUrls: [REF], aspectRatio: "9:16" });
  assert.equal(payload.image_url, REF);
  assert.equal(payload.aspect_ratio, "auto");
  assert.ok(!("image_urls" in payload));
});

test("multiple references travel as image_urls, capped at 9", () => {
  const many = Array.from({ length: 12 }, (_, index) => `${REF}?${index}`);
  const { payload } = seedance({ referenceUrls: many });
  assert.equal((payload.image_urls as string[]).length, 9);
});

test("bitrate_mode is withheld from Mini, whose schema lacks it", () => {
  assert.ok(!("bitrate_mode" in seedance({ tier: "mini", bitrateMode: "high" }).payload));
  assert.equal(seedance({ tier: "fast", bitrateMode: "high" }).payload.bitrate_mode, "high");
  // Standard bitrate is the server default and is never sent explicitly.
  assert.ok(!("bitrate_mode" in seedance({ tier: "fast", bitrateMode: "standard" }).payload));
});

test("Seedance keeps @Image tags, which its prompt syntax uses directly", () => {
  const { payload } = seedance({
    prompt: "@image1 walks past @image2",
    referenceUrls: [REF, REF],
  });
  assert.equal(payload.prompt, "@Image1 walks past @Image2");
});

test("a resolution the tier cannot produce is refused rather than silently downgraded", () => {
  assert.throws(
    () => seedance({ tier: "mini", resolution: "1080p" }),
    /not available on the mini tier/,
  );
  assert.doesNotThrow(() => seedance({ tier: "standard", resolution: "4k" }));
});

test("audio is passed through explicitly in both directions", () => {
  assert.equal(seedance({ generateAudio: true }).payload.generate_audio, true);
  assert.equal(seedance({ generateAudio: false }).payload.generate_audio, false);
});

test("Grok is not routable through the fal payload builders", () => {
  assert.throws(
    () =>
      buildSeedreamRequest({
        model: "grok",
        prompt: "x",
        aspectRatio: "1:1",
        sizeTier: "2k",
        count: 1,
        referenceUrls: [],
      }),
    /no Seedream image endpoint/,
  );
  assert.throws(() => seedance({ model: "grok" }), /no Seedance video endpoint/);
});
