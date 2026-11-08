import assert from "node:assert/strict";
import test from "node:test";

import { API_MODEL_IDS, getApiModel, videoResolutions, type ApiModelId } from "./api-models";
import { imageCostUsd, videoCostUsd } from "./api-pricing";
import { priceForVariant } from "./api-price";
import {
  atlasJobsFor,
  DEFAULT_API_FORM,
  hydrateForm,
  normalizeForm,
  withActiveAtlasParams,
  withAtlasModel,
  withAtlasRow,
  withRegistryModel,
  type ApiFormState,
} from "./normalize-form";
import {
  ATLAS_FANOUT_COUNTS,
  ATLAS_MODELS,
  atlasBatchParam,
  atlasBatchSplit,
  atlasBatchValue,
  atlasCountOptions,
  atlasFormParams,
  clampAtlasValue,
  getAtlasModel,
  isAtlasModelId,
} from "./atlas-models";
import { quoteAtlas, quoteAtlasImages } from "./atlas-price";

const near = (actual: number, expected: number) =>
  assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} ≠ ${expected}`);

const form = (overrides: Partial<ApiFormState>): ApiFormState => ({
  ...DEFAULT_API_FORM,
  ...overrides,
});

test("Grok's 3:2 video ratio becomes Seedance's nearest, 4:3", () => {
  const { form: next, adjustments } = normalizeForm(
    form({ model: "seedream-4.5", mediaType: "video", aspectRatio: "3:2" }),
  );
  assert.equal(next.aspectRatio, "4:3");
  assert.ok(adjustments.some((line) => line.includes("3:2 → 4:3")));
});

test("Seedance's 3:4 survives on Grok, which grew 4:3 and 3:4", () => {
  // 3:4 used to clamp to 2:3 — the video endpoint's enum has both pairs now.
  const { form: next, adjustments } = normalizeForm(
    form({ model: "grok", mediaType: "video", aspectRatio: "3:4" }),
  );
  assert.equal(next.aspectRatio, "3:4");
  assert.deepEqual(adjustments, []);
  // 21:9 arrived with the 1.5 family and survives too.
  assert.equal(
    normalizeForm(form({ model: "grok", mediaType: "video", aspectRatio: "21:9" })).form
      .aspectRatio,
    "21:9",
  );
});

test("auto has no video equivalent on Grok and lands on 16:9", () => {
  const { form: next } = normalizeForm(
    form({ model: "grok", mediaType: "video", aspectRatio: "auto" }),
  );
  assert.equal(next.aspectRatio, "16:9");
  // Seedance does offer auto, so it survives there.
  assert.equal(
    normalizeForm(form({ model: "seedream-5-pro", mediaType: "video", aspectRatio: "auto" })).form
      .aspectRatio,
    "auto",
  );
});

test("dropping from Standard to Mini pulls 1080p down to 720p", () => {
  const { form: next, adjustments } = normalizeForm(
    form({ model: "seedream-5-lite", mediaType: "video", videoTier: "mini", resolution: "1080p" }),
  );
  assert.equal(next.resolution, "720p");
  assert.ok(adjustments.some((line) => line.includes("1080p → 720p")));
});

test("Grok reaches 15 seconds, and stops there", () => {
  // 15 used to collapse to 10. The endpoint always took it — the cap was ours.
  const { form: next, adjustments } = normalizeForm(
    form({ model: "grok", mediaType: "video", duration: 15 }),
  );
  assert.equal(next.duration, 15);
  assert.deepEqual(adjustments, []);
  // Past the documented ceiling it still clamps, to the longest on offer.
  assert.equal(
    normalizeForm(form({ model: "grok", mediaType: "video", duration: 16 })).form.duration,
    15,
  );
  // Every whole second below it is legal too — 1.5 and Lite take 1–15.
  assert.equal(normalizeForm(form({ model: "grok", duration: 4 })).form.duration, 4);
  assert.equal(normalizeForm(form({ model: "grok", duration: 1 })).form.duration, 1);
  // Seedance keeps all of them.
  assert.equal(normalizeForm(form({ model: "seedream-4.5", duration: 15 })).form.duration, 15);
});

test("Grok keeps 1080p through text- and image-to-video, drops it at reference-to-video", () => {
  // Zero references (text-to-video) and one (image-to-video) both render
  // 1080p on the 1.5 model.
  for (const referenceCount of [0, 1]) {
    const kept = normalizeForm(
      form({ model: "grok", mediaType: "video", resolution: "1080p" }),
      referenceCount,
    );
    assert.equal(kept.form.resolution, "1080p");
    assert.deepEqual(kept.adjustments, []);
  }

  // A second reference turns it into reference-to-video, which the endpoint
  // refuses at 1080p — the clamp has to fire on the way in.
  const withTwo = normalizeForm(
    form({ model: "grok", mediaType: "video", resolution: "1080p" }),
    2,
  );
  assert.equal(withTwo.form.resolution, "720p");
  assert.ok(withTwo.adjustments.some((line) => line.includes("1080p → 720p")));
});

test("a preset voice makes the clip reference-to-video, which costs it 1080p", () => {
  // Probed live 2026-08-16: a voices-only request at 1080p is refused with the
  // reference-to-video message, so the clamp fires even with zero references.
  const withVoice = normalizeForm(
    form({ model: "grok", mediaType: "video", resolution: "1080p", videoVoices: ["ara"] }),
    0,
  );
  assert.equal(withVoice.form.resolution, "720p");
  assert.ok(withVoice.adjustments.some((line) => line.includes("1080p → 720p")));
});

test("voices clamp to the roster and the three-voice ceiling", () => {
  const { form: next, adjustments } = normalizeForm(
    form({
      model: "grok",
      mediaType: "video",
      videoVoices: ["ara", "nobody", "eve", "leo", "rex"],
    }),
  );
  // The impostor is dropped first, then the list is cut at the cap.
  assert.deepEqual(next.videoVoices, ["ara", "eve", "leo"]);
  assert.ok(adjustments.some((line) => line.includes("Voices")));
  // A legal selection passes through silently, on Grok and off it.
  const legal = normalizeForm(
    form({ model: "grok", mediaType: "video", videoVoices: ["ara", "eve"] }),
  );
  assert.deepEqual(legal.form.videoVoices, ["ara", "eve"]);
  assert.deepEqual(legal.adjustments, []);
});

test("an unknown image quality falls back to the default", () => {
  const { form: next } = normalizeForm(
    form({ model: "grok", quality: "ultra" as ApiFormState["quality"] }),
  );
  assert.equal(next.quality, DEFAULT_API_FORM.quality);
  // The four real values all survive, the two 2.0 entries included.
  for (const quality of ["standard", "quality", "v2-low", "v2-medium"] as const) {
    assert.equal(normalizeForm(form({ model: "grok", quality })).form.quality, quality);
  }
});

test("clamping is silent for controls the user cannot currently see", () => {
  // Composing a video: the image count is still clamped, just not announced.
  // (Aspect ratio is pinned to a legal value so only the hidden field can speak.)
  const video = normalizeForm(
    form({ model: "grok", mediaType: "video", aspectRatio: "16:9", count: 3, duration: 10 }),
  );
  assert.equal(video.form.count, 2);
  assert.deepEqual(video.adjustments, []);

  // Composing images: the same is true of duration and video resolution.
  // (Size tier is pinned to a legal value so only hidden fields can speak.)
  // Two references make the hidden video half reference-to-video, where 1080p
  // is refused — so both hidden fields move, and neither says so.
  const image = normalizeForm(
    form({
      model: "grok",
      mediaType: "image",
      imageSizeTier: "2k",
      duration: 16,
      resolution: "1080p",
    }),
    2,
  );
  assert.equal(image.form.duration, 15);
  assert.equal(image.form.resolution, "720p");
  assert.deepEqual(image.adjustments, []);
});

test("Grok's lowercase size tiers map onto Seedream's uppercase ones", () => {
  assert.equal(
    normalizeForm(form({ model: "seedream-5-pro", imageSizeTier: "2k" })).form.imageSizeTier,
    "2K",
  );
  // Pro has no 4K, so it falls back to the model default.
  assert.equal(
    normalizeForm(form({ model: "seedream-5-pro", imageSizeTier: "4K" })).form.imageSizeTier,
    "2K",
  );
  // 4.5 has no 1K at all — its floor is ~3.7 MP.
  assert.equal(
    normalizeForm(form({ model: "seedream-4.5", imageSizeTier: "1k" })).form.imageSizeTier,
    "2K",
  );
});

test("Grok opens on 2K, and lands there when a tier has to be dropped", () => {
  // The subscription charges the same for either, so 1K is only ever a
  // downgrade nobody asked for — and switching models is what kept causing it.
  assert.equal(getApiModel("grok").image.defaultSizeTier, "2k");
  for (const tier of ["basic", "high", "3K", "4K", "nonsense"]) {
    assert.equal(
      normalizeForm(form({ model: "grok", imageSizeTier: tier })).form.imageSizeTier,
      "2k",
    );
  }
  // An explicit 1K is still the user's choice and survives.
  assert.equal(
    normalizeForm(form({ model: "grok", imageSizeTier: "1k" })).form.imageSizeTier,
    "1k",
  );
});

test("image counts clamp to what the model accepts", () => {
  assert.equal(normalizeForm(form({ model: "grok", count: 12 })).form.count, 10);
  assert.equal(normalizeForm(form({ model: "grok", count: 10 })).form.count, 10);
  assert.equal(normalizeForm(form({ model: "seedream-4.5", count: 10 })).form.count, 6);
});

test("on Atlas the count follows the fan-out list, not the dormant model's", () => {
  // The model left behind used to clamp it: with Grok dormant an Atlas 3
  // became a 2, and Higgsfield's list would cap the fan-out at 4.
  const atlas = (model: ApiModelId, count: number) =>
    normalizeForm({ ...form({ model, count }), provider: "atlas" }).form;
  assert.equal(atlas("grok", 3).count, 3);
  assert.equal(atlas("hf-seedream-4.5", 10).count, 10);
  // Any whole count up to 10 stands, on or off the button list.
  assert.equal(atlas("hf-seedream-4.5", 5).count, 5);
  assert.equal(atlas("hf-seedream-4.5", 12).count, 10);
  assert.equal(atlas("hf-seedream-4.5", 2.5).count, 2);

  // Back on the model's own provider, its own list applies again.
  const back = normalizeForm({ ...atlas("hf-seedream-4.5", 10), provider: "higgsfield" });
  assert.equal(back.form.count, 4);
  assert.deepEqual(back.adjustments, ["Images 10 → 4"]);
});

test("bitrate is forced back to standard on the tier that has no such field", () => {
  const { form: next } = normalizeForm(
    form({ model: "seedream-4.5", videoTier: "mini", bitrateMode: "high" }),
  );
  assert.equal(next.bitrateMode, "standard");
  assert.equal(
    normalizeForm(form({ model: "seedream-4.5", videoTier: "fast", bitrateMode: "high" })).form
      .bitrateMode,
    "high",
  );
});

test("switching models keeps the prompt and leaves nothing else illegal", () => {
  const prompt = "a very long prompt the user does not want to retype";
  let state = form({
    model: "grok",
    mediaType: "video",
    prompt,
    aspectRatio: "3:2",
    duration: 10,
    resolution: "720p",
  });

  for (const id of API_MODEL_IDS) {
    state = normalizeForm({ ...state, model: id }).form;
    assert.equal(state.prompt, prompt);

    const model = getApiModel(id);
    assert.ok(model.video.aspectRatios.includes(state.aspectRatio));
    assert.ok(model.video.durations.includes(state.duration));
    assert.ok(videoResolutions(model.video, state.videoTier).includes(state.resolution));
    assert.ok(model.image.counts.includes(state.count));
    assert.ok(model.image.sizeTiers.some((tier) => tier.value === state.imageSizeTier));
  }
});

/**
 * The price on the Generate button is computed straight from form state, so a
 * normalized form must never be one the pricing functions refuse.
 */
test("any normalized form can be priced", () => {
  for (const id of API_MODEL_IDS) {
    const model = getApiModel(id);
    for (const mediaType of ["image", "video"] as const) {
      for (const ratio of ["auto", "3:2", "21:9", "1:2"]) {
        for (const duration of [4, 6, 10, 15]) {
          for (const resolution of ["480p", "720p", "1080p", "4k"]) {
            for (const videoTier of ["mini", "fast", "standard"] as const) {
              for (const sizeTier of ["1k", "2k", "3K", "4K"]) {
                const { form: next } = normalizeForm(
                  form({
                    model: id,
                    mediaType,
                    aspectRatio: ratio,
                    duration,
                    resolution,
                    videoTier,
                    imageSizeTier: sizeTier,
                  }),
                );
                assert.doesNotThrow(() => {
                  imageCostUsd({
                    model: next.model,
                    sizeTier: next.imageSizeTier,
                    count: next.count,
                    referenceCount: 0,
                  });
                  videoCostUsd({
                    model: next.model,
                    tier: next.videoTier,
                    resolution: next.resolution,
                    durationSeconds: next.duration,
                  });
                }, `unpriceable after normalizing ${id}/${mediaType}/${ratio}/${resolution}/${videoTier}`);
                assert.ok(model.id === id);
              }
            }
          }
        }
      }
    }
  }
});

test("a corrupt or stale persisted form falls back to defaults", () => {
  assert.deepEqual(hydrateForm(null), DEFAULT_API_FORM);
  assert.deepEqual(hydrateForm("{not json"), DEFAULT_API_FORM);
  assert.deepEqual(hydrateForm(JSON.stringify({ model: "seedream-99" })), DEFAULT_API_FORM);

  const restored = hydrateForm(
    JSON.stringify({ model: "seedream-5-pro", prompt: "hi", imageSizeTier: "4K" }),
  );
  assert.equal(restored.model, "seedream-5-pro");
  assert.equal(restored.prompt, "hi");
  // Normalized on the way in, so nothing illegal is ever restored.
  assert.equal(restored.imageSizeTier, "2K");
});

test("the default form is legal for the model it opens on", () => {
  // A default that needs clamping leaves a fresh page with no ratio or quality
  // selected, and fires a toast on the first keystroke.
  const { adjustments } = normalizeForm(DEFAULT_API_FORM);
  assert.deepEqual(adjustments, []);
  assert.deepEqual(normalizeForm(DEFAULT_API_FORM).form, DEFAULT_API_FORM);
});

test("fast mode narrows the resolutions instead of failing later", () => {
  const { form: next } = normalizeForm(
    form({
      model: "hf-seedream-4.5",
      mediaType: "video",
      videoJobType: "seedance_2_0",
      videoMode: "fast",
      resolution: "4k",
      aspectRatio: "16:9",
    }),
  );
  // Their rule: fast is 480p/720p only. Offering 4k there fails at generation.
  assert.equal(next.resolution, "720p");
});

test("durations follow the selected video model", () => {
  // Wan reaches 2s; Seedance starts at 4s.
  const wan = normalizeForm(
    form({
      model: "hf-seedream-4.5",
      mediaType: "video",
      videoJobType: "wan2_7",
      duration: 2,
      aspectRatio: "16:9",
    }),
  ).form;
  assert.equal(wan.duration, 2);

  const seedance = normalizeForm({ ...wan, videoJobType: "seedance_2_0" }).form;
  assert.equal(seedance.duration, 4);
});

test("a hidden aspect-ratio control stays quiet when it is clamped", () => {
  // One reference defines the frame, so the control is not on screen.
  const withOneReference = normalizeForm(
    form({ model: "hf-seedream-4.5", mediaType: "video", aspectRatio: "3:2" }),
    1,
  );
  assert.deepEqual(withOneReference.adjustments, []);

  const withNone = normalizeForm(
    form({ model: "hf-seedream-4.5", mediaType: "video", aspectRatio: "3:2" }),
    0,
  );
  assert.ok(withNone.adjustments.some((line) => line.includes("Aspect ratio")));
});

/**
 * Fan-out billing.
 *
 * No video model on any of the three providers takes a batch parameter, so four
 * clips are four jobs and four charges. The button has to say so before the
 * click, and each stored row has to stay per-job or the results total would
 * count the same money twice.
 */
test("a video count multiplies the price, and only the price", () => {
  const grok = getApiModel("grok");
  const higgsfield = getApiModel("hf-seedream-4.5");
  const fal = getApiModel("seedream-4.5");
  const quotes = new Map<string, number>();

  const priceOf = (model: ReturnType<typeof getApiModel>, videoCount: number) =>
    priceForVariant(
      model,
      {
        mediaType: "video",
        videoCount,
        duration: 10,
        resolution: "720p",
        aspectRatio: "16:9",
        videoJobType: "wan2_7",
        videoTier: "standard",
        generateAudio: true,
      },
      0,
      quotes,
    );

  // Higgsfield: credits, straight from the captured rate card.
  const one = priceOf(higgsfield, 1);
  const four = priceOf(higgsfield, 4);
  assert.equal(one?.currency, "credits");
  assert.ok(one && one.currency === "credits" && one.amount > 0);
  assert.equal(
    four && four.currency === "credits" ? four.amount : null,
    one && one.currency === "credits" ? one.amount * 4 : null,
  );

  // fal: dollars, per clip, times the count.
  const falOne = priceOf(fal, 1);
  const falFour = priceOf(fal, 4);
  assert.equal(falOne?.currency, "usd");
  assert.ok(falOne && falOne.currency === "usd" && falOne.amount > 0);
  assert.equal(
    falFour && falFour.currency === "usd" ? falFour.amount : null,
    falOne && falOne.currency === "usd" ? falOne.amount * 4 : null,
  );

  // Grok rides the subscription, so four of them are still included.
  assert.equal(priceOf(grok, 4)?.currency, "included");
});

test("the image count never leaks into the video count, or back", () => {
  // Six images then a switch to video must not queue six paid clips; the two
  // counts are separate fields for exactly that reason.
  const sixImages = normalizeForm(form({ model: "seedream-4.5", count: 6 })).form;
  assert.equal(sixImages.count, 6);
  assert.equal(sixImages.videoCount, 1);

  const asVideo = normalizeForm({ ...sixImages, mediaType: "video" }).form;
  assert.equal(asVideo.videoCount, 1);
  assert.equal(asVideo.count, 6);
});

test("video counts clamp to what the fan-out allows", () => {
  for (const [requested, expected] of [
    [0, 1],
    [1, 1],
    [4, 4],
    [7, 4],
    [99, 4],
  ] as const) {
    assert.equal(
      normalizeForm(form({ mediaType: "video", videoCount: requested })).form.videoCount,
      expected,
    );
  }
});

/**
 * The button and the record have to agree.
 *
 * The mutation reads its credit figure from the selected model's signature, so
 * a preview that leaves the model or mode out quotes a different job than the
 * one that runs — silently, and by a factor of three between Wan and Seedance.
 */
test("the previewed price follows the selected video model, not the default", () => {
  const model = getApiModel("hf-seedream-4.5");
  const quotes = new Map<string, number>();
  const priceOf = (videoJobType: string) => {
    const next = normalizeForm(
      form({ model: "hf-seedream-4.5", mediaType: "video", videoJobType, duration: 5 }),
    ).form;
    const price = priceForVariant(
      model,
      {
        mediaType: "video",
        aspectRatio: next.aspectRatio,
        duration: next.duration,
        resolution: next.resolution,
        videoJobType: next.videoJobType,
        videoMode: next.videoMode,
        generateAudio: next.generateAudio,
        videoCount: next.videoCount,
      },
      0,
      quotes,
    );
    assert.ok(price && price.currency === "credits", `no price for ${videoJobType}`);
    return price.amount;
  };

  // Measured against `higgsfield generate cost`: at 5s/720p Wan is 7.5 credits
  // where Seedance is 22.5. Any implementation that ignores the selection
  // returns the same number for both.
  assert.notEqual(priceOf("wan2_7"), priceOf("seedance_2_0"));
  assert.notEqual(priceOf("kling3_0"), priceOf("seedance_2_0"));
});

test("a form persisted before video counts existed restores as one clip", () => {
  // Anything else would turn a returning user's first click into four charges.
  const stored = JSON.stringify({ model: "hf-seedream-4.5", mediaType: "video", prompt: "hi" });
  assert.equal(hydrateForm(stored).videoCount, 1);
  // And a garbage value is clamped rather than trusted.
  assert.equal(hydrateForm(JSON.stringify({ model: "grok", videoCount: 40 })).videoCount, 4);
});

/**
 * Audio is a priced setting, not a preference.
 *
 * Measured against `higgsfield generate cost`: Kling 3.0 std at 5s is 10
 * credits with sound and 7.5 without, and 12.5 against 8.75 on pro. Leaving it
 * out of the quote key overstated every silent Kling clip by a third — and the
 * fan-out multiplies that by four.
 */
test("Kling's sound is priced, and Seedance's audio is not", () => {
  const model = getApiModel("hf-seedream-4.5");
  const quotes = new Map<string, number>();
  const priceOf = (videoJobType: string, generateAudio: boolean) => {
    const next = normalizeForm(
      form({
        model: "hf-seedream-4.5",
        mediaType: "video",
        videoJobType,
        generateAudio,
        duration: 5,
      }),
    ).form;
    const price = priceForVariant(
      model,
      {
        mediaType: "video",
        aspectRatio: next.aspectRatio,
        duration: next.duration,
        resolution: next.resolution,
        videoJobType: next.videoJobType,
        videoMode: next.videoMode,
        generateAudio: next.generateAudio,
        videoCount: next.videoCount,
      },
      0,
      quotes,
    );
    assert.ok(
      price && price.currency === "credits",
      `no price for ${videoJobType}/${generateAudio}`,
    );
    return price.amount;
  };

  assert.equal(priceOf("kling3_0", true), 10);
  assert.equal(priceOf("kling3_0", false), 7.5);
  // Seedance charges the same either way, so the two must not diverge there.
  assert.equal(priceOf("seedance_2_0", true), priceOf("seedance_2_0", false));
});

// --- Atlas ---------------------------------------------------------------

test("the Atlas half of the form is kept legal alongside the other three", () => {
  const { form: next } = normalizeForm({
    ...DEFAULT_API_FORM,
    provider: "atlas",
    mediaType: "video",
    atlasVideoModel: "atlascloud/wan-2.2/image-to-video",
    // Carried over from a model that has them; neither exists on Wan 2.2.
    atlasVideoParams: { resolution: "1080p", bitrate_mode: "high", duration: 8 },
  });

  assert.equal(next.atlasVideoParams.duration, 8, "a shared, legal value should survive");
  assert.equal(next.atlasVideoParams.resolution, "480p", "1080p is not on this model");
  assert.ok(
    !("bitrate_mode" in next.atlasVideoParams),
    "a parameter the model never declared must not be carried",
  );
});

test("an Atlas model that has left the catalogue falls back instead of throwing", () => {
  // The catalogue is regenerated from a live vendor, so a persisted form can
  // name a model that no longer exists. Wedging the whole tab would be a much
  // worse outcome than reverting to the default.
  const { form: next } = normalizeForm({
    ...DEFAULT_API_FORM,
    provider: "atlas",
    atlasImageModel: "vendor/model-that-was-removed",
  });
  assert.ok(isAtlasModelId(next.atlasImageModel));
});

test("switching to Atlas and back leaves the other providers' settings intact", () => {
  const start = normalizeForm({
    ...DEFAULT_API_FORM,
    model: "seedream-5-lite",
    provider: "fal",
    imageSizeTier: "3K",
    aspectRatio: "2:1",
  }).form;

  const viaAtlas = normalizeForm({ ...start, provider: "atlas" }).form;
  const back = normalizeForm({ ...viaAtlas, provider: "fal" }).form;

  assert.equal(back.imageSizeTier, "3K");
  assert.equal(back.aspectRatio, "2:1");
  assert.equal(back.model, "seedream-5-lite");
});

test("Atlas clamps are only announced while Atlas is the active provider", () => {
  const illegal = { resolution: "1080p" };
  const onAtlas = normalizeForm({
    ...DEFAULT_API_FORM,
    provider: "atlas",
    mediaType: "video",
    atlasVideoModel: "atlascloud/wan-2.2/image-to-video",
    atlasVideoParams: illegal,
  });
  assert.ok(onAtlas.adjustments.length > 0);

  // The same illegal value while composing on fal would report a correction to
  // a control that is not on screen.
  const onFal = normalizeForm({
    ...DEFAULT_API_FORM,
    provider: "fal",
    model: "seedream-4.5",
    mediaType: "video",
    atlasVideoModel: "atlascloud/wan-2.2/image-to-video",
    atlasVideoParams: illegal,
  });
  assert.deepEqual(onFal.adjustments, []);
});

test("each media type keeps its own Atlas settings across a round trip", () => {
  // One shared bag was re-normalised against whichever model the current media
  // type pointed at, so Image → Video → Image came back with the image model's
  // settings reset to defaults.
  const start = normalizeForm({
    ...DEFAULT_API_FORM,
    provider: "atlas",
    mediaType: "image",
    atlasImageModel: "black-forest-labs/flux-schnell",
  }).form;

  const withImageSettings = normalizeForm({
    ...start,
    atlasImageParams: { ...start.atlasImageParams, strength: 0.35 },
  }).form;
  assert.equal(withImageSettings.atlasImageParams.strength, 0.35);

  const onVideo = normalizeForm({ ...withImageSettings, mediaType: "video" }).form;
  const backOnImage = normalizeForm({ ...onVideo, mediaType: "image" }).form;
  assert.equal(backOnImage.atlasImageParams.strength, 0.35, "image settings were destroyed");
});

test("withRegistryModel moves the provider with the model", () => {
  // The entry points that restore a model — Reproduce, ?model= — know only the
  // model. Setting it alone left `provider` pointing elsewhere, so reproducing
  // a fal clip while sitting on Atlas generated an Atlas job.
  const onAtlas = normalizeForm({ ...DEFAULT_API_FORM, provider: "atlas" }).form;
  const reproduced = normalizeForm(withRegistryModel(onAtlas, "seedream-5-lite")).form;
  assert.equal(reproduced.provider, "fal");
  assert.equal(reproduced.model, "seedream-5-lite");

  const toGrok = normalizeForm(withRegistryModel(reproduced, "grok")).form;
  assert.equal(toGrok.provider, "grok");
});

test("normalizing an Atlas form does not drag the provider back to the legacy model", () => {
  // The mirror image, and the reason reconciliation cannot live in normalizeForm:
  // `model` is dormant while Atlas drives the form.
  const onAtlas = normalizeForm({
    ...DEFAULT_API_FORM,
    provider: "atlas",
    model: "seedream-5-lite",
  }).form;
  assert.equal(onAtlas.provider, "atlas");
  assert.equal(normalizeForm(onAtlas).form.provider, "atlas");
});

test("the Atlas image fan-out is capped at what the form offers", () => {
  // A count from a form normalizeForm never saw must not exceed the list:
  // anything above 10 would have quoted ten jobs and charged for more.
  const model = ATLAS_MODELS.find(
    (entry) => entry.media === "image" && atlasBatchParam(entry) === undefined,
  );
  assert.ok(model, "expected an image model with no batch parameter of its own");
  const form = { ...DEFAULT_API_FORM, provider: "atlas" as const, mediaType: "image" as const };
  assert.equal(atlasJobsFor(model, { ...form, count: 12 }), 10);
  assert.equal(atlasJobsFor(model, { ...form, count: 8 }), 8);
  assert.equal(atlasJobsFor(model, { ...form, count: 3 }), 3);
  assert.equal(atlasJobsFor(model, { ...form, count: 0 }), 1);
});

test("a model that batches sends its total as equal requests", () => {
  // Qwen Image 3.0 takes `n` up to 4. Ten images used to be out of reach; now
  // they are five requests of two, and the parameter carries the two.
  const qwen = getAtlasModel("qwen-image-3.0/text-to-image");
  const at = (count: number) =>
    normalizeForm({
      ...DEFAULT_API_FORM,
      provider: "atlas",
      mediaType: "image",
      atlasImageModel: qwen.id,
      count,
    }).form;
  const plan = (count: number) => {
    const form = at(count);
    return [form.atlasImageParams.n, atlasJobsFor(qwen, form)];
  };
  assert.deepEqual(plan(1), [1, 1]);
  assert.deepEqual(plan(3), [3, 1]);
  assert.deepEqual(plan(4), [4, 1]);
  assert.deepEqual(plan(6), [3, 2]);
  assert.deepEqual(plan(8), [4, 2]);
  assert.deepEqual(plan(10), [2, 5]);

  // The price is the one request's times the requests: ten at $0.03.
  const ten = at(10);
  near(
    quoteAtlas({ model: qwen.id, params: ten.atlasImageParams, jobs: atlasJobsFor(qwen, ten) })
      .usd!,
    0.3,
  );
  near(quoteAtlasImages({ model: qwen.id, params: at(1).atlasImageParams, images: 10 }).usd!, 0.3);

  // Each request's size is one the schema accepts — enums and one-per-request
  // models included — and the sizes always add up to the total.
  for (const model of ATLAS_MODELS) {
    const split = model.media === "image" ? atlasBatchSplit(model, 1) : null;
    if (!split) continue;
    for (const count of ATLAS_FANOUT_COUNTS) {
      const { perRequest, requests } = atlasBatchSplit(model, count)!;
      assert.equal(perRequest * requests, count, `${model.id} × ${count}`);
      const value = atlasBatchValue(split.param, perRequest);
      assert.deepEqual(
        clampAtlasValue(split.param, value),
        value,
        `${model.id} cannot take ${perRequest} per request`,
      );
      assert.ok(requests <= 10, `${model.id} × ${count} needs ${requests} requests`);
    }
  }

  // The batch parameter is not drawn as its own control.
  assert.ok(!atlasFormParams(qwen).some((param) => param.name === "n"));
});

test("typing a tag moves Seedance onto the endpoint that reads tags", () => {
  // The reported bug: `bytedance/seedance-2.0/image-to-video` is a first/last
  // frame pair and reads nothing out of the prompt, so `@image1` did nothing.
  // Its sibling `/reference-to-video` is exactly the endpoint that does.
  const { form: next, adjustments } = normalizeForm(
    {
      ...DEFAULT_API_FORM,
      provider: "atlas",
      mediaType: "video",
      atlasVideoModel: "bytedance/seedance-2.0/image-to-video",
      prompt: "woman @image1 meets a man @image2",
    },
    2,
  );
  assert.equal(next.atlasVideoModel, "bytedance/seedance-2.0/reference-to-video");
  assert.ok(
    adjustments.some((line) => line.includes("→")),
    "the switch should be announced",
  );
});

test("an endpoint is never abandoned just because nothing is attached yet", () => {
  // The reported bug: picking "Seedance 2.0 Reference-to-Video" moved the form
  // to text-to-video before anything could be attached, and text-to-video has
  // no reference slots — so the upload block vanished, leaving nothing to
  // attach and therefore nothing to tag.
  const base = {
    ...DEFAULT_API_FORM,
    provider: "atlas" as const,
    mediaType: "video" as const,
    prompt: "a beach at golden hour",
  };

  for (const id of [
    "bytedance/seedance-2.0/reference-to-video",
    "bytedance/seedance-2.0/image-to-video",
  ]) {
    assert.equal(
      normalizeForm({ ...base, atlasVideoModel: id }, 0).form.atlasVideoModel,
      id,
      `${id} was abandoned with nothing attached`,
    );
  }

  // Attaching something a text endpoint cannot carry still routes — that is the
  // case the routing exists for.
  const one = normalizeForm(
    { ...base, atlasVideoModel: "bytedance/seedance-2.0/text-to-video" },
    1,
  ).form;
  assert.equal(one.atlasVideoModel, "bytedance/seedance-2.0/image-to-video");
});

test("a deliberate choice of reference-to-video with one image is left alone", () => {
  // One image on a reference endpoint is a character reference, and demoting it
  // to image-to-video would turn that into a first frame — a different request.
  const { form: next } = normalizeForm(
    {
      ...DEFAULT_API_FORM,
      provider: "atlas",
      mediaType: "video",
      atlasVideoModel: "bytedance/seedance-2.0/reference-to-video",
      prompt: "a woman walking",
    },
    1,
  );
  assert.equal(next.atlasVideoModel, "bytedance/seedance-2.0/reference-to-video");
});

test("more images than the endpoint has slots moves to the list endpoint", () => {
  // image-to-video has two slots (image + last_image); a third has nowhere to go.
  const { form: next } = normalizeForm(
    {
      ...DEFAULT_API_FORM,
      provider: "atlas",
      mediaType: "video",
      atlasVideoModel: "bytedance/seedance-2.0/image-to-video",
      prompt: "a chase",
    },
    3,
  );
  assert.equal(next.atlasVideoModel, "bytedance/seedance-2.0/reference-to-video");
});

test("Wan 3.0 routes text and URL-only mixed references without a hidden endpoint choice", () => {
  const base = {
    ...DEFAULT_API_FORM,
    provider: "atlas" as const,
    mediaType: "video" as const,
    atlasVideoModel: "alibaba/wan-3.0/image-to-video",
    prompt: "a continuous product shot",
  };

  const text = normalizeForm(base, 0).form;
  assert.equal(text.atlasVideoModel, "alibaba/wan-3.0/text-to-video");

  const referenced = normalizeForm(
    {
      ...text,
      atlasVideoParams: {
        ...text.atlasVideoParams,
        refers_video_urls: ["https://media.example/motion.mp4"],
      },
    },
    0,
  ).form;
  assert.equal(referenced.atlasVideoModel, "alibaba/wan-3.0/reference-to-video");
  assert.deepEqual(referenced.atlasVideoParams.refers_video_urls, [
    "https://media.example/motion.mp4",
  ]);

  const documented = normalizeForm(
    {
      ...text,
      atlasVideoParams: {
        ...text.atlasVideoParams,
        enable_thinking: true,
        link: "https://example.com/research",
      },
    },
    0,
  ).form;
  assert.equal(documented.atlasVideoModel, "alibaba/wan-3.0/reference-to-video");
  assert.equal(documented.atlasVideoParams.link, "https://example.com/research");
  assert.equal(documented.atlasVideoParams.enable_thinking, true);
});

test("Wan 3.0 image tags route Standard and Prime to their reference endpoints", () => {
  for (const base of ["alibaba/wan-3.0", "alibaba/wan-3.0-prime"]) {
    const { form } = normalizeForm(
      {
        ...DEFAULT_API_FORM,
        provider: "atlas",
        mediaType: "video",
        atlasVideoModel: `${base}/image-to-video`,
        prompt: "the person from @image1 enters the room",
      },
      1,
    );

    assert.equal(form.atlasVideoModel, `${base}/reference-to-video`);
  }
});

test("Wan 3.0 keeps an explicit frame or reference choice with the same two images", () => {
  for (const base of ["alibaba/wan-3.0", "alibaba/wan-3.0-prime"]) {
    const common = {
      ...DEFAULT_API_FORM,
      provider: "atlas" as const,
      mediaType: "video" as const,
      prompt: "two people cross the room",
    };

    assert.equal(
      normalizeForm({ ...common, atlasVideoModel: `${base}/image-to-video` }, 2).form
        .atlasVideoModel,
      `${base}/image-to-video`,
    );
    assert.equal(
      normalizeForm({ ...common, atlasVideoModel: `${base}/reference-to-video` }, 2).form
        .atlasVideoModel,
      `${base}/reference-to-video`,
    );
  }
});

test("routing never crosses media types", () => {
  // alibaba/wan-2.5 has both text-to-image and text-to-video siblings; sending
  // an image request to a video endpoint would be a far worse surprise.
  const { form: next } = normalizeForm(
    {
      ...DEFAULT_API_FORM,
      provider: "atlas",
      mediaType: "image",
      atlasImageModel: "alibaba/wan-2.5/text-to-image",
      prompt: "a portrait",
    },
    0,
  );
  assert.equal(getAtlasModel(next.atlasImageModel).media, "image");
});

test("reproducing an Atlas row restores its model and its parameters", () => {
  // What the API panel's recreate() composes. Before this, `modelIdOf` could
  // not name an Atlas slug, fell back to "grok", and the row was restored as a
  // Grok generation with the Atlas model left on whatever the form last held.
  const model = getAtlasModel("bytedance/seedance-2.0/reference-to-video");
  const stored = { duration: 8, resolution: "1080p" };

  const restored = normalizeForm(
    withActiveAtlasParams(withAtlasModel(DEFAULT_API_FORM, model), stored),
    2,
  ).form;

  assert.equal(restored.provider, "atlas");
  assert.equal(restored.mediaType, "video");
  assert.equal(restored.atlasVideoModel, model.id);
  assert.equal(restored.atlasVideoParams.duration, 8);
  assert.equal(restored.atlasVideoParams.resolution, "1080p");
  // The image half is untouched by a video restore.
  assert.equal(restored.atlasImageModel, DEFAULT_API_FORM.atlasImageModel);
});

test("a restored batch off the button list is kept, and shown", () => {
  // GPT Image takes n up to 10; a stored row of 5 came back as 4.
  const model = getAtlasModel("openai/gpt-image-1/text-to-image");
  const restored = normalizeForm(withAtlasRow(DEFAULT_API_FORM, model, { n: 5 })).form;
  assert.equal(restored.count, 5);
  assert.equal(restored.atlasImageParams.n, 5);
  assert.equal(atlasJobsFor(model, restored), 1);
  assert.deepEqual(atlasCountOptions(5), [1, 2, 3, 4, 5, 6, 8, 10]);
  assert.deepEqual(atlasCountOptions(4), [...ATLAS_FANOUT_COUNTS]);
  assert.deepEqual(atlasCountOptions(11), [...ATLAS_FANOUT_COUNTS]);
});

test("a form stored before the count drove the batch keeps what it sent", () => {
  // Before version 2, GPT Image with `count: 4` (left over from another
  // provider) and `n: 1` sent one image for $0.009. Normalised as it is, the
  // count would have rewritten `n` to 4 and quadrupled the next charge.
  const stored = {
    ...DEFAULT_API_FORM,
    provider: "atlas" as const,
    mediaType: "image" as const,
    atlasImageModel: "openai/gpt-image-1/text-to-image",
    atlasImageParams: { n: 1 },
    count: 4,
  };
  const { formVersion: _, ...legacy } = stored;
  const restored = hydrateForm(JSON.stringify(legacy));
  assert.equal(restored.count, 1);
  assert.equal(restored.atlasImageParams.n, 1);
  assert.equal(restored.formVersion, 2);

  // Its batch size is what it made, so a stored n of 3 is a count of 3.
  const three = hydrateForm(JSON.stringify({ ...legacy, atlasImageParams: { n: 3 } }));
  assert.equal(three.count, 3);
  assert.equal(three.atlasImageParams.n, 3);

  // A current form is taken as it is: its count is the total.
  assert.equal(hydrateForm(JSON.stringify(stored)).count, 4);
  assert.equal(hydrateForm(JSON.stringify(stored)).atlasImageParams.n, 4);

  // Off Atlas the count was always live, so nothing moves.
  const onGrok = hydrateForm(JSON.stringify({ ...legacy, provider: "grok", model: "grok" }));
  assert.equal(onGrok.count, 4);
});

test("reproducing an Atlas image row lands on the image half", () => {
  const model = getAtlasModel("black-forest-labs/flux-schnell");
  const restored = normalizeForm(withAtlasRow(DEFAULT_API_FORM, model, { num_images: 4 }), 0).form;

  assert.equal(restored.mediaType, "image");
  assert.equal(restored.atlasImageModel, model.id);
  // The row's batch is what it made, so it comes back as the count — the
  // parameter itself is derived from the count and would otherwise reset.
  assert.equal(restored.count, 4);
  assert.equal(restored.atlasImageParams.num_images, 4);
  assert.equal(atlasJobsFor(model, restored), 1);
  assert.equal(restored.atlasVideoModel, DEFAULT_API_FORM.atlasVideoModel);
});

test("a saved form on a renamed Atlas endpoint moves to its successor with its settings", () => {
  const saved: ApiFormState = {
    ...DEFAULT_API_FORM,
    provider: "atlas",
    mediaType: "image",
    atlasImageModel: "youchuan/v8.2/text-to-image",
    atlasImageParams: { aspect_ratio: "16:9", stylize: 250 },
  };
  const { form, adjustments } = normalizeForm(saved);
  assert.equal(form.atlasImageModel, "midjourney/v8.2/text-to-image");
  assert.equal(form.atlasImageParams.aspect_ratio, "16:9");
  assert.equal(form.atlasImageParams.stylize, 250);
  assert.ok(adjustments.some((line) => line.includes("Midjourney")));
});
