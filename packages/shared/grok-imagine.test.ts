import assert from "node:assert/strict";
import test from "node:test";

import {
  GROK_IMAGE_MODEL_QUALITY,
  GROK_IMAGE_MODEL_STANDARD,
  GROK_IMAGE_MODEL_V2,
  GROK_VIDEO_MODEL_BASE,
  GROK_VIDEO_MODEL_LITE,
  GROK_VIDEO_MODEL_V15,
  centerCropRect,
  getApiModel,
  videoResolutions,
} from "./api-models";
import { formatMetered, formatPrice } from "./api-pricing";
import { priceForVariant, variantFor } from "./api-price";
import {
  buildGrokImageRequest,
  buildGrokVideoRequest,
  clampKeyframeTime,
  defaultKeyframeTime,
  grokFrameCrops,
  grokImageMeteredUsd,
  grokImageModelOf,
  grokImageRequestFor,
  grokMeteredUsdForRow,
  grokSourceResolution,
  grokVideoContext,
  grokVideoIssues,
  grokVideoMeteredUsd,
  grokVideoOptions,
  grokVideoOutputSeconds,
  parseGrokSourceVideo,
  planGrokVideo,
  remapGrokFrameRoles,
  resolveGrokFrameRoles,
  sanitizeGrokFrameRoles,
  usdFromTicks,
  withGrokFrameRole,
  withGrokKeyframeTime,
  type GrokFrameRole,
} from "./grok-imagine";
import { toGrokApiPromptMapped } from "./grok-prompt";
import { isAllowedImageKey, isAllowedVideoKey, isGrokSourceVideoKey } from "./image-key";
import { isMp4, mp4DurationSeconds, mp4VideoDimensions } from "./mp4";
import {
  DEFAULT_API_FORM,
  grokFrameCropsFor,
  grokVideoOptionsFor,
  hydrateForm,
  normalizeForm,
  type ApiFormState,
} from "./normalize-form";

const grok = getApiModel("grok");
const form = (overrides: Partial<ApiFormState>): ApiFormState => ({
  ...DEFAULT_API_FORM,
  provider: "grok",
  model: "grok",
  ...overrides,
});
const urls = (count: number) => Array.from({ length: count }, (_, index) => `data:${index}`);
const SOURCE = "grok/1729000000000_abc123.mp4";

// ---------------------------------------------------------------------------
// Images
// ---------------------------------------------------------------------------

test("each quality names its model, and 2.0 Auto sends quality: auto", () => {
  assert.deepEqual(grokImageRequestFor("standard"), { model: GROK_IMAGE_MODEL_STANDARD });
  assert.deepEqual(grokImageRequestFor("quality"), { model: GROK_IMAGE_MODEL_QUALITY });
  assert.deepEqual(grokImageRequestFor("v2-low"), { model: GROK_IMAGE_MODEL_V2, quality: "low" });
  assert.deepEqual(grokImageRequestFor("v2-medium"), {
    model: GROK_IMAGE_MODEL_V2,
    quality: "medium",
  });
  assert.deepEqual(grokImageRequestFor("v2-auto"), { model: GROK_IMAGE_MODEL_V2, quality: "auto" });
  // Rows from before the switch, and anything unknown, keep meaning Quality.
  assert.deepEqual(grokImageRequestFor(undefined), { model: GROK_IMAGE_MODEL_QUALITY });
  assert.deepEqual(grokImageRequestFor("ultra"), { model: GROK_IMAGE_MODEL_QUALITY });
});

test("a row names the image model it ran on, and what 2.0 Auto served", () => {
  assert.deepEqual(grokImageModelOf({ quality: "v2-low", referenceCount: 0 }), {
    label: "2.0 Low",
    model: GROK_IMAGE_MODEL_V2,
    quality: "low",
  });
  assert.deepEqual(grokImageModelOf({ quality: "v2-auto", referenceCount: 0 }).served, "low");
  assert.deepEqual(grokImageModelOf({ quality: "v2-auto", referenceCount: 2 }).served, "medium");
  assert.deepEqual(grokImageModelOf({ quality: "standard", referenceCount: 0 }), {
    label: "Standard",
    model: GROK_IMAGE_MODEL_STANDARD,
  });
  // Rows from before the switch ran on Quality.
  assert.deepEqual(grokImageModelOf({ quality: undefined, referenceCount: 1 }), {
    label: "Quality",
    model: GROK_IMAGE_MODEL_QUALITY,
  });
});

test("a plain prompt is one generation request carrying n and the ratio", () => {
  const request = buildGrokImageRequest({
    quality: "v2-auto",
    prompt: "a lighthouse",
    resolution: "2k",
    count: 4,
    aspectRatio: "21:9",
    imageUrls: [],
  });
  assert.equal(request.path, "images/generations");
  assert.equal(request.requests, 1);
  assert.deepEqual(request.body, {
    model: GROK_IMAGE_MODEL_V2,
    prompt: "a lighthouse",
    resolution: "2k",
    response_format: "b64_json",
    quality: "auto",
    n: 4,
    aspect_ratio: "21:9",
  });
});

test("a five-source 2.0 edit is one edit per output, with the ratio override kept", () => {
  const request = buildGrokImageRequest({
    quality: "v2-medium",
    prompt: "put @image1 in the room from @image5",
    resolution: "1k",
    count: 2,
    aspectRatio: "16:9",
    imageUrls: urls(5),
  });
  assert.equal(request.path, "images/edits");
  assert.equal(request.requests, 2);
  assert.equal(request.body.n, undefined);
  assert.equal(request.body.prompt, "put image 1 in the room from image 5");
  assert.equal((request.body.images as unknown[]).length, 5);
  assert.equal(request.body.aspect_ratio, "16:9");
  // A single source uses `image`, and "auto" leaves the ratio to the source.
  const single = buildGrokImageRequest({
    quality: "quality",
    prompt: "sketch",
    resolution: "2k",
    count: 1,
    aspectRatio: "auto",
    imageUrls: urls(1),
  });
  assert.deepEqual(single.body.image, { url: "data:0" });
  assert.equal(single.body.aspect_ratio, undefined);
  assert.equal(single.body.quality, undefined);
});

// ---------------------------------------------------------------------------
// Video plans
// ---------------------------------------------------------------------------

test("without roles, the old rule holds: one image is the first frame, two are references", () => {
  assert.equal(planGrokVideo({ referenceCount: 0 }).kind, "text");
  const one = planGrokVideo({ referenceCount: 1 });
  assert.equal(one.kind, "image");
  assert.equal(one.first, 0);
  assert.equal(one.usesAspectRatio, false);
  assert.equal(one.model, GROK_VIDEO_MODEL_V15);
  const two = planGrokVideo({ referenceCount: 2 });
  assert.equal(two.kind, "reference");
  assert.deepEqual(two.references, [0, 1]);
  assert.equal(two.usesAspectRatio, true);
  assert.deepEqual(two.promptOrdinals, [1, 2]);
  // A voice makes any request reference-to-video.
  assert.equal(planGrokVideo({ referenceCount: 1, voiceCount: 1 }).kind, "reference");
  assert.equal(planGrokVideo({ referenceCount: 0, voiceCount: 1 }).kind, "reference");
});

test("a single image can be a reference rather than the first frame", () => {
  const plan = planGrokVideo({ referenceCount: 1, frameRoles: [{ role: "reference" }] });
  assert.equal(plan.kind, "reference");
  assert.equal(plan.first, null);
  assert.deepEqual(plan.references, [0]);
  assert.equal(plan.usesAspectRatio, true);
});

test("pins renumber the prompt: the first frame is image 1, references follow", () => {
  const roles: GrokFrameRole[] = [
    { role: "reference" },
    { role: "last" },
    { role: "first" },
    { role: "keyframe", at: 3 },
    { role: "reference" },
  ];
  const plan = planGrokVideo({ referenceCount: 5, frameRoles: roles, duration: 8 });
  assert.equal(plan.kind, "reference");
  assert.equal(plan.first, 2);
  assert.equal(plan.last, 1);
  assert.deepEqual(plan.keyframes, [{ index: 3, at: 3 }]);
  assert.deepEqual(plan.references, [0, 4]);
  assert.deepEqual(plan.promptOrdinals, [2, null, 1, null, 3]);
  assert.equal(plan.usesAspectRatio, false);
  assert.equal(plan.imageCount, 5);
});

test("a loop pins one image as both the first and the last frame", () => {
  const plan = planGrokVideo({ referenceCount: 1, frameRoles: [{ role: "loop" }] });
  assert.equal(plan.first, 0);
  assert.equal(plan.last, 0);
  assert.equal(plan.kind, "reference");
  assert.equal(plan.imageCount, 1);
});

test("Lite is text- or image-to-video only", () => {
  const text = planGrokVideo({ model: GROK_VIDEO_MODEL_LITE, referenceCount: 0, voiceCount: 2 });
  assert.equal(text.kind, "text");
  assert.equal(text.usesVoices, false);
  const image = planGrokVideo({
    model: GROK_VIDEO_MODEL_LITE,
    referenceCount: 1,
    // Roles mean nothing on Lite: its one image is the first frame.
    frameRoles: [{ role: "reference" }],
  });
  assert.equal(image.kind, "image");
  assert.equal(image.first, 0);
  assert.equal(image.model, GROK_VIDEO_MODEL_LITE);
  assert.deepEqual(grokVideoIssues({ model: GROK_VIDEO_MODEL_LITE, referenceCount: 2 }), [
    "1.5 Lite animates one start image and takes no references — deselect 1.",
  ]);
});

test("Edit and Extend run the base model on their own endpoints", () => {
  const edit = planGrokVideo({ mode: "edit", model: GROK_VIDEO_MODEL_LITE, referenceCount: 3 });
  assert.equal(edit.model, GROK_VIDEO_MODEL_BASE);
  assert.equal(edit.path, "videos/edits");
  assert.equal(edit.imageCount, 0);
  assert.equal(edit.usesResolution, false);
  const extend = planGrokVideo({ mode: "extend", referenceCount: 0 });
  assert.equal(extend.path, "videos/extensions");
  // Junk reads as Generate, never as an edit with no source.
  assert.equal(planGrokVideo({ mode: "remix", referenceCount: 0 }).mode, "generate");
});

// ---------------------------------------------------------------------------
// Issues
// ---------------------------------------------------------------------------

test("frame pins are refused the way xAI documents", () => {
  const issues = (
    frameRoles: GrokFrameRole[],
    extra: { duration?: number; prompt?: string } = {},
  ) => grokVideoIssues({ referenceCount: frameRoles.length, frameRoles, duration: 6, ...extra });

  // A loop is a first frame too, so it collides with an explicit one.
  assert.deepEqual(issues([{ role: "first" }, { role: "loop" }]), [
    "Only one image can be the first frame.",
  ]);
  assert.ok(
    issues(
      Array.from({ length: 5 }, (_, index) => ({ role: "keyframe" as const, at: index + 1 })),
    ).some((issue) => issue.startsWith("At most 4 keyframes")),
  );
  // Strictly inside the clip, on a 1/3-second grid.
  assert.match(issues([{ role: "keyframe", at: 6 }])[0], /strictly inside the 6 s clip/);
  assert.match(issues([{ role: "keyframe", at: 0.1 }])[0], /strictly inside/);
  assert.deepEqual(issues([{ role: "keyframe", at: 5.67 }]), []);
  assert.match(
    issues([
      { role: "keyframe", at: 2 },
      { role: "keyframe", at: 2.1 },
    ])[0],
    /same 1\/3-second slot/,
  );
  // A last frame or keyframe has no ordinal in the prompt.
  assert.match(
    issues([{ role: "first" }, { role: "last" }], { prompt: "@image1 walks to @image2" })[0],
    /@image2 is pinned as the last frame/,
  );
  assert.deepEqual(issues([{ role: "first" }, { role: "reference" }], { prompt: "@image2" }), []);
});

test("1.5 takes fourteen images, and durations are whole seconds 1–15", () => {
  assert.deepEqual(grokVideoIssues({ referenceCount: 14 }), []);
  assert.deepEqual(grokVideoIssues({ referenceCount: 15 }), [
    "1.5 takes up to 14 images — deselect 1.",
  ]);
  assert.deepEqual(grokVideoIssues({ referenceCount: 0, duration: 1 }), []);
  assert.equal(grokVideoIssues({ referenceCount: 0, duration: 16 }).length, 1);
  assert.equal(grokVideoIssues({ referenceCount: 0, duration: 2.5 }).length, 1);
});

test("Edit wants a clip of at most 8.7 s; Extend a 2–15 s clip and a 2–10 s extension", () => {
  assert.match(grokVideoIssues({ mode: "edit", referenceCount: 0 })[0], /needs a source video/);
  assert.deepEqual(
    grokVideoIssues({ mode: "edit", referenceCount: 0, source: { seconds: 8.7 } }),
    [],
  );
  assert.match(
    grokVideoIssues({ mode: "edit", referenceCount: 0, source: { seconds: 10 } })[0],
    /at most 8.7 s — this one is 10 s/,
  );
  // An unknown length is refused: xAI judges it only after the job is paid for.
  assert.match(
    grokVideoIssues({ mode: "edit", referenceCount: 0, source: {} })[0],
    /length is unknown/,
  );
  // The limits are exact — the lengths are measured to 0.01 s.
  assert.equal(
    grokVideoIssues({ mode: "edit", referenceCount: 0, source: { seconds: 8.72 } }).length,
    1,
  );
  assert.equal(
    grokVideoIssues({ mode: "extend", referenceCount: 0, source: { seconds: 15.04 } }).length,
    1,
  );
  assert.match(
    grokVideoIssues({ mode: "extend", referenceCount: 0, source: { seconds: 1.5 } })[0],
    /2–15 s/,
  );
  assert.match(
    grokVideoIssues({
      mode: "extend",
      referenceCount: 0,
      source: { seconds: 6 },
      extendDuration: 12,
    })[0],
    /2–10 s long/,
  );
  assert.match(
    grokVideoIssues({
      mode: "edit",
      referenceCount: 0,
      source: { seconds: 4 },
      prompt: "@image1",
    })[0],
    /takes no images/,
  );
});

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

test("a request without the new fields is the 1.5 request the app always sent", () => {
  const image = buildGrokVideoRequest({
    referenceCount: 1,
    prompt: "@image1 waves",
    imageUrls: urls(1),
    voices: ["eve"],
    duration: 6,
    resolution: "720p",
    aspectRatio: "16:9",
  });
  assert.equal(image.path, "videos/generations");
  assert.deepEqual(image.body, {
    model: GROK_VIDEO_MODEL_V15,
    prompt: "image 1 waves",
    duration: 6,
    resolution: "720p",
    image: { url: "data:0" },
    reference_audios: [{ voice_id: "eve" }],
  });
  const references = buildGrokVideoRequest({
    referenceCount: 2,
    prompt: "@image1 meets @image2",
    imageUrls: urls(2),
    duration: 10,
    resolution: "480p",
    aspectRatio: "auto",
  });
  assert.deepEqual(references.body, {
    model: GROK_VIDEO_MODEL_V15,
    prompt: "image 1 meets image 2",
    duration: 10,
    resolution: "480p",
    reference_images: [{ url: "data:0" }, { url: "data:1" }],
    aspect_ratio: "16:9",
  });
});

test("first, last and keyframes land in their own fields", () => {
  const request = buildGrokVideoRequest({
    referenceCount: 4,
    frameRoles: [
      { role: "first" },
      { role: "keyframe", at: 4 },
      { role: "last" },
      { role: "reference" },
    ],
    prompt: "@image4 walks through the door in @image1",
    imageUrls: urls(4),
    duration: 8,
    resolution: "720p",
    aspectRatio: "9:16",
  });
  assert.deepEqual(request.body, {
    model: GROK_VIDEO_MODEL_V15,
    prompt: "image 2 walks through the door in image 1",
    duration: 8,
    resolution: "720p",
    image: { url: "data:0" },
    last_frame: { url: "data:2" },
    keyframes: [{ image: { url: "data:1" }, timestamp_s: 4 }],
    reference_images: [{ url: "data:3" }],
  });
});

test("Lite sends its own slug, one image at most, and never voices", () => {
  const request = buildGrokVideoRequest({
    model: GROK_VIDEO_MODEL_LITE,
    referenceCount: 0,
    prompt: "rain on a window",
    imageUrls: [],
    voices: ["ara"],
    duration: 12,
    resolution: "1080p",
    aspectRatio: "5:2",
  });
  assert.deepEqual(request.body, {
    model: GROK_VIDEO_MODEL_LITE,
    prompt: "rain on a window",
    duration: 12,
    resolution: "1080p",
    aspect_ratio: "5:2",
  });
});

test("Edit sends only the clip and the prompt; Extend adds the extension length", () => {
  const edit = buildGrokVideoRequest({
    mode: "edit",
    referenceCount: 0,
    source: { seconds: 6 },
    prompt: "give her a red coat, keep everything else",
    imageUrls: [],
    duration: 15,
    resolution: "1080p",
    aspectRatio: "16:9",
    sourceVideoUrl: "https://media.example/grok/a.mp4",
  });
  assert.equal(edit.path, "videos/edits");
  assert.deepEqual(edit.body, {
    model: GROK_VIDEO_MODEL_BASE,
    prompt: "give her a red coat, keep everything else",
    video: { url: "https://media.example/grok/a.mp4" },
  });
  const extend = buildGrokVideoRequest({
    mode: "extend",
    referenceCount: 0,
    source: { seconds: 10 },
    extendDuration: 4,
    prompt: "the camera pulls back",
    imageUrls: [],
    sourceVideoUrl: "data:video/mp4;base64,AAAA",
  });
  assert.equal(extend.path, "videos/extensions");
  assert.deepEqual(extend.body, {
    model: GROK_VIDEO_MODEL_BASE,
    prompt: "the camera pulls back",
    video: { url: "data:video/mp4;base64,AAAA" },
    duration: 4,
  });
  assert.throws(
    () =>
      buildGrokVideoRequest({
        mode: "extend",
        referenceCount: 0,
        source: { seconds: 10 },
        prompt: "x",
        imageUrls: [],
      }),
    /No source video/,
  );
});

test("the builder refuses what the issues list refuses", () => {
  assert.throws(
    () =>
      buildGrokVideoRequest({
        referenceCount: 2,
        frameRoles: [{ role: "first" }, { role: "first" }],
        prompt: "x",
        imageUrls: urls(2),
      }),
    /Only one image can be the first frame/,
  );
});

// ---------------------------------------------------------------------------
// Resolutions and form options
// ---------------------------------------------------------------------------

test("1080p is withheld at reference-to-video on 1.5 only, and Edit has no resolution", () => {
  const caps = grok.video;
  const resolutions = (input: Parameters<typeof grokVideoContext>[0]) => [
    ...videoResolutions(
      caps,
      undefined,
      undefined,
      undefined,
      input.referenceCount,
      input.voiceCount,
      grokVideoContext(input),
    ),
  ];
  assert.deepEqual(resolutions({ referenceCount: 1 }), ["480p", "720p", "1080p"]);
  // A pinned last frame is reference-to-video even with one image.
  assert.deepEqual(resolutions({ referenceCount: 1, frameRoles: [{ role: "loop" }] }), [
    "480p",
    "720p",
  ]);
  assert.deepEqual(resolutions({ referenceCount: 1, frameRoles: [{ role: "reference" }] }), [
    "480p",
    "720p",
  ]);
  assert.deepEqual(
    resolutions({ model: GROK_VIDEO_MODEL_LITE, referenceCount: 1, voiceCount: 2 }),
    ["480p", "720p", "1080p"],
  );
  assert.deepEqual(resolutions({ mode: "edit", referenceCount: 0 }), []);
});

test("the form hides what the mode does not take", () => {
  const lite = grokVideoOptions({ model: GROK_VIDEO_MODEL_LITE, referenceCount: 0 });
  assert.equal(lite.voices, null);
  assert.equal(lite.frameRoleChoices, null);
  assert.equal(lite.maxImages, 1);
  assert.ok(lite.aspectRatios?.includes("21:9"));

  const pinned = grokVideoOptions({ referenceCount: 1 });
  assert.equal(pinned.aspectRatios, null);
  assert.ok(pinned.voices && pinned.frameRoleChoices);
  assert.equal(pinned.maxImages, 14);

  const extend = grokVideoOptions({ mode: "extend", referenceCount: 0 });
  assert.equal(extend.models, null);
  assert.equal(extend.maxImages, 0);
  assert.equal(extend.durationField, "grokExtendDuration");
  assert.deepEqual(extend.durations, [2, 3, 4, 5, 6, 7, 8, 9, 10]);
  assert.deepEqual(extend.source, { min: 2, max: 15 });
  assert.equal(extend.aspectRatios, null);
  assert.deepEqual(extend.resolutions, []);

  const edit = grokVideoOptions({ mode: "edit", referenceCount: 0 });
  assert.equal(edit.durationField, null);
  assert.deepEqual(edit.source, { min: 0, max: 8.7 });
});

test("a pinned first frame offers crop ratios instead of the ratio xAI ignores", () => {
  const pinned = grokVideoOptions({ referenceCount: 1 });
  assert.equal(pinned.aspectRatios, null);
  assert.equal(pinned.frameAspectRatios?.[0], "auto");
  assert.ok(pinned.frameAspectRatios?.includes("9:16"));
  // Lite's one image is its first frame.
  const lite = grokVideoOptions({ model: GROK_VIDEO_MODEL_LITE, referenceCount: 1 });
  assert.equal(lite.frameAspectRatios?.[0], "auto");

  // Nothing to crop: no image, references only, a last frame only, or a clip.
  assert.equal(grokVideoOptions({ referenceCount: 0 }).frameAspectRatios, null);
  assert.equal(grokVideoOptions({ referenceCount: 2 }).frameAspectRatios, null);
  assert.equal(
    grokVideoOptions({ referenceCount: 1, frameRoles: [{ role: "last" }] }).frameAspectRatios,
    null,
  );
  assert.equal(grokVideoOptions({ mode: "edit", referenceCount: 1 }).frameAspectRatios, null);
});

test("every pinned frame is cropped to the chosen ratio, and references never are", () => {
  assert.deepEqual(grokFrameCrops({ referenceCount: 1 }, "9:16"), ["9:16"]);
  assert.deepEqual(grokFrameCrops({ referenceCount: 1 }, "auto"), [null]);
  assert.deepEqual(grokFrameCrops({ referenceCount: 1 }, undefined), [null]);
  // Not a ratio Grok video takes.
  assert.deepEqual(grokFrameCrops({ referenceCount: 1 }, "7:3"), [null]);

  const roles: GrokFrameRole[] = [
    { role: "reference" },
    { role: "first" },
    { role: "keyframe", at: 2 },
    { role: "last" },
  ];
  assert.deepEqual(grokFrameCrops({ referenceCount: 4, frameRoles: roles }, "16:9"), [
    null,
    "16:9",
    "16:9",
    "16:9",
  ]);
  assert.deepEqual(
    grokFrameCrops({ referenceCount: 2, frameRoles: [{ role: "loop" }, null] }, "1:1"),
    ["1:1", null],
  );

  // Without a first frame the request names the ratio itself.
  assert.deepEqual(
    grokFrameCrops(
      { referenceCount: 2, frameRoles: [{ role: "reference" }, { role: "last" }] },
      "16:9",
    ),
    [null, null],
  );
  // Lite sends only its first image; Edit and Extend send none.
  assert.deepEqual(grokFrameCrops({ model: GROK_VIDEO_MODEL_LITE, referenceCount: 2 }, "16:9"), [
    "16:9",
    null,
  ]);
  assert.deepEqual(grokFrameCrops({ mode: "extend", referenceCount: 1 }, "16:9"), [null]);
});

test("a centre crop cuts the edge that is too long, and nothing when the shape fits", () => {
  assert.deepEqual(centerCropRect(768, 768, "16:9"), { x: 0, y: 168, width: 768, height: 432 });
  assert.deepEqual(centerCropRect(1920, 1080, "9:16"), { x: 656, y: 0, width: 608, height: 1080 });
  assert.deepEqual(centerCropRect(1000, 800, "21:9"), { x: 0, y: 185, width: 1000, height: 429 });
  const whole = { x: 0, y: 0, width: 1280, height: 720 };
  assert.deepEqual(centerCropRect(1280, 720, "16:9"), whole);
  assert.deepEqual(centerCropRect(1280, 720, "auto"), whole);
  assert.deepEqual(centerCropRect(1280, 720, undefined), whole);
  assert.deepEqual(centerCropRect(1280, 720, "nonsense"), whole);
});

// ---------------------------------------------------------------------------
// Roles over time
// ---------------------------------------------------------------------------

test("roles follow their image when the selection changes", () => {
  const roles: (GrokFrameRole | null)[] = [{ role: "first" }, null, { role: "last" }];
  // Deselecting the first image must not promote the second into its slot.
  assert.deepEqual(remapGrokFrameRoles(roles, ["a", "b", "c"], ["b", "c"]), [
    null,
    { role: "last" },
  ]);
  // A new image arrives automatic.
  assert.deepEqual(remapGrokFrameRoles(roles, ["a", "b", "c"], ["a", "b", "c", "d"]), [
    { role: "first" },
    null,
    { role: "last" },
    null,
  ]);
  assert.deepEqual(resolveGrokFrameRoles([null, { role: "last" }], 2), [
    { role: "reference" },
    { role: "last" },
  ]);
  assert.deepEqual(sanitizeGrokFrameRoles([{ role: "nope" }, { role: "keyframe" }, 3]), [
    null,
    { role: "keyframe", at: 1 },
    null,
  ]);
  assert.deepEqual(sanitizeGrokFrameRoles("junk"), []);
});

test("picking a pin moves it off the image that held it", () => {
  // Three automatic references; image 2 becomes the first frame.
  assert.deepEqual(withGrokFrameRole([], 3, 1, "first", 6), [
    { role: "reference" },
    { role: "first" },
    { role: "reference" },
  ]);
  // A lone image is the first frame automatically; making it a reference is explicit.
  assert.deepEqual(withGrokFrameRole([], 1, 0, "reference", 6), [{ role: "reference" }]);
  // First on another image takes the first end of a loop and leaves its last.
  assert.deepEqual(withGrokFrameRole([{ role: "loop" }, null], 2, 1, "first", 6), [
    { role: "last" },
    { role: "first" },
  ]);
  // A loop takes both ends from everyone else.
  assert.deepEqual(
    withGrokFrameRole([{ role: "first" }, { role: "last" }, null], 3, 2, "loop", 6),
    [{ role: "reference" }, { role: "reference" }, { role: "loop" }],
  );
  // Keyframes land on free slots mid-clip, and keep their time when re-picked.
  const one = withGrokFrameRole([], 2, 0, "keyframe", 6);
  assert.deepEqual(one[0], { role: "keyframe", at: 3 });
  const two = withGrokFrameRole(one, 2, 1, "keyframe", 6);
  assert.deepEqual(two[1], { role: "keyframe", at: 3.33 });
  assert.deepEqual(withGrokFrameRole(two, 2, 1, "keyframe", 6)[1], { role: "keyframe", at: 3.33 });
  assert.deepEqual(withGrokKeyframeTime(two, 2, 1, 99, 6)[1], { role: "keyframe", at: 5.67 });
  // Only a keyframe has a time to move.
  assert.deepEqual(withGrokKeyframeTime([], 1, 0, 2, 6), [{ role: "first" }]);
});

test("keyframe times start mid-clip, avoid taken slots and stay inside", () => {
  assert.equal(defaultKeyframeTime(6, []), 3);
  assert.equal(defaultKeyframeTime(6, [3]), 3.33);
  assert.equal(clampKeyframeTime(9, 6), 5.67);
  assert.equal(clampKeyframeTime(0, 6), 0.33);
  assert.equal(clampKeyframeTime(2.5, 6), 2.5);
});

// ---------------------------------------------------------------------------
// Source clips
// ---------------------------------------------------------------------------

test("a source clip key is an mp4 on a video prefix, and nothing stranger", () => {
  assert.equal(isGrokSourceVideoKey(SOURCE), true);
  assert.equal(isGrokSourceVideoKey("grok-video-sources/0f3a.mp4"), true);
  assert.equal(isGrokSourceVideoKey("videos/generated/clip.MP4"), true);
  assert.equal(isGrokSourceVideoKey("grok/clip.webm"), false);
  assert.equal(isGrokSourceVideoKey("generations/clip.mp4"), false);
  assert.equal(isGrokSourceVideoKey("grok/../secrets.mp4"), false);
  assert.equal(isGrokSourceVideoKey("/grok/clip.mp4"), false);
  assert.equal(isGrokSourceVideoKey("grok//clip.mp4"), false);
  assert.equal(isGrokSourceVideoKey("grok/clip.mp4?x=1"), false);
  assert.equal(isGrokSourceVideoKey("grok/clip.mp4#t=1"), false);
  // Uploaded sources are served as video and never as an image.
  assert.equal(isAllowedVideoKey("grok-video-sources/0f3a.mp4"), true);
  assert.equal(isAllowedImageKey("grok-video-sources/0f3a.mp4"), false);
});

test("a stored source clip is shape-checked, and its resolution is capped at 720p", () => {
  assert.deepEqual(parseGrokSourceVideo({ key: SOURCE, seconds: 6, resolution: "480p" }), {
    key: SOURCE,
    seconds: 6,
    resolution: "480p",
  });
  assert.equal(parseGrokSourceVideo({ key: SOURCE, seconds: 6 })?.resolution, "720p");
  assert.equal(parseGrokSourceVideo({ key: "grok/clip.webm", seconds: 6 }), null);
  assert.equal(parseGrokSourceVideo({ key: SOURCE, seconds: 0 }), null);
  assert.equal(parseGrokSourceVideo(null), null);
  assert.equal(grokSourceResolution(854, 480), "480p");
  assert.equal(grokSourceResolution(1920, 1080), "720p");
  assert.equal(grokSourceResolution(720, 1280), "720p");
});

/** A minimal ISO-BMFF file: ftyp, then moov holding one mvhd. */
function mp4Bytes(
  version: 0 | 1,
  timescale: number,
  duration: number,
  moovFirst = true,
): Uint8Array {
  const box = (type: string, payload: number[]) => {
    const size = 8 + payload.length;
    return [
      size >>> 24,
      (size >>> 16) & 255,
      (size >>> 8) & 255,
      size & 255,
      ...[...type].map((c) => c.charCodeAt(0)),
      ...payload,
    ];
  };
  const u32 = (value: number) => [
    value >>> 24,
    (value >>> 16) & 255,
    (value >>> 8) & 255,
    value & 255,
  ];
  const u64 = (value: number) => [...u32(Math.floor(value / 2 ** 32)), ...u32(value >>> 0)];
  const times = version === 1 ? [...u64(0), ...u64(0)] : [...u32(0), ...u32(0)];
  const mvhd = box("mvhd", [
    version,
    0,
    0,
    0,
    ...times,
    ...u32(timescale),
    ...(version === 1 ? u64(duration) : u32(duration)),
    ...new Array(80).fill(0),
  ]);
  const moov = box("moov", mvhd);
  const ftyp = box("ftyp", [..."isom".split("").map((c) => c.charCodeAt(0)), 0, 0, 2, 0]);
  const mdat = box("mdat", new Array(32).fill(7));
  return new Uint8Array(moovFirst ? [...ftyp, ...moov, ...mdat] : [...ftyp, ...mdat, ...moov]);
}

test("an MP4's length comes from its movie header", () => {
  assert.equal(mp4DurationSeconds(mp4Bytes(0, 1000, 8700)), 8.7);
  assert.equal(mp4DurationSeconds(mp4Bytes(1, 90000, 90000 * 15)), 15);
  // The header may follow the media data, as an unoptimised file has it.
  assert.equal(mp4DurationSeconds(mp4Bytes(0, 600, 3600, false)), 6);
  // A fragmented stream writes 0 there: unknown, not a zero-length clip.
  assert.equal(mp4DurationSeconds(mp4Bytes(0, 1000, 0)), null);
  assert.equal(isMp4(mp4Bytes(0, 1, 1)), true);
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
  assert.equal(isMp4(png), false);
  assert.equal(mp4DurationSeconds(png), null);
  // Truncated before the header: no length rather than a wrong one.
  assert.equal(mp4DurationSeconds(mp4Bytes(0, 1000, 5000).slice(0, 30)), null);
});

test("an extended clip is the source plus the extension; an edit keeps the source's length", () => {
  assert.equal(grokVideoOutputSeconds({ duration: 6 }), 6);
  assert.equal(grokVideoOutputSeconds({ grokVideoMode: "edit", sourceVideoSeconds: 7.5 }), 7.5);
  assert.equal(
    grokVideoOutputSeconds({ grokVideoMode: "extend", duration: 4, sourceVideoSeconds: 10 }),
    14,
  );
});

// ---------------------------------------------------------------------------
// Metered quota
// ---------------------------------------------------------------------------

test("image quota follows xAI's rate card, and 2.0 Auto bills low or medium as served", () => {
  assert.equal(
    grokImageMeteredUsd({ quality: "quality", sizeTier: "2k", referenceCount: 0 }),
    0.07,
  );
  assert.equal(
    grokImageMeteredUsd({ quality: "standard", sizeTier: "1k", count: 4, referenceCount: 0 }),
    0.08,
  );
  assert.equal(grokImageMeteredUsd({ quality: "v2-low", sizeTier: "1k", referenceCount: 0 }), 0.04);
  assert.equal(
    grokImageMeteredUsd({ quality: "v2-auto", sizeTier: "2k", referenceCount: 0 }),
    0.06,
  );
  // An edit: medium at 2k, plus each source at $0.01, for each of two requests.
  assert.equal(
    grokImageMeteredUsd({ quality: "v2-auto", sizeTier: "2k", count: 2, referenceCount: 3 }),
    0.22,
  );
});

test("video quota: 1.5 at $0.08–0.25/s, Lite at $0.02–0.14/s, edits on the base model", () => {
  assert.equal(grokVideoMeteredUsd({ referenceCount: 0, duration: 6, resolution: "480p" }), 0.48);
  assert.equal(grokVideoMeteredUsd({ referenceCount: 0, duration: 10, resolution: "1080p" }), 2.5);
  assert.equal(
    grokVideoMeteredUsd({
      model: GROK_VIDEO_MODEL_LITE,
      referenceCount: 0,
      duration: 6,
      resolution: "480p",
    }),
    0.12,
  );
  assert.equal(
    grokVideoMeteredUsd({
      model: GROK_VIDEO_MODEL_LITE,
      referenceCount: 1,
      duration: 10,
      resolution: "1080p",
    }),
    1.41,
  );
  // Two references at $0.01 each.
  assert.equal(grokVideoMeteredUsd({ referenceCount: 2, duration: 6, resolution: "720p" }), 0.86);
  // Edit: 8 s at 720p on the base model, plus 8 s of input video.
  assert.equal(
    grokVideoMeteredUsd({
      mode: "edit",
      referenceCount: 0,
      source: { seconds: 8, resolution: "720p" },
    }),
    0.64,
  );
  // Extend: 6 s added at 480p, plus the 10 s source as input.
  assert.equal(
    grokVideoMeteredUsd({
      mode: "extend",
      referenceCount: 0,
      extendDuration: 6,
      source: { seconds: 10, resolution: "480p" },
    }),
    0.4,
  );
});

test("a stored row prices the way the form did", () => {
  assert.equal(
    grokMeteredUsdForRow({
      mediaType: "video",
      duration: 6,
      resolution: "480p",
      referenceCount: 0,
    }),
    0.48,
  );
  assert.equal(
    grokMeteredUsdForRow({
      mediaType: "video",
      grokVideoMode: "extend",
      duration: 6,
      resolution: "480p",
      sourceVideoSeconds: 10,
      referenceCount: 0,
    }),
    0.4,
  );
  assert.equal(
    grokMeteredUsdForRow({
      mediaType: "image",
      quality: "v2-medium",
      resolution: "2k",
      count: 1,
      referenceCount: 0,
    }),
    0.08,
  );
  assert.equal(usdFromTicks(4_800_000_000), 0.48);
  assert.equal(usdFromTicks("12"), undefined);
});

test("the Grok button shows the quota it meters, still included in the subscription", () => {
  const video = priceForVariant(
    grok,
    variantFor(form({ mediaType: "video", duration: 6, resolution: "480p", videoCount: 2 }), {}, 0),
    0,
    new Map(),
  );
  assert.deepEqual(video, { currency: "included", meteredUsd: 0.96 });
  assert.equal(formatPrice(video), "≈$0.96 quota");
  assert.equal(formatMetered(video), "≈$0.96");
  const lite = priceForVariant(
    grok,
    variantFor(
      form({
        mediaType: "video",
        grokVideoModel: GROK_VIDEO_MODEL_LITE,
        duration: 6,
        resolution: "480p",
      }),
      {},
      0,
    ),
    0,
    new Map(),
  );
  assert.equal(lite?.currency === "included" ? lite.meteredUsd : null, 0.12);
  const image = priceForVariant(
    grok,
    variantFor(
      form({ mediaType: "image", quality: "v2-medium", imageSizeTier: "2k", count: 2 }),
      {},
      0,
    ),
    0,
    new Map(),
  );
  assert.equal(image?.currency === "included" ? image.meteredUsd : null, 0.16);
  // The bare included price still reads as it always did.
  assert.equal(formatPrice({ currency: "included" }), "Included in SuperGrok");
  assert.equal(formatMetered({ currency: "included" }), null);
  assert.equal(
    formatPrice({ currency: "included", meteredUsd: 0.5, measured: true }),
    "$0.50 quota",
  );
});

// ---------------------------------------------------------------------------
// The form
// ---------------------------------------------------------------------------

test("a form saved before Grok's new fields hydrates onto Generate on 1.5", () => {
  const saved = JSON.stringify({
    model: "grok",
    mediaType: "video",
    duration: 10,
    resolution: "720p",
  });
  const restored = hydrateForm(saved);
  assert.equal(restored.grokVideoMode, "generate");
  assert.equal(restored.grokVideoModel, GROK_VIDEO_MODEL_V15);
  assert.deepEqual(restored.grokFrameRoles, []);
  assert.equal(restored.grokExtendDuration, 6);
  assert.equal(restored.grokSourceVideo, null);
  assert.equal(restored.duration, 10);
});

test("junk in the new fields is put right", () => {
  const { form: next } = normalizeForm(
    form({
      grokVideoMode: "remix" as ApiFormState["grokVideoMode"],
      grokVideoModel: "grok-imagine-video-9" as ApiFormState["grokVideoModel"],
      grokExtendDuration: 14,
      grokSourceVideo: { key: "../x.mp4", seconds: 3, resolution: "720p" },
      grokFrameRoles: [{ role: "nope" } as unknown as GrokFrameRole],
    }),
  );
  assert.equal(next.grokVideoMode, "generate");
  assert.equal(next.grokVideoModel, GROK_VIDEO_MODEL_V15);
  assert.equal(next.grokExtendDuration, 10);
  assert.equal(next.grokSourceVideo, null);
  assert.deepEqual(next.grokFrameRoles, [null]);
});

test("the frame crop ratio is its own field, defaulting to the picture as it is", () => {
  assert.equal(DEFAULT_API_FORM.grokFrameAspectRatio, "auto");
  assert.equal(hydrateForm(JSON.stringify({ model: "grok" })).grokFrameAspectRatio, "auto");
  const junk = normalizeForm(form({ grokFrameAspectRatio: "7:3" })).form;
  assert.equal(junk.grokFrameAspectRatio, "auto");
  const kept = normalizeForm(form({ mediaType: "video", grokFrameAspectRatio: "21:9" }), 1).form;
  assert.equal(kept.grokFrameAspectRatio, "21:9");

  // The text-to-video ratio does not crop an attached photo.
  const video = form({ mediaType: "video", aspectRatio: "9:16" });
  assert.deepEqual(grokFrameCropsFor(video, 1), [null]);
  assert.deepEqual(grokFrameCropsFor({ ...video, grokFrameAspectRatio: "4:3" }, 1), ["4:3"]);
});

test("leaving 2.0 pulls a 2.0-only ratio onto the nearest the legacy models take", () => {
  const { form: next, adjustments } = normalizeForm(
    form({ mediaType: "image", quality: "standard", aspectRatio: "21:9" }),
  );
  assert.equal(next.aspectRatio, "20:9");
  assert.ok(adjustments.some((line) => line.includes("21:9 → 20:9")));
  assert.equal(
    normalizeForm(form({ mediaType: "image", quality: "v2-low", aspectRatio: "5:2" })).form
      .aspectRatio,
    "5:2",
  );
  // 2.0 Auto survives a round trip.
  assert.equal(normalizeForm(form({ quality: "v2-auto" })).form.quality, "v2-auto");
});

test("a shorter clip pulls its keyframes inside", () => {
  const { form: next, adjustments } = normalizeForm(
    form({
      mediaType: "video",
      duration: 4,
      grokFrameRoles: [{ role: "first" }, { role: "keyframe", at: 7 }],
    }),
    2,
  );
  assert.deepEqual(next.grokFrameRoles[1], { role: "keyframe", at: 3.67 });
  assert.ok(adjustments.some((line) => line.startsWith("Keyframes moved")));
});

test("pinning a frame drops 1080p on 1.5, and Lite keeps it", () => {
  const pinned = normalizeForm(
    form({
      mediaType: "video",
      resolution: "1080p",
      grokFrameRoles: [{ role: "first" }, { role: "last" }],
    }),
    2,
  );
  assert.equal(pinned.form.resolution, "720p");
  const lite = normalizeForm(
    form({ mediaType: "video", resolution: "1080p", grokVideoModel: GROK_VIDEO_MODEL_LITE }),
    1,
  );
  assert.equal(lite.form.resolution, "1080p");
  // Edit has no resolution of its own; the Generate choice is kept for later.
  const edit = normalizeForm(
    form({ mediaType: "video", resolution: "1080p", grokVideoMode: "edit" }),
    3,
  );
  assert.equal(edit.form.resolution, "1080p");
});

test("the options helper reads the form", () => {
  const options = grokVideoOptionsFor(
    form({
      mediaType: "video",
      grokVideoMode: "extend",
      grokSourceVideo: { key: SOURCE, seconds: 20, resolution: "720p" },
    }),
    0,
  );
  assert.match(options.issues[0], /2–15 s — this one is 20 s/);
});

test("mapped prompt tags fall back to their own number where no ordinal exists", () => {
  assert.equal(toGrokApiPromptMapped("@image1 and @image2", [2, null]), "image 2 and image 2");
  assert.equal(toGrokApiPromptMapped("no tags", []), "no tags");
});

test("an MP4's picture size comes from its first visual track header", () => {
  const box = (type: string, payload: number[]) => {
    const size = 8 + payload.length;
    return [
      size >>> 24,
      (size >>> 16) & 255,
      (size >>> 8) & 255,
      size & 255,
      ...[...type].map((c) => c.charCodeAt(0)),
      ...payload,
    ];
  };
  const fixed = (value: number) => {
    const raw = value * 65536;
    return [raw >>> 24, (raw >>> 16) & 255, (raw >>> 8) & 255, raw & 255];
  };
  // 76 bytes up to the matrix's end, then width and height in 16.16.
  const tkhd = (width: number, height: number) =>
    box("tkhd", [...new Array(76).fill(0), ...fixed(width), ...fixed(height)]);
  const ftyp = box("ftyp", [..."isom".split("").map((c) => c.charCodeAt(0)), 0, 0, 2, 0]);
  const moov = box("moov", [...box("trak", tkhd(0, 0)), ...box("trak", tkhd(1280, 720))]);
  assert.deepEqual(mp4VideoDimensions(new Uint8Array([...ftyp, ...moov])), {
    width: 1280,
    height: 720,
  });
  assert.equal(mp4VideoDimensions(new Uint8Array([...ftyp])), null);
});
