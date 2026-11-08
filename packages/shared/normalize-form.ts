/**
 * Form state for the API tab, and the rules that keep it legal when the user
 * switches models.
 *
 * Switching from Grok to Seedream (or Standard to Mini) can leave settings
 * behind that the new target does not accept — 3:2 has no Seedance equivalent,
 * 4K exists only on Seedance Standard, and Grok loses 1080p as soon as a second
 * reference image makes the job reference-to-video. Rather than resetting the
 * form and throwing away a long prompt and a stack of references, we clamp each
 * offending field to the nearest legal value and report what moved so the UI can
 * say so once.
 *
 * The reference count is one of the inputs for that reason: adding a second
 * reference to a 1080p Grok clip has to pull it down to 720p, exactly as
 * switching model does.
 */

import {
  VIDEO_COUNTS,
  getApiModel,
  higgsfieldVideoModel,
  imageAspectRatios,
  isGrokImageQuality,
  isGrokVideoMode,
  isGrokVideoModelId,
  nearestRatio,
  ratioValue,
  videoDurations,
  videoResolutions,
  type ApiModelId,
  type GrokImageQuality,
  type GrokVideoMode,
  type GrokVideoModelId,
  type MediaType,
  type Provider,
  type VideoTier,
} from "./api-models";
import {
  clampKeyframeTime,
  grokFrameAspectRatios,
  grokFrameCrops,
  grokVideoContext,
  grokVideoOptions,
  parseGrokSourceVideo,
  sanitizeGrokFrameRoles,
  type GrokFrameRole,
  type GrokSourceVideo,
  type GrokVideoInput,
  type GrokVideoOptions,
} from "./grok-imagine";
import {
  ATLAS_FANOUT_COUNTS,
  atlasBatchSplit,
  atlasBatchValue,
  isAtlasImageCount,
  atlasSuccessor,
  resolveAtlasVariant,
  atlasDefaults,
  defaultAtlasModel,
  isAtlasModelId,
  normalizeAtlasParams,
  getAtlasModel,
  type AtlasModel,
  type AtlasParamValue,
} from "./atlas-models";

/**
 * Providers the composer can drive.
 *
 * Atlas is deliberately not folded into `Provider` in api-models.ts. That union
 * feeds exhaustive switches over capability descriptors that Atlas models do
 * not have — they carry a generated parameter list instead — so widening it
 * there would turn a set of compile-time guarantees into a set of unreachable
 * branches.
 */
export type ComposerProvider = Provider | "atlas";

export type ApiFormState = {
  /**
   * Which provider the form is driving.
   *
   * Previously derived from `API_MODELS[model].provider`. It is explicit now
   * because Atlas's models are vendor slugs rather than registry ids, so there
   * is no `ApiModelId` to derive it from.
   */
  provider: ComposerProvider;
  model: ApiModelId;
  /**
   * Atlas model slug, e.g. "atlascloud/wan-2.2/image-to-video".
   *
   * One per media type, because Atlas has no model that does both: choosing
   * "video" genuinely changes which model runs, which is the thing the old
   * single-model-with-a-toggle layout could not say out loud.
   */
  atlasImageModel: string;
  atlasVideoModel: string;
  /**
   * Collected against each Atlas model's own parameter names — one bag per
   * media type, matching the two model slots above.
   *
   * A single shared bag looked tidier and quietly destroyed settings: it was
   * re-normalised against whichever model the *current* media type pointed at,
   * so an Image → Video → Image round trip came back with the image model's
   * count and size reset to defaults.
   */
  atlasImageParams: Record<string, AtlasParamValue>;
  atlasVideoParams: Record<string, AtlasParamValue>;
  mediaType: MediaType;
  prompt: string;
  aspectRatio: string;
  count: number;
  /**
   * How many clips one click produces. Separate from `count` so switching media
   * type doesn't carry a batch of six images over to six paid videos.
   */
  videoCount: number;
  /** Grok's model/quality switch. Ignored by Seedream but preserved across visits. */
  quality: GrokImageQuality;
  /** Size tier for images: "1k"/"2k" on Grok, "2K"/"3K"/"4K" on Seedream. */
  imageSizeTier: string;
  /** Seconds. Never "auto" — the price has to be known before the click. */
  duration: number;
  /** Video resolution: 480p / 720p / 1080p / 4k. */
  resolution: string;
  videoTier: VideoTier;
  /** Higgsfield exposes several video models; fal and Grok ignore this. */
  videoJobType: string;
  /** Seedance `mode` (std/fast) or Kling `mode` (std/pro/4k). */
  videoMode: string;
  generateAudio: boolean;
  bitrateMode: "standard" | "high";
  /**
   * Preset voices for Grok video, at most `maxVoices` of the caps roster.
   * Choosing any turns the job reference-to-video, which costs it 1080p — the
   * resolution clamp below reads this for exactly that reason.
   */
  videoVoices: string[];
  /**
   * Grok video: Generate (1.5 or Lite), or Edit / Extend an existing clip on
   * the base model. Every field below is Grok-only and kept across providers.
   */
  grokVideoMode: GrokVideoMode;
  /** Generate's model choice. */
  grokVideoModel: GrokVideoModelId;
  /**
   * What each selected image does on 1.5 — reference, first/last frame, loop,
   * keyframe — by position among the selected images, the order @imageN tags
   * count. Null is automatic: a lone image is the first frame, two or more are
   * references, which is what the app did before roles existed. The panel
   * remaps this by attachment id when the selection changes
   * (`remapGrokFrameRoles`), so a role follows its image.
   */
  grokFrameRoles: (GrokFrameRole | null)[];
  /**
   * The shape of a clip with a pinned first frame. xAI takes that from the
   * picture, so a ratio here crops the pinned frames before upload
   * (`grokFrameCrops`); "auto" sends them as they are. Kept apart from
   * `aspectRatio`, which is text- and reference-to-video's, so attaching a
   * photo does not crop it to whatever ratio the last prompt-only clip used.
   */
  grokFrameAspectRatio: string;
  /** Extend: seconds added to the source (2–10). */
  grokExtendDuration: number;
  /** Edit / Extend: the clip to work on. */
  grokSourceVideo: GrokSourceVideo | null;
  /**
   * Shape of the stored form. 2 since `count` drives an Atlas model's own batch
   * parameter; a stored form without it predates that, and parseStoredForm
   * carries its batch size into the count before anything is normalised.
   */
  formVersion: number;
};

export const API_FORM_VERSION = 2;

export const API_FORM_STORAGE_KEY = "artsnack_api_form";
/** Pre-model-switcher key. Read once so existing users keep their settings. */
export const LEGACY_GROK_FORM_STORAGE_KEY = "artsnack_grok_form";

export const DEFAULT_API_FORM: ApiFormState = {
  // Higgsfield is the default provider; the others stay one click away.
  provider: "higgsfield",
  model: "hf-seedream-4.5",
  atlasImageModel: defaultAtlasModel("image").id,
  atlasVideoModel: defaultAtlasModel("video").id,
  // Pre-filled rather than left empty, for the same reason the ratio and tier
  // above are: a default that normalizeForm has to correct leaves a fresh form
  // with controls in a state the user never chose, and announces the correction
  // as a toast on the first keystroke. `mediaType` opens on "image", so these
  // are the image model's.
  atlasImageParams: atlasDefaults(defaultAtlasModel("image")),
  atlasVideoParams: atlasDefaults(defaultAtlasModel("video")),
  mediaType: "image",
  prompt: "",
  // Legal for the model this opens on: Higgsfield's image enum has no "auto",
  // and its tiers are basic/high. A default that needs clamping would leave a
  // fresh form with nothing selected and fire a toast on the first keystroke.
  aspectRatio: "16:9",
  count: 1,
  videoCount: 1,
  quality: "quality",
  imageSizeTier: "basic",
  duration: 10,
  resolution: "720p",
  videoTier: "mini",
  videoJobType: "seedance_2_0",
  videoMode: "std",
  generateAudio: true,
  bitrateMode: "standard",
  videoVoices: [],
  grokVideoMode: "generate",
  grokVideoModel: "grok-imagine-video-1.5",
  grokFrameRoles: [],
  grokFrameAspectRatio: "auto",
  grokExtendDuration: 6,
  grokSourceVideo: null,
  formVersion: API_FORM_VERSION,
};

/** Canonical ordering used to pick a replacement when a resolution is unavailable. */
const RESOLUTION_ORDER = ["480p", "720p", "1080p", "4k"];

function nearestNumber(target: number, allowed: readonly number[]): number {
  return allowed.reduce((best, candidate) =>
    Math.abs(candidate - target) < Math.abs(best - target) ? candidate : best,
  );
}

function nearestResolution(target: string, allowed: readonly string[]): string {
  if (allowed.includes(target)) return target;
  const targetIndex = RESOLUTION_ORDER.indexOf(target);
  if (targetIndex === -1) return allowed[0];
  let best = allowed[0];
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const candidate of allowed) {
    const distance = Math.abs(RESOLUTION_ORDER.indexOf(candidate) - targetIndex);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = candidate;
    }
  }
  return best;
}

function replacementRatio(previous: string, allowed: readonly string[]): string {
  const value = ratioValue(previous);
  if (value !== null) return nearestRatio(value, allowed);
  // "auto" isn't offered here — landscape is the sane default.
  return allowed.includes("16:9") ? "16:9" : allowed[0];
}

/** Matches "2k" against "2K" — the two providers spell their tiers differently. */
function matchSizeTier(current: string, allowed: readonly { value: string }[]): string | null {
  const exact = allowed.find((tier) => tier.value === current);
  if (exact) return exact.value;
  const insensitive = allowed.find((tier) => tier.value.toLowerCase() === current.toLowerCase());
  return insensitive?.value ?? null;
}

export type NormalizeResult = {
  form: ApiFormState;
  /** One human-readable line per field that had to move. */
  adjustments: string[];
};

/** The Atlas model driving the form right now — one per media type. */
export function activeAtlasModelId(form: ApiFormState): string {
  return form.mediaType === "video" ? form.atlasVideoModel : form.atlasImageModel;
}

export function withActiveAtlasModel(form: ApiFormState, id: string): ApiFormState {
  return form.mediaType === "video"
    ? { ...form, atlasVideoModel: id }
    : { ...form, atlasImageModel: id };
}

/**
 * Points the form at a registry model, provider included.
 *
 * `provider` and `model` must agree or the form lies about what will run, and
 * the entry points that restore a model — the gallery's Reproduce, the ?model=
 * URL parameter — know only the model. Reconciling inside normalizeForm was
 * tried and is wrong: it cannot tell "the user just chose this" from "this is
 * the dormant legacy model while Atlas is active", so it dragged the provider
 * back to fal every time an Atlas form was normalised.
 */
export function withRegistryModel(form: ApiFormState, id: ApiModelId): ApiFormState {
  return { ...form, model: id, provider: getApiModel(id).provider };
}

/** Images one tap asks an Atlas image model for. */
function atlasImagesFor(form: ApiFormState): number {
  // `count` is shared with the other providers. normalizeForm keeps it on the
  // fan-out list while Atlas is active; this clamp is for a form that skipped
  // it, which would otherwise light up no button and charge for what it sent.
  const highest = ATLAS_FANOUT_COUNTS[ATLAS_FANOUT_COUNTS.length - 1];
  return Math.min(highest, Math.max(1, Math.round(form.count)));
}

/**
 * How many separate submissions one tap makes on Atlas.
 *
 * Video is always our own fan-out: no video model here takes a batch
 * parameter, so four clips are four requests and four charges. Images split —
 * 27 of the 109 take `num_images` or `n` and return a batch from one request.
 * Those used to be held to their own ceiling (4 on Qwen Image 3.0); now the
 * count is the total, normalizeForm writes the per-request size into the
 * parameter, and this returns how many such requests make it up.
 */
export function atlasJobsFor(model: AtlasModel, form: ApiFormState): number {
  if (model.media === "video") return form.videoCount;
  const images = atlasImagesFor(form);
  return atlasBatchSplit(model, images)?.requests ?? images;
}

/**
 * Selects an Atlas model outright — provider, media type and slot together.
 *
 * The phone's engine sheet lists image and video models side by side, so a tap
 * has to be able to move the media type as well; leaving it behind would select
 * a video model and then compose an image with it. The web picker is already
 * scoped to one media type and never needs this.
 */
export function withAtlasModel(form: ApiFormState, model: AtlasModel): ApiFormState {
  const next: ApiFormState = { ...form, provider: "atlas", mediaType: model.media };
  return model.media === "video"
    ? { ...next, atlasVideoModel: model.id }
    : { ...next, atlasImageModel: model.id };
}

/**
 * A stored Atlas row as a form: model, media type and its parameter bag.
 *
 * withAtlasModel goes first — it sets the media type, which decides which bag
 * the parameters belong to. On a model that batches, the row's own batch size
 * becomes the image count: normalizeForm derives the parameter from the count,
 * so leaving the count behind would rewrite a reproduced "4 per request" to
 * whatever the form happened to hold. A row is one request, so its batch is
 * the whole of what it made.
 */
export function withAtlasRow(
  form: ApiFormState,
  model: AtlasModel,
  params: Record<string, AtlasParamValue>,
): ApiFormState {
  const next = withActiveAtlasParams(withAtlasModel(form, model), params);
  const batch = model.media === "image" ? atlasBatchSplit(model, 1)?.param : undefined;
  const stored = batch ? Number(params[batch.name]) : NaN;
  return Number.isInteger(stored) && stored >= 1 ? { ...next, count: stored } : next;
}

/** The parameter bag for the media type on screen. */
export function activeAtlasParams(form: ApiFormState): Record<string, AtlasParamValue> {
  return form.mediaType === "video" ? form.atlasVideoParams : form.atlasImageParams;
}

export function withActiveAtlasParams(
  form: ApiFormState,
  params: Record<string, AtlasParamValue>,
): ApiFormState {
  return form.mediaType === "video"
    ? { ...form, atlasVideoParams: params }
    : { ...form, atlasImageParams: params };
}

/**
 * Keeps the Atlas half of the form legal.
 *
 * Split out because it shares nothing with the clamping below: there is no
 * aspect-ratio field to reconcile, no size tier and no video tier — just the
 * parameter bag the selected model declares, checked against that model's own
 * schema. Both halves are always run, so switching provider back and forth
 * never loses either side's settings.
 */
function normalizeAtlasHalf(
  form: ApiFormState,
  adjustments: string[],
  referenceCount: number,
): void {
  for (const media of ["image", "video"] as const) {
    const modelKey = media === "video" ? "atlasVideoModel" : "atlasImageModel";
    const paramsKey = media === "video" ? "atlasVideoParams" : "atlasImageParams";
    if (!isAtlasModelId(form[modelKey])) form[modelKey] = defaultAtlasModel(media).id;
    // A renamed endpoint carries on under its new id; its parameters are the
    // same, so the bag below is kept and only re-checked.
    const successor = atlasSuccessor(getAtlasModel(form[modelKey]));
    if (successor) {
      if (form.provider === "atlas" && form.mediaType === media) {
        adjustments.push(`${getAtlasModel(form[modelKey]).label} → ${successor.label}`);
      }
      form[modelKey] = successor.id;
    }

    // Atlas splits one model across an endpoint per input shape. Which one runs
    // is a consequence of what was attached and whether the prompt tags
    // anything, not a separate decision the user should have to make — fal has
    // always routed this automatically and Atlas only looks different because
    // its variants happen to have their own URLs.
    if (form.provider === "atlas" && form.mediaType === media) {
      const chosen = getAtlasModel(form[modelKey]);
      const resolved = resolveAtlasVariant(chosen, referenceCount, form.prompt, form[paramsKey]);
      if (resolved.id !== chosen.id) {
        form[modelKey] = resolved.id;
        adjustments.push(`${chosen.label} → ${resolved.label}`);
      }
    }

    // Both bags every time, so the inactive one keeps its settings rather than
    // being rewritten against a model it does not belong to.
    const result = normalizeAtlasParams(getAtlasModel(form[modelKey]), form[paramsKey]);
    form[paramsKey] = result.params;
    // Only announced for the bag on screen — the other would report a clamp
    // against a control the user cannot see.
    if (form.provider === "atlas" && form.mediaType === media) {
      adjustments.push(...result.adjustments);
    }
  }
}

export function normalizeForm(
  input: ApiFormState,
  /** Selected references. One of them hides the ratio control for video. */
  referenceCount = 0,
): NormalizeResult {
  const model = getApiModel(input.model);
  const form = { ...input };
  const adjustments: string[] = [];

  normalizeAtlasHalf(form, adjustments, referenceCount);

  // The legacy providers' fields are clamped below regardless of which provider
  // is active, so a round trip through Atlas and back leaves them untouched.
  // Every field is kept legal, but only the ones the user can currently see are
  // worth mentioning — announcing "Images 6 → 4" while they compose a video is
  // noise about a control that isn't on screen.
  const onImages = form.mediaType === "image";
  const report = (visible: boolean, line: string) => {
    if (visible) adjustments.push(line);
  };

  const imageCaps = model.image;
  const videoCaps = model.video;

  // --- Grok image quality: the value names a model, so junk cannot pass ---
  // First, because Grok's ratios depend on it: 2.0 takes 21:9 and 5:2.
  if (!isGrokImageQuality(form.quality)) {
    form.quality = DEFAULT_API_FORM.quality;
  }

  // --- Grok video: mode, model, roles, extension, source ---
  // Before the ratio and resolution clamps, which both read the plan.
  normalizeGrokVideo(form, adjustments, !onImages && form.provider === "grok");

  // --- Aspect ratio: validated against whichever media type is active ---
  const allowedRatios =
    form.mediaType === "image"
      ? imageAspectRatios(imageCaps, form.quality)
      : videoCaps.kind === "higgsfield-video"
        ? higgsfieldVideoModel(videoCaps, form.videoJobType).aspectRatios
        : videoCaps.aspectRatios;
  if (!allowedRatios.includes(form.aspectRatio)) {
    const previous = form.aspectRatio;
    form.aspectRatio = replacementRatio(previous, allowedRatios);
    // Hidden while a single reference — or, on Grok, a pinned first frame or
    // a source clip — defines the shape.
    const ratioVisible =
      videoCaps.kind === "grok"
        ? grokVideoOptionsFor(form, referenceCount).aspectRatios !== null
        : referenceCount !== 1;
    report(onImages || ratioVisible, `Aspect ratio ${previous} → ${form.aspectRatio}`);
  }

  // --- Image count ---
  // On Atlas the count drives Atlas's own fan-out, not the dormant model's `n`.
  // Clamping it to that model's list turned an Atlas 3 into a 2 whenever Grok
  // was the model left behind, and would cap the fan-out at Higgsfield's 4.
  // Any whole count up to 10 stands there, so a restored batch of 5 stays 5.
  if (form.provider === "atlas") {
    if (!isAtlasImageCount(form.count)) {
      const previous = form.count;
      form.count = nearestNumber(Number(previous) || 1, ATLAS_FANOUT_COUNTS);
      report(onImages, `Images ${previous} → ${form.count}`);
    }
  } else if (!imageCaps.counts.includes(form.count)) {
    const previous = form.count;
    form.count = nearestNumber(previous, imageCaps.counts);
    report(onImages, `Images ${previous} → ${form.count}`);
  }

  // --- Atlas batch parameter: derived from the count, never set on its own ---
  // The form shows one "Number of images"; on a model that batches, its total
  // is sent as equal requests, so the parameter carries the per-request size
  // and atlasJobsFor the number of requests. Only while that model is on
  // screen — the dormant bag keeps whatever it had.
  if (form.provider === "atlas" && onImages) {
    const split = atlasBatchSplit(getAtlasModel(form.atlasImageModel), atlasImagesFor(form));
    if (split) {
      const value = atlasBatchValue(split.param, split.perRequest);
      if (form.atlasImageParams[split.param.name] !== value) {
        form.atlasImageParams = { ...form.atlasImageParams, [split.param.name]: value };
      }
    }
  }

  // --- Video count: our own fan-out, so the list is the same everywhere ---
  if (!VIDEO_COUNTS.includes(form.videoCount as (typeof VIDEO_COUNTS)[number])) {
    const previous = form.videoCount;
    form.videoCount = nearestNumber(previous, VIDEO_COUNTS);
    report(!onImages, `Videos ${previous} → ${form.videoCount}`);
  }

  // --- Image size tier ---
  const matchedTier = matchSizeTier(form.imageSizeTier, imageCaps.sizeTiers);
  if (matchedTier === null) {
    const previous = form.imageSizeTier;
    form.imageSizeTier = imageCaps.defaultSizeTier;
    report(onImages, `Image size ${previous} → ${form.imageSizeTier}`);
  } else {
    form.imageSizeTier = matchedTier;
  }

  // --- Video tier (Seedance-on-fal only; others keep the stored value, unused) ---
  if (videoCaps.kind === "seedance" && !videoCaps.tiers.includes(form.videoTier)) {
    form.videoTier = videoCaps.defaultTier;
  }

  // --- Higgsfield video model, and the mode that belongs to it ---
  if (videoCaps.kind === "higgsfield-video") {
    if (!videoCaps.models.some((model) => model.jobType === form.videoJobType)) {
      form.videoJobType = videoCaps.defaultJobType;
    }
    const video = higgsfieldVideoModel(videoCaps, form.videoJobType);
    const allowedModes = video.modeParam?.values;
    if (!allowedModes) {
      form.videoMode = "std";
    } else if (!allowedModes.includes(form.videoMode)) {
      const previous = form.videoMode;
      form.videoMode = video.modeParam!.default;
      // A visible selector rewriting itself deserves the same announcement as
      // any other clamp.
      report(!onImages, `${video.modeParam!.name} ${previous} → ${form.videoMode}`);
    }
  }

  // --- Video duration: the models differ, Wan goes to 2s and Seedance to 4s ---
  const allowedDurations = videoDurations(videoCaps, form.videoJobType);
  if (!allowedDurations.includes(form.duration)) {
    const previous = form.duration;
    form.duration = nearestNumber(previous, allowedDurations);
    report(!onImages, `Duration ${previous}s → ${form.duration}s`);
  }

  // --- Grok video voices: roster membership and the three-voice ceiling ---
  if (!Array.isArray(form.videoVoices)) {
    // Persisted forms predating the field, or corrupt storage.
    form.videoVoices = [];
  }
  if (videoCaps.kind === "grok" && form.videoVoices.length > 0) {
    const known = form.videoVoices.filter((voice) => videoCaps.voices.includes(voice));
    const kept = known.slice(0, videoCaps.maxVoices);
    if (kept.length !== form.videoVoices.length) {
      report(!onImages, `Voices trimmed to ${kept.join(", ") || "none"}`);
      form.videoVoices = kept;
    }
  }

  // --- Video resolution: tier for fal, model and mode for Higgsfield ---
  const allowedResolutions = videoResolutions(
    videoCaps,
    form.videoTier,
    form.videoJobType,
    form.videoMode,
    referenceCount,
    videoCaps.kind === "grok" ? form.videoVoices.length : 0,
    videoCaps.kind === "grok"
      ? grokVideoContext(grokVideoInputFor(form, referenceCount))
      : undefined,
  );
  if (allowedResolutions.length > 0 && !allowedResolutions.includes(form.resolution)) {
    const previous = form.resolution;
    form.resolution = nearestResolution(previous, allowedResolutions);
    report(!onImages, `Video resolution ${previous} → ${form.resolution}`);
  }

  // --- Bitrate mode: Mini's schema has no such field ---
  if (
    videoCaps.kind === "seedance" &&
    !videoCaps.bitrateModeByTier[form.videoTier] &&
    form.bitrateMode !== "standard"
  ) {
    form.bitrateMode = "standard";
  }

  return { form, adjustments };
}

/**
 * The Grok-only fields, kept legal whatever provider is active — the same
 * "both halves always" rule as the Atlas bag, so a trip through another
 * provider and back finds them as they were.
 */
function normalizeGrokVideo(form: ApiFormState, adjustments: string[], visible: boolean): void {
  if (!isGrokVideoMode(form.grokVideoMode)) form.grokVideoMode = DEFAULT_API_FORM.grokVideoMode;
  if (!isGrokVideoModelId(form.grokVideoModel)) {
    form.grokVideoModel = DEFAULT_API_FORM.grokVideoModel;
  }
  form.grokSourceVideo = parseGrokSourceVideo(form.grokSourceVideo);
  if (!grokFrameAspectRatios().includes(form.grokFrameAspectRatio)) {
    form.grokFrameAspectRatio = DEFAULT_API_FORM.grokFrameAspectRatio;
  }

  const caps = getApiModel("grok").video;
  if (caps.kind !== "grok") return;
  if (!caps.extendDurations.includes(form.grokExtendDuration)) {
    const previous = form.grokExtendDuration;
    form.grokExtendDuration =
      typeof previous === "number" && Number.isFinite(previous)
        ? nearestNumber(previous, caps.extendDurations)
        : caps.defaultExtendDuration;
    if (visible && form.grokVideoMode === "extend" && typeof previous === "number") {
      adjustments.push(`Extension ${previous}s → ${form.grokExtendDuration}s`);
    }
  }

  // Keyframes live strictly inside the clip. A shorter clip pulls them in
  // rather than leaving a pin the request would be refused for.
  // The duration itself is clamped further down, against the active model;
  // what matters here is the length a Grok clip would have.
  const clipSeconds =
    typeof form.duration === "number" && Number.isFinite(form.duration)
      ? nearestNumber(form.duration, caps.durations)
      : caps.defaultDuration;
  let moved = false;
  form.grokFrameRoles = sanitizeGrokFrameRoles(form.grokFrameRoles).map((entry) => {
    if (entry?.role !== "keyframe" || entry.at === undefined) return entry;
    const at = clampKeyframeTime(entry.at, clipSeconds);
    if (at === entry.at) return entry;
    moved = true;
    return { role: "keyframe", at };
  });
  if (moved && visible && form.grokVideoMode === "generate") {
    adjustments.push(`Keyframes moved inside the ${clipSeconds}s clip`);
  }
}

/** The form's Grok video request, as grok-imagine.ts reads one. */
export function grokVideoInputFor(form: ApiFormState, referenceCount: number): GrokVideoInput {
  return {
    mode: form.grokVideoMode,
    model: form.grokVideoModel,
    referenceCount,
    frameRoles: form.grokFrameRoles,
    // Read before normalizeForm has repaired a corrupt stored value.
    voiceCount: Array.isArray(form.videoVoices) ? form.videoVoices.length : 0,
    duration: form.duration,
    extendDuration: form.grokExtendDuration,
    source: form.grokSourceVideo,
    prompt: form.prompt,
  };
}

/** What the Grok video form shows — `grokVideoOptions` for this form. */
export function grokVideoOptionsFor(form: ApiFormState, referenceCount: number): GrokVideoOptions {
  return grokVideoOptions(grokVideoInputFor(form, referenceCount));
}

/** The ratio each selected image is cropped to on upload — `grokFrameCrops` for this form. */
export function grokFrameCropsFor(form: ApiFormState, referenceCount: number): (string | null)[] {
  return grokFrameCrops(grokVideoInputFor(form, referenceCount), form.grokFrameAspectRatio);
}

/** The shape persisted before the model switcher: Grok-only, and the image size
 *  tier lived under a different name. */
type LegacyGrokForm = Partial<Omit<ApiFormState, "imageSizeTier">> & {
  imageResolution?: string;
};

/**
 * A stored form brought up to the current shape, before normalisation.
 *
 * Before version 2 an Atlas model with its own batch parameter ignored
 * `count`: a form left on GPT Image with `count: 4` (from another provider)
 * and `n: 1` sent one image. Normalised as it is, that `n` would now follow
 * the count and quietly quadruple the next charge, so the stored batch size
 * becomes the count. Only on Atlas — elsewhere the count was always live.
 */
export function migrateStoredForm<T extends Partial<ApiFormState>>(stored: T): T {
  if ((stored.formVersion ?? 1) >= API_FORM_VERSION) return stored;
  const migrated: T = { ...stored, formVersion: API_FORM_VERSION };
  const modelId = stored.atlasImageModel;
  if (stored.provider !== "atlas" || !modelId || !isAtlasModelId(modelId)) return migrated;
  const batch = atlasBatchSplit(getAtlasModel(modelId), 1)?.param;
  if (!batch) return migrated;
  const value = Number(stored.atlasImageParams?.[batch.name] ?? batch.default ?? 1);
  return { ...migrated, count: Number.isInteger(value) && value >= 1 ? value : 1 };
}

function parseForm(raw: string): ApiFormState {
  const parsed = migrateStoredForm(JSON.parse(raw) as LegacyGrokForm);
  const { imageResolution, ...rest } = parsed;
  const merged: ApiFormState = {
    ...DEFAULT_API_FORM,
    ...rest,
    ...(imageResolution ? { imageSizeTier: imageResolution } : {}),
  };
  // A model that has since left the registry must not wedge the tab —
  // getApiModel throws for it, and the caller falls back to defaults.
  const registered = getApiModel(merged.model);
  // Forms persisted before Atlas existed carry no `provider`, and the default
  // one belongs to a different model than the `model` they did save. Deriving
  // it back keeps a returning user on the provider they left off on.
  if (merged.provider !== "atlas") merged.provider = registered.provider;
  return normalizeForm(merged).form;
}

/**
 * Restores a persisted form, dropping anything that no longer type-checks.
 * `legacyRaw` is the pre-switcher payload, read only when the current key is
 * absent so a returning user doesn't silently lose their last settings.
 */
export function hydrateForm(raw: string | null, legacyRaw?: string | null): ApiFormState {
  for (const candidate of [raw, legacyRaw]) {
    if (!candidate) continue;
    try {
      return parseForm(candidate);
    } catch {
      // Corrupt or stale — try the next source, then give up on defaults.
    }
  }
  return DEFAULT_API_FORM;
}
