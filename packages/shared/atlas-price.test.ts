import assert from "node:assert/strict";
import test from "node:test";

import { ATLAS_MODELS, atlasParam, getAtlasModel } from "./atlas-models";
import { atlasCostForDisplay, atlasImageCount, hasAtlasPrice, quoteAtlas } from "./atlas-price";

test("video is priced per second of the requested length", () => {
  const model = getAtlasModel("atlascloud/wan-2.2/image-to-video");
  assert.equal(model.basePrice, 0.03);

  const five = quoteAtlas({ model: model.id, params: { duration: 5 } });
  assert.ok(hasAtlasPrice(five));
  assert.ok(Math.abs(five.usd - 0.15) < 1e-9);

  const eight = quoteAtlas({ model: model.id, params: { duration: 8 } });
  assert.ok(hasAtlasPrice(eight));
  assert.ok(Math.abs(eight.usd - 0.24) < 1e-9);
});

test("Seedance 2.0 at 15 seconds matches the vendor's published rate", () => {
  // $0.112/s standard is the 480p list rate — the figure the provider
  // comparison was built on, so a silent change to it should be visible here.
  // Atlas has run it at a promotional $0.09/s since the 2026-09-25 sync; the
  // list price rides along so the lapse shows up in the next diff.
  const model = getAtlasModel("bytedance/seedance-2.0/text-to-video");
  assert.equal(model.basePrice, 0.09);
  assert.equal(model.listPrice, 0.112);
  const quote = quoteAtlas({ model: model.id, params: { duration: 15, resolution: "480p" } });
  assert.ok(hasAtlasPrice(quote));
  assert.ok(Math.abs(quote.usd - 1.35) < 1e-9, `expected 1.35, got ${quote.usd}`);

  // An untouched form submits the default resolution (720p), and that is what
  // it pays for: at the list rate the real charge for exactly this clip was
  // $3.64, the 480p figure times the pixel ratio.
  const defaulted = quoteAtlas({ model: model.id, params: { duration: 15 } });
  assert.ok(hasAtlasPrice(defaulted));
  assert.ok(
    Math.abs(defaulted.usd - 1.35 * ((1280 * 720) / (854 * 480))) < 1e-9,
    `expected the 720p pixel multiple, got ${defaulted.usd}`,
  );
});

test("Seedance 2.5 at 30 seconds matches what Atlas actually charges", () => {
  // $0.134/s is the 480p rate; 30s at 480p is $4.02. The same clip at 720p —
  // the default — charged $9.026199 in production, which the pixel-scaled
  // estimate reproduces to within a quarter of a percent.
  const at480 = quoteAtlas({
    model: "bytedance/seedance-2.5/text-to-video",
    params: { duration: 30, resolution: "480p" },
  });
  assert.ok(hasAtlasPrice(at480));
  assert.ok(Math.abs(at480.usd - 4.02) < 1e-9, `expected 4.02, got ${at480.usd}`);

  const at720 = quoteAtlas({
    model: "bytedance/seedance-2.5/text-to-video",
    params: { duration: 30, resolution: "720p" },
  });
  assert.ok(hasAtlasPrice(at720));
  assert.ok(
    Math.abs(at720.usd - 9.026199) / 9.026199 < 0.005,
    `expected ~9.03 (the recorded charge), got ${at720.usd}`,
  );
});

test("Wan 3.0 pricing includes its resolution tier", () => {
  const standard = getAtlasModel("alibaba/wan-3.0/text-to-video");
  const prime = getAtlasModel("alibaba/wan-3.0-prime/text-to-video");
  assert.equal(standard.basePrice, 0.04);
  assert.equal(standard.listPrice, 0.05);
  assert.equal(prime.basePrice, 0.061);
  assert.equal(prime.listPrice, 0.068);

  const standardThirty = quoteAtlas({ model: standard.id, params: { duration: 30 } });
  const primeThirty = quoteAtlas({ model: prime.id, params: { duration: 30 } });
  assert.ok(hasAtlasPrice(standardThirty) && hasAtlasPrice(primeThirty));
  assert.ok(Math.abs(standardThirty.usd - 4.8) < 1e-9);
  assert.ok(Math.abs(primeThirty.usd - 7.56) < 1e-9);

  // Production billing on 2026-08-25 charged exactly $7.56 for a 30-second
  // Prime reference clip at 1080P. The live catalogue's $0.061/s is a "from"
  // price, not the default 1080P rate; treating it as flat underquoted by 4.13x.
  const primeReferenceFifteen = quoteAtlas({
    model: "alibaba/wan-3.0-prime/reference-to-video",
    params: { duration: 15, resolution: "1080P" },
  });
  assert.ok(hasAtlasPrice(primeReferenceFifteen));
  assert.ok(Math.abs(primeReferenceFifteen.usd - 3.78) < 1e-9);

  const nativeRates = [
    ["480p", 0.04],
    ["720p", 0.08],
    ["1080p", 0.16],
  ] as const;
  for (const [resolution, rate] of nativeRates) {
    const quote = quoteAtlas({
      model: "alibaba/wan-3.0/image-to-video",
      params: { duration: 10, resolution },
    });
    assert.ok(hasAtlasPrice(quote));
    assert.ok(Math.abs(quote.usd - rate * 10) < 1e-9);
  }

  for (const [resolution, rate] of [
    ["480P", 0.061],
    ["720P", 0.126],
  ] as const) {
    const quote = quoteAtlas({
      model: "alibaba/wan-3.0-prime/reference-to-video",
      params: { duration: 10, resolution },
    });
    assert.ok(hasAtlasPrice(quote));
    assert.ok(Math.abs(quote.usd - rate * 10) < 1e-9);
  }

  for (const resolution of ["720p-esr", "1080p-esr", "1440p-esr", "4k-esr"]) {
    const quote = quoteAtlas({
      model: "alibaba/wan-3.0/image-to-video",
      params: { duration: 10, resolution },
    });
    assert.equal(quote.usd, null, `${resolution} must not fall back to the cheapest rate`);
    assert.match(quote.reason ?? "", /does not publish a confirmed price/);
  }

  assert.equal(quoteAtlas({ model: standard.id, params: { duration: -1 } }).usd, null);
});

test("the fan-out multiplies, because each clip is a separate charge", () => {
  const one = quoteAtlas({
    model: "atlascloud/wan-2.2/image-to-video",
    params: { duration: 5 },
  });
  const four = quoteAtlas({
    model: "atlascloud/wan-2.2/image-to-video",
    params: { duration: 5 },
    jobs: 4,
  });
  assert.ok(hasAtlasPrice(one) && hasAtlasPrice(four));
  assert.ok(Math.abs(four.usd - one.usd * 4) < 1e-9);
});

test("an auto length is reported as unknown rather than guessed", () => {
  const model = ATLAS_MODELS.find((entry) => {
    const duration = atlasParam(entry, "duration");
    return entry.media === "video" && duration?.options?.includes(-1);
  });
  assert.ok(model, "expected a model offering duration -1");

  const quote = quoteAtlas({ model: model.id, params: { duration: -1 } });
  assert.equal(quote.usd, null);
  assert.match(quote.reason ?? "", /auto/i);
});

test("models whose length comes from the input clip are not priced", () => {
  const model = ATLAS_MODELS.find(
    (entry) =>
      entry.media === "video" && !atlasParam(entry, "duration") && entry.basePrice !== null,
  );
  assert.ok(model, "expected a video model with no duration parameter");

  const quote = quoteAtlas({ model: model.id, params: {} });
  assert.equal(quote.usd, null);
  assert.match(quote.reason ?? "", /source clip/i);
});

test("images are priced per image, using the model's own count parameter", () => {
  const model = ATLAS_MODELS.find(
    (entry) =>
      entry.media === "image" && entry.basePrice !== null && atlasParam(entry, "num_images"),
  );
  assert.ok(model, "expected an image model with num_images");

  const one = quoteAtlas({ model: model.id, params: { num_images: 1 } });
  const three = quoteAtlas({ model: model.id, params: { num_images: 3 } });
  assert.ok(hasAtlasPrice(one) && hasAtlasPrice(three));
  assert.ok(Math.abs(three.usd - one.usd * 3) < 1e-9);
});

test("an image model with no count parameter prices a single image", () => {
  const model = ATLAS_MODELS.find(
    (entry) =>
      entry.media === "image" &&
      entry.basePrice !== null &&
      !atlasParam(entry, "num_images") &&
      !atlasParam(entry, "n"),
  );
  assert.ok(model);
  assert.equal(atlasImageCount(model, {}), 1);
  const quote = quoteAtlas({ model: model.id, params: {} });
  assert.ok(hasAtlasPrice(quote));
  assert.ok(Math.abs(quote.usd - model.basePrice!) < 1e-9);
});

test("Studio image output count multiplies each independent request", () => {
  const model = "atlascloud/studio/product-visuals";
  const one = quoteAtlas({ model, params: { count: 1 } });
  const two = quoteAtlas({ model, params: { count: 2 } });
  const six = quoteAtlas({ model, params: { count: "2" }, jobs: 3 });
  assert.ok(hasAtlasPrice(one) && hasAtlasPrice(two) && hasAtlasPrice(six));
  assert.equal(one.usd, 0.021);
  assert.equal(two.usd, one.usd * 2);
  assert.equal(six.usd, two.usd * 3);
  assert.equal(quoteAtlas({ model, params: {} }).usd, one.usd);
});

test("Studio video quotes use documented resolution rates and native output count", () => {
  for (const slug of ["food-motion", "virtual-try-on", "ugc-ad", "trend-remix", "tvc-maker"]) {
    const model = `atlascloud/studio/${slug}`;
    for (const [resolution, rate] of [
      ["480p", 0.1409],
      ["720p", 0.303],
      ["720p-esr", 0.2536],
      ["1080p", 0.5963],
      ["1080p-esr", 0.4544],
      ["1440p-esr", 1.7246],
      ["4k-esr", 3.8582],
    ] as const) {
      const one = quoteAtlas({ model, params: { duration: 10, resolution, count: 1 } });
      const two = quoteAtlas({ model, params: { duration: 10, resolution, count: 2 } });
      const six = quoteAtlas({ model, params: { duration: 10, resolution, count: 2 }, jobs: 3 });
      assert.ok(hasAtlasPrice(one) && hasAtlasPrice(two) && hasAtlasPrice(six));
      assert.equal(one.usd, rate * 10, `${model} ${resolution}`);
      assert.equal(two.usd, one.usd * 2);
      assert.equal(six.usd, two.usd * 3);
    }
    assert.equal(quoteAtlas({ model, params: { duration: 10 } }).usd, 0.303 * 10);
    assert.equal(quoteAtlas({ model, params: { count: 2 }, jobs: 3 }).usd, null);
    assert.equal(quoteAtlas({ model, params: { duration: -1, count: 2 } }).usd, null);
    const unknown = quoteAtlas({ model, params: { duration: 10, resolution: "8k", count: 2 } });
    assert.equal(unknown.usd, null);
    assert.match(unknown.reason ?? "", /confirmed price/);
  }
});

test("a maximum output cap and undeclared counts do not imply exact output count", () => {
  const seedream = getAtlasModel("bytedance/seedream-v5.0-lite/sequential");
  assert.equal(atlasImageCount(seedream, { max_images: 15, count: 2 }), 1);
  const model = "atlascloud/wan-2.2/image-to-video";
  assert.equal(
    quoteAtlas({ model, params: { duration: 10, count: 2 } }).usd,
    quoteAtlas({ model, params: { duration: 10 } }).usd,
  );
});

test("a quote is never negative, and never silently zero", () => {
  for (const model of ATLAS_MODELS) {
    const params: Record<string, string | number | boolean | string[]> = {};
    for (const param of model.params) {
      if (param.default !== undefined) params[param.name] = param.default;
    }
    const quote = quoteAtlas({ model: model.id, params });
    if (quote.usd === null) {
      assert.ok(quote.reason, `${model.id} has an unexplained null price`);
      continue;
    }
    assert.ok(quote.usd > 0, `${model.id} quotes ${quote.usd}`);
  }
});

test("a clip shorter than five seconds is billed at the five-second floor", () => {
  // Atlas bills per-second video as Rate x max(5, Duration). 93 of the shipped
  // video models accept something under five seconds, so without the floor a
  // 2-second clip was quoted at 40% of its real cost.
  const model = ATLAS_MODELS.find((entry) => {
    const duration = atlasParam(entry, "duration");
    return (
      entry.media === "video" &&
      entry.basePrice !== null &&
      duration?.options?.some((option) => typeof option === "number" && option > 0 && option < 5)
    );
  });
  assert.ok(model, "expected a video model offering under five seconds");

  const short = quoteAtlas({ model: model.id, params: { duration: 2 } });
  const five = quoteAtlas({ model: model.id, params: { duration: 5 } });
  assert.ok(hasAtlasPrice(short) && hasAtlasPrice(five));
  assert.equal(short.usd, five.usd, "a 2s clip must not be cheaper than the 5s minimum");
});

test("Seedance resolution scales the estimate by pixels; other models stay flat", () => {
  // Real charges proved the per-second badge is the 480p rate: a 15s 720p 2.0
  // clip quoted 1.68 charged 3.64, a 30s 720p 2.5 clip quoted 4.02 charged
  // 9.03 — both the 480p figure times the pixel ratio. The estimate now says
  // so up front instead of letting the history correct it by a factor of two.
  const model = getAtlasModel("bytedance/seedance-2.0/text-to-video");
  const at = (resolution: string) =>
    quoteAtlas({ model: model.id, params: { duration: 10, resolution } });

  const base = at("480p");
  assert.ok(hasAtlasPrice(base));
  assert.ok(Math.abs(base.usd - 10 * model.basePrice!) < 1e-9);
  const expectRatio = (resolution: string, pixels: number) => {
    const quote = at(resolution);
    assert.ok(hasAtlasPrice(quote));
    assert.ok(
      Math.abs(quote.usd - (base.usd * pixels) / (854 * 480)) < 1e-9,
      `${resolution} should cost its pixel multiple of 480p`,
    );
  };
  expectRatio("720p", 1280 * 720);
  expectRatio("1080p", 1920 * 1080);
  expectRatio("4k", 3840 * 2160);
  // SR tiers price at their numeric resolution; the recorded charge corrects
  // the estimate if Atlas bills the pre-upscale render.
  expectRatio("1080p-SR", 1920 * 1080);
  expectRatio("1440p-SR", 2560 * 1440);

  // Non-Seedance models keep the flat per-second estimate — their billing
  // basis is unverified, and the last invented multiplier table was wrong.
  const wan = (resolution: string) =>
    quoteAtlas({
      model: "atlascloud/wan-2.2/image-to-video",
      params: { duration: 5, resolution },
    });
  const wan480 = wan("480p");
  const wan720 = wan("720p");
  assert.ok(hasAtlasPrice(wan480) && hasAtlasPrice(wan720));
  assert.equal(wan480.usd, wan720.usd);
  // And nothing is ever cheaper for being larger, which is what gave it away.
  const fourK = at("4k");
  const hd = at("1080p");
  assert.ok(hasAtlasPrice(fourK) && hasAtlasPrice(hd) && fourK.usd >= hd.usd);
});

test("stored Atlas estimates are repriced, while final vendor prices remain authoritative", () => {
  const repriced = atlasCostForDisplay({
    model: "alibaba/wan-3.0-prime/reference-to-video",
    params: { duration: 30, resolution: "1080P" },
    costUsd: 1.83,
    costEstimated: true,
  });
  assert.ok(repriced !== undefined && Math.abs(repriced - 7.56) < 1e-9);
  assert.equal(
    atlasCostForDisplay({
      model: "alibaba/wan-3.0-prime/reference-to-video",
      params: { duration: 15, resolution: "480P" },
      costUsd: 7.56,
      costEstimated: false,
    }),
    7.56,
  );
  assert.equal(
    atlasCostForDisplay({
      model: "alibaba/wan-3.0/image-to-video",
      params: { duration: 10, resolution: "4k-esr" },
      costUsd: 0.4,
      costEstimated: true,
    }),
    undefined,
  );
  assert.equal(atlasCostForDisplay({ model: "removed/model", costUsd: 2, costEstimated: true }), 2);
});

test("Youchuan's HD toggle multiplies the image price by its documented 1.5x", () => {
  const model = getAtlasModel("midjourney/v8.2/text-to-image");
  const sd = quoteAtlas({ model: model.id, params: { hd: false } });
  const hd = quoteAtlas({ model: model.id, params: { hd: true } });
  assert.ok(hasAtlasPrice(sd) && hasAtlasPrice(hd));
  assert.ok(Math.abs(sd.usd - model.basePrice!) < 1e-9);
  assert.ok(Math.abs(hd.usd - model.basePrice! * 1.5) < 1e-9, `got ${hd.usd}`);
  // An untouched form sends the default, which is off.
  const untouched = quoteAtlas({ model: model.id, params: {} });
  assert.ok(hasAtlasPrice(untouched));
  assert.ok(Math.abs(untouched.usd - model.basePrice!) < 1e-9);
});

test("Grok image tiers follow the table the schema prints, scaled to the charged rate", () => {
  // "Per-image price: low/1k $0.04, low/2k $0.06, medium/1k $0.06, medium/2k $0.08"
  const quote = (model: string, params: Record<string, string | number>) => {
    const result = quoteAtlas({ model, params });
    assert.ok(hasAtlasPrice(result));
    return result.usd;
  };
  const standard = "xai/grok-imagine-image-2.0/text-to-image";
  assert.ok(Math.abs(quote(standard, {}) - 0.06) < 1e-9, "the default is medium/1k");
  assert.ok(Math.abs(quote(standard, { quality: "low", resolution: "1k" }) - 0.04) < 1e-9);
  assert.ok(Math.abs(quote(standard, { quality: "medium", resolution: "2k" }) - 0.08) < 1e-9);

  // The Developer edition charges 35% of the same table.
  const developer = "xai/grok-imagine-image-2.0-developer/text-to-image";
  assert.equal(getAtlasModel(developer).basePrice, 0.014);
  assert.ok(Math.abs(quote(developer, {}) - 0.021) < 1e-9);
  assert.ok(Math.abs(quote(developer, { resolution: "2k", num_images: 2 }) - 0.056) < 1e-9);

  // Production charged $0.07 for a 2k Quality image the flat badge quoted at $0.05.
  const quality = "xai/grok-imagine-image-quality/text-to-image";
  assert.ok(Math.abs(quote(quality, { resolution: "2k" }) - 0.07) < 1e-9);
  assert.ok(Math.abs(quote(quality, { resolution: "1k" }) - 0.05) < 1e-9);
});

test("FLUX 3 video is quoted at its documented per-second resolution rates", () => {
  const at = (model: string, resolution: string) => {
    const result = quoteAtlas({ model, params: { duration: 10, resolution } });
    assert.ok(hasAtlasPrice(result));
    return result.usd;
  };
  for (const model of [
    "black-forest-labs/flux-3/text-to-video",
    "black-forest-labs/flux-3/image-to-video",
    "black-forest-labs/flux-3/first-last-frame-to-video",
  ]) {
    assert.ok(!getAtlasModel(model).retired, `${model} is listed again`);
    assert.ok(Math.abs(at(model, "720p") - 1.87) < 1e-9);
    assert.ok(Math.abs(at(model, "1080p") - 3.19) < 1e-9);
  }
  assert.ok(Math.abs(at("black-forest-labs/flux-3/extend-video", "720p") - 4.51) < 1e-9);
  assert.ok(Math.abs(at("black-forest-labs/flux-3/extend-video", "1080p") - 5.83) < 1e-9);
});

test("MiniMax H3 quotes its known tiers and withholds the unpublished ones", () => {
  const model = "minimax/h3/text-to-video";
  const at = (resolution: string) => quoteAtlas({ model, params: { duration: 10, resolution } });
  const low = at("480P");
  const mid = at("768P");
  assert.ok(hasAtlasPrice(low) && hasAtlasPrice(mid));
  assert.ok(Math.abs(low.usd - 0.38) < 1e-9);
  assert.ok(Math.abs(mid.usd - 0.8) < 1e-9);
  // 2K is the default and has no published rate; the 480P floor would halve it.
  assert.equal(atlasParam(getAtlasModel(model), "resolution")?.default, "2K");
  assert.equal(quoteAtlas({ model, params: { duration: 10 } }).usd, null);
  assert.equal(at("4k-esr").usd, null);
  // The Fast / Max / Developer siblings keep their own flat badges.
  const fast = quoteAtlas({ model: "minimax/h3-fast/text-to-video", params: { duration: 10 } });
  assert.ok(hasAtlasPrice(fast) && Math.abs(fast.usd - 0.44) < 1e-9);
});

test("Nano Banana 2.1 prices its resolution tiers and add-ons from its own table", () => {
  const close = (actual: number | null, expected: number) =>
    assert.ok(actual !== null && Math.abs(actual - expected) < 1e-9, `got ${actual}`);
  const edit = getAtlasModel("google/nano-banana-2.1/edit");
  // $0.05 / $0.075 / $0.14 list for 1k / 2k / 4k; the catalogue runs it at 80%.
  const discount = edit.basePrice! / 0.05;
  close(quoteAtlas({ model: edit.id, params: { resolution: "1k" } }).usd, 0.05 * discount);
  close(quoteAtlas({ model: edit.id, params: { resolution: "4k" } }).usd, 0.14 * discount);
  // The readme's own example: 2k, 4 inputs, web search on → $0.09572 at list.
  close(
    quoteAtlas({
      model: edit.id,
      params: { resolution: "2k", enable_web_search: true },
      referenceCount: 4,
    }).usd,
    0.09572 * discount,
  );
  // Reference-to-image always carries its $0.20 source clip.
  const fromClip = getAtlasModel("google/nano-banana-2.1/reference-to-image");
  close(
    quoteAtlas({ model: fromClip.id, params: { resolution: "1k" } }).usd,
    0.25 * (fromClip.basePrice! / 0.05),
  );
});

test("Grok Imagine Video 1.5 Lite and 1.5 follow xAI's per-second tiers", () => {
  const per = (model: string, resolution: string) => {
    const quote = quoteAtlas({ model, params: { duration: 10, resolution } });
    assert.ok(hasAtlasPrice(quote));
    return quote.usd / 10;
  };
  const lite = "xai/grok-imagine-video-v1.5-lite/text-to-video";
  assert.ok(Math.abs(per(lite, "480p") - 0.02) < 1e-9);
  assert.ok(Math.abs(per(lite, "720p") - 0.03) < 1e-9);
  assert.ok(Math.abs(per(lite, "1080p") - 0.14) < 1e-9);
  const full = "xai/grok-imagine-video-v1.5/text-to-video";
  assert.ok(Math.abs(per(full, "1080p") - 0.25) < 1e-9);
  // The Developer edition keeps its discount on every tier.
  const developer = getAtlasModel("xai/grok-imagine-video-v1.5-lite-developer/text-to-video");
  const ratio = developer.basePrice! / 0.02;
  assert.ok(Math.abs(per(developer.id, "1080p") - 0.14 * ratio) < 1e-9);
});

test("MiniMax H3 Max reference-to-video bills extra images and withholds video references", () => {
  const model = getAtlasModel("minimax/h3-max/reference-to-video");
  const discount = model.basePrice! / 0.05;
  const quote = quoteAtlas({
    model: model.id,
    params: { duration: 5, resolution: "768P" },
    referenceCount: 3,
  });
  assert.ok(hasAtlasPrice(quote));
  // 768P at $0.08/s for 5s, plus one image beyond the first two at $0.074.
  assert.ok(Math.abs(quote.usd - (0.4 + 0.074) * discount) < 1e-9, `got ${quote.usd}`);
  const withVideo = quoteAtlas({
    model: model.id,
    params: { duration: 5, resolution: "768P", refers_video_urls: ["https://x/clip.mp4"] },
  });
  assert.equal(withVideo.usd, null);
  assert.match(withVideo.reason ?? "", /per second of input/);
});

test("a Seedance 2.5 draft is priced as a 480p render whatever the resolution", () => {
  const model = "bytedance/seedance-2.5/text-to-video";
  const draft = quoteAtlas({ model, params: { duration: 5, resolution: "1080p", draft: true } });
  const native480 = quoteAtlas({ model, params: { duration: 5, resolution: "480p" } });
  assert.ok(hasAtlasPrice(draft) && hasAtlasPrice(native480));
  assert.ok(Math.abs(draft.usd - native480.usd) < 1e-9);
});

test("models whose length is not ours to know say why", () => {
  assert.match(
    quoteAtlas({ model: "bytedance/seedance-2.5/draft-complete", params: {} }).reason ?? "",
    /draft/,
  );
  assert.match(
    quoteAtlas({ model: "bytedance/avatar-omni-human-v2.0", params: {} }).reason ?? "",
    /audio/,
  );
  const clone = quoteAtlas({ model: "atlascloud/studio/video-clone", params: { duration: 8 } });
  assert.equal(clone.usd, null);
  assert.match(clone.reason ?? "", /Template Video Clone/);
});
