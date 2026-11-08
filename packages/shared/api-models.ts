/**
 * Registry of every model reachable from the "API" tab, plus the exact
 * capability surface of each one.
 *
 * This module is the single source of truth: the form renders its controls
 * from these descriptors and the Convex mutations validate against the very
 * same objects. Anything hardcoded in JSX instead would silently drift away
 * from what the API actually accepts.
 *
 * Every field here was read off fal's OpenAPI documents
 * (https://fal.ai/api/openapi/queue/openapi.json?endpoint_id=…) rather than
 * inferred, because the models differ in small, unguessable ways: Lite has no
 * `seed`, Pro has no `max_images`, Mini has no `bitrate_mode`, and Seedance
 * wants `duration` as a *string*.
 */

export type Provider = "grok" | "fal" | "higgsfield";
export type MediaType = "image" | "video";
export type ApiModelId =
  | "grok"
  | "seedream-4.5"
  | "seedream-5-lite"
  | "seedream-5-pro"
  | "hf-seedream-4.5"
  | "hf-seedream-5-lite"
  | "hf-seedream-5-pro";
export type VideoTier = "mini" | "fast" | "standard";

export const PROVIDER_LABELS: Record<Provider, string> = {
  higgsfield: "Higgsfield",
  fal: "fal.ai",
  grok: "Grok",
};

/**
 * Order the switcher renders in, which is a display choice and independent of
 * which model the form opens on — that is still Higgsfield.
 */
export const PROVIDER_ORDER: Provider[] = ["grok", "higgsfield", "fal"];

export type Dimensions = { width: number; height: number };
export type SizeTier = { value: string; label: string };

/** Ratios offered for images. "auto" is resolved before the request (see resolveImageRatio). */
export const IMAGE_ASPECT_RATIOS = [
  "auto",
  "1:1",
  "16:9",
  "9:16",
  "4:3",
  "3:4",
  "3:2",
  "2:3",
  "2:1",
  "1:2",
] as const;

/**
 * Every Grok Imagine video model takes the same nine ratios (xAI's
 * capabilities table, 2026-10). 21:9 and 5:2 arrived with 1.5 Lite's launch.
 * Image-to-video ignores the field — the clip follows its first frame — so
 * there the chosen ratio crops the frames instead (`grokFrameCrops`).
 */
const GROK_VIDEO_ASPECT_RATIOS = [
  "16:9",
  "9:16",
  "1:1",
  "4:3",
  "3:4",
  "3:2",
  "2:3",
  "21:9",
  "5:2",
] as const;
/** Seedance's own enum — note it has 21:9 and 4:3 but NOT 3:2 / 2:3. */
const SEEDANCE_ASPECT_RATIOS = ["auto", "21:9", "16:9", "4:3", "1:1", "3:4", "9:16"] as const;

/**
 * Seedance accepts "auto" plus 4…15. We deliberately do not expose "auto":
 * it lets the model pick the length, which makes the price unknowable before
 * the click. Everything else stays available.
 */
const SEEDANCE_DURATIONS = [4, 5, 6, 8, 10, 12, 15] as const;
/**
 * Every whole second from 1 to 15, which is what 1.5 and 1.5 Lite accept
 * (REST reference: `duration` in [1, 15], default 8). The form used to offer
 * three curated lengths; the default stays at 6 so quota is something chosen.
 */
export const GROK_VIDEO_DURATIONS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15] as const;

/**
 * Every resolution the endpoint accepts. 1080p is conditional: text-to-video
 * and image-to-video render it, reference-to-video is refused with "1080p video
 * resolution is not supported for reference-to-video requests" (probed live,
 * 2026-08-09). In this app that boundary is the reference count — two or more
 * references make the request reference-to-video. `videoResolutions` applies
 * the rule; this is the unfiltered set.
 */
export const GROK_VIDEO_RESOLUTIONS = ["480p", "720p", "1080p"] as const;
export const GROK_VIDEO_HD_RESOLUTION = "1080p";
/** Most references a request can carry and still render 1080p. */
export const GROK_VIDEO_HD_MAX_REFERENCES = 1;

// ---------------------------------------------------------------------------
// Grok Imagine model slugs
//
// Shared rather than kept in the Convex config, because the registry, the
// payload builder (grok-imagine.ts), the metered rate card and the processor all
// have to name the same model — and the native clients read this module.
// ---------------------------------------------------------------------------

export const GROK_IMAGE_MODEL_STANDARD = "grok-imagine-image";
/**
 * Retired by xAI on 2026-11-02, after which the slug is served by 2.0 at
 * `quality: "low"`. Kept on purpose: the owner still uses it, and the slug keeps
 * resolving, so nothing breaks on the day.
 */
export const GROK_IMAGE_MODEL_QUALITY = "grok-imagine-image-quality";
export const GROK_IMAGE_MODEL_V2 = "grok-imagine-image-2.0";

/** Native 1080p, references, voices, pinned frames. */
export const GROK_VIDEO_MODEL_V15 = "grok-imagine-video-1.5";
/** Text- and image-to-video only, cheapest per second, 1080p upscaled from 720p. */
export const GROK_VIDEO_MODEL_LITE = "grok-imagine-video-1.5-lite";
/** The original model: the only one that edits and extends an existing clip. */
export const GROK_VIDEO_MODEL_BASE = "grok-imagine-video";

/** The two models the Generate mode chooses between. */
export const GROK_VIDEO_GENERATE_MODELS = [GROK_VIDEO_MODEL_V15, GROK_VIDEO_MODEL_LITE] as const;
export type GrokVideoModelId = (typeof GROK_VIDEO_GENERATE_MODELS)[number];

export function isGrokVideoModelId(value: unknown): value is GrokVideoModelId {
  return GROK_VIDEO_GENERATE_MODELS.includes(value as GrokVideoModelId);
}

/**
 * What the Grok video form does. Generate is text/image/reference-to-video on
 * 1.5 or Lite; Edit and Extend send an existing clip to the base model, on
 * their own endpoints (`/videos/edits`, `/videos/extensions`).
 */
export const GROK_VIDEO_MODES = ["generate", "edit", "extend"] as const;
export type GrokVideoMode = (typeof GROK_VIDEO_MODES)[number];

export function isGrokVideoMode(value: unknown): value is GrokVideoMode {
  return GROK_VIDEO_MODES.includes(value as GrokVideoMode);
}

/** Pins per request on 1.5: interior frames between `image` and `last_frame`. */
export const GROK_VIDEO_MAX_KEYFRAMES = 4;

/**
 * Edit: an mp4 up to 8.7 s; the output keeps its length, ratio and resolution
 * (capped at 720p), so the request has no duration, ratio or resolution.
 */
export const GROK_VIDEO_EDIT_MAX_SOURCE_SECONDS = 8.7;
/** Extend: a 2–15 s source, continued from its last frame by 2–10 s. */
export const GROK_VIDEO_EXTEND_SOURCE_SECONDS = { min: 2, max: 15 } as const;
export const GROK_VIDEO_EXTEND_DURATIONS = [2, 3, 4, 5, 6, 7, 8, 9, 10] as const;
export const GROK_VIDEO_EXTEND_DEFAULT_DURATION = 6;
/** Edit and extend output follows the source, capped at 720p. */
export const GROK_VIDEO_SOURCE_RESOLUTIONS = ["480p", "720p"] as const;

/**
 * Preset voices the video model can make a subject speak with — the same
 * roster as the xAI text-to-speech API. Read from the endpoint itself (probed
 * live 2026-08-16): an unknown voice_id is refused with this exact list, so a
 * drift here is a 400 with the fresh roster in the message, not a silent gap.
 *
 * Selecting any voice makes the request reference-to-video regardless of how
 * many images ride along, and reference-to-video is refused at 1080p — which
 * is why `videoResolutions` withholds 1080p as soon as one is chosen.
 */
export const GROK_VIDEO_VOICES = [
  "ara",
  "eve",
  "leo",
  "rex",
  "sal",
  "carina",
  "zagan",
  "helix",
  "orion",
  "luna",
  "iris",
  "altair",
  "zenith",
  "perseus",
  "helios",
  "lux",
  "kepler",
  "rigel",
  "cosmo",
  "celeste",
  "ursa",
  "sirius",
  "lumen",
  "castor",
  "naksh",
  "atlas",
] as const;
export const GROK_VIDEO_MAX_VOICES = 3;

/**
 * Grok's image quality switch is really a model switch, and since 2.0 shipped
 * (2026-08-04) also a parameter: the v2 entries run `grok-imagine-image-2.0`
 * with its `quality` field, the two legacy entries pick between the original
 * model pair. All of them bill against the same subscription; the quota they
 * meter differs — see GROK_RATE_CARD in grok-imagine.ts for xAI's per-image
 * prices.
 *
 * `v2-auto` sends `quality: "auto"`, which xAI documents as low for a
 * generation and medium for an edit, billed at whichever it served.
 */
export const GROK_IMAGE_QUALITIES = [
  "standard",
  "quality",
  "v2-low",
  "v2-medium",
  "v2-auto",
] as const;
export type GrokImageQuality = (typeof GROK_IMAGE_QUALITIES)[number];

export function isGrokImageQuality(value: string | undefined): value is GrokImageQuality {
  return GROK_IMAGE_QUALITIES.includes(value as GrokImageQuality);
}

/** The three entries that run `grok-imagine-image-2.0`. */
export function isGrokV2Quality(value: string | undefined): boolean {
  return value === "v2-low" || value === "v2-medium" || value === "v2-auto";
}

/**
 * Ratios every Grok image model accepts: the REST enum for /images/generations
 * and /images/edits, minus the two that xAI's migration guide (2026-09-02)
 * lists as 2.0 additions. The 19.5:9 and 20:9 phone ratios sit in the general
 * table with no model named, so they are offered on all three.
 */
export const GROK_IMAGE_ASPECT_RATIOS = [
  "auto",
  "1:1",
  "16:9",
  "9:16",
  "4:3",
  "3:4",
  "3:2",
  "2:3",
  "2:1",
  "1:2",
  "19.5:9",
  "9:19.5",
  "20:9",
  "9:20",
] as const;

/** `grok-imagine-image-2.0` additionally accepts 21:9 and 5:2. */
export const GROK_IMAGE_V2_ASPECT_RATIOS = [...GROK_IMAGE_ASPECT_RATIOS, "21:9", "5:2"] as const;

/** Edit sources: three on the legacy models, five on 2.0. */
export const GROK_IMAGE_MAX_REFERENCES = 3;
export const GROK_IMAGE_V2_MAX_REFERENCES = 5;

// ---------------------------------------------------------------------------
// Capability descriptors
// ---------------------------------------------------------------------------

type CommonImageCaps = {
  aspectRatios: readonly string[];
  sizeTiers: readonly SizeTier[];
  defaultSizeTier: string;
  counts: readonly number[];
  maxReferences: number;
};

export type GrokImageCaps = CommonImageCaps & {
  kind: "grok";
  /** Grok's Standard/Quality model switch. Seedream has no equivalent. */
  qualities: readonly SizeTier[];
  /**
   * What the quality switch changes beyond the model. `aspectRatios` and
   * `maxReferences` above are the legacy models' — the safe answer for a client
   * that reads the caps directly — and 2.0 widens both. Read them through
   * `imageAspectRatios` / `imageMaxReferences`, never off this map.
   */
  qualityOverrides: Partial<
    Record<GrokImageQuality, { aspectRatios: readonly string[]; maxReferences: number }>
  >;
};

export type SeedreamImageCaps = CommonImageCaps & {
  kind: "seedream";
  textEndpoint: string;
  editEndpoint: string;
  supportsSeed: boolean;
  supportsMaxImages: boolean;
  supportsOutputFormat: boolean;
  /** sizeTier → ratio → exact pixels. Never `auto_*` presets, see resolveImageRatio. */
  ratioPixels: Record<string, Record<string, Dimensions>>;
};

/**
 * Higgsfield reaches the same ByteDance models through its own catalogue, so
 * the surface differs: no explicit pixel table (the vendor derives size from
 * the aspect ratio), and job types rather than REST endpoints.
 *
 * Every value below was read from `higgsfield model get <job_type> --json`, not
 * inferred. That matters: their enums are narrower than they look. There is no
 * `auto`, no `2:1` and no `1:2` for images, and an undeclared value is a hard
 * rejection rather than a coercion.
 */
export type HiggsfieldImageCaps = CommonImageCaps & {
  kind: "higgsfield-image";
  /** `job_set_type` passed to `higgsfield generate create`. */
  jobType: string;
  /** Media flag the CLI expects for references on this model. */
  mediaFlag: string;
  /**
   * Output size is spelled differently per model: 4.5 and Lite take
   * `quality` (basic/high), Pro takes `resolution` (1k/1.5k/2k). Sending the
   * wrong one is an unknown-param error.
   */
  sizeParam: "quality" | "resolution";
};

export type ImageCaps = GrokImageCaps | SeedreamImageCaps | HiggsfieldImageCaps;

type CommonVideoCaps = {
  aspectRatios: readonly string[];
  durations: readonly number[];
  defaultDuration: number;
  defaultResolution: string;
  maxReferences: number;
};

/**
 * How many clips one click produces.
 *
 * No vendor here takes a batch parameter for video, so this is our own fan-out:
 * N independent jobs from one form. Any N works — unlike images, where the
 * counts mirror a vendor's `n` — and each clip is billed in full, so the button
 * has to show the multiple rather than the unit price.
 */
export const VIDEO_COUNTS = [1, 2, 3, 4] as const;

/** One of the two models Grok's Generate mode chooses between. */
export type GrokVideoModelSpec = {
  id: GrokVideoModelId;
  label: string;
  /** Every resolution it renders. 1.5 loses 1080p at reference-to-video. */
  resolutions: readonly string[];
  /** Images one request can carry, pinned frames included. */
  maxImages: number;
  /**
   * Reference images, preset voices, a pinned last frame and keyframes — all
   * of reference-to-video. False means text- and image-to-video only.
   */
  supportsReferenceToVideo: boolean;
  /** One line for the form, saying what sets it apart. */
  note: string;
};

export type GrokVideoCaps = CommonVideoCaps & {
  kind: "grok";
  /**
   * 1.5's resolutions — what a client that predates the model choice offers.
   * The selected model's own list is `models[n].resolutions`.
   */
  resolutions: readonly string[];
  /** Preset voices a subject can speak with; empty selection is the default. */
  voices: readonly string[];
  maxVoices: number;
  /** Generate-mode models, in display order. */
  models: readonly GrokVideoModelSpec[];
  defaultModel: GrokVideoModelId;
  modes: readonly { value: GrokVideoMode; label: string }[];
  maxKeyframes: number;
  /** Extension lengths for Extend (the `duration` of /videos/extensions). */
  extendDurations: readonly number[];
  defaultExtendDuration: number;
};

export type SeedanceVideoCaps = CommonVideoCaps & {
  kind: "seedance";
  tiers: readonly VideoTier[];
  defaultTier: VideoTier;
  /** 1080p and 4k exist on Standard only — Fast and Mini top out at 720p. */
  resolutionsByTier: Record<VideoTier, readonly string[]>;
  /** Mini's schema has no bitrate_mode; sending it would be rejected. */
  bitrateModeByTier: Record<VideoTier, boolean>;
  endpointsByTier: Record<VideoTier, { text: string; image: string; reference: string }>;
  supportsAudio: boolean;
  supportsEndFrame: boolean;
};

/**
 * One video model in Higgsfield's catalogue.
 *
 * They differ in ways the interface has to respect rather than paper over:
 * only the Seedance pair accepts `image_references`, which is what makes
 * @-tagging in the prompt possible at all. The rest take a first frame and,
 * mostly, a last one — so those get explicit Start/End frame slots instead of a
 * reference list the model would reject.
 */
export type HiggsfieldVideoModel = {
  jobType: string;
  label: string;
  aspectRatios: readonly string[];
  /** Lengths this model accepts. Probed per model — they are not the same. */
  durations: readonly number[];
  /** Empty when the model exposes no resolution parameter (Kling). */
  resolutions: readonly string[];
  defaultResolution: string;
  /** `image_references`, and therefore prompt tagging. */
  supportsReferences: boolean;
  maxReferences: number;
  supportsStartFrame: boolean;
  supportsEndFrame: boolean;
  /** An extra single-choice parameter: Seedance `mode`, Kling `mode`. */
  modeParam?: { name: string; values: readonly string[]; default: string };
  /**
   * Name of the audio switch, which is not the same word everywhere: Seedance
   * declares `generate_audio` (boolean), Kling declares `sound` (on/off), and
   * Wan and Happy Horse declare neither.
   */
  audioParam?: { name: "generate_audio"; kind: "boolean" } | { name: "sound"; kind: "on-off" };
};

/** Higgsfield exposes several video models; the choice is the user's. */
export type HiggsfieldVideoCaps = CommonVideoCaps & {
  kind: "higgsfield-video";
  models: readonly HiggsfieldVideoModel[];
  defaultJobType: string;
};

export type VideoCaps = GrokVideoCaps | SeedanceVideoCaps | HiggsfieldVideoCaps;

export type ApiModel = {
  id: ApiModelId;
  label: string;
  /** Short label for result badges. */
  badge: string;
  provider: Provider;
  image: ImageCaps;
  video: VideoCaps;
};

// ---------------------------------------------------------------------------
// Pixel tables
//
// Generated to sit inside each model's documented limits with margin, snapped
// to multiples of 16, and re-validated by lib/api-models.test.ts. For Pro the
// tier also decides the price bracket (the 1536² boundary doubles the cost),
// so the tables are chosen to land firmly on the intended side of it.
// ---------------------------------------------------------------------------

/** Seedream 4.5 / 5.0 Lite: sides 1920–4096, total pixels 2560×1440 … 4096×4096. */
const SEEDREAM_2K: Record<string, Dimensions> = {
  "1:1": { width: 2048, height: 2048 },
  "4:3": { width: 2560, height: 1920 },
  "3:4": { width: 1920, height: 2560 },
  "3:2": { width: 2880, height: 1920 },
  "2:3": { width: 1920, height: 2880 },
  "16:9": { width: 3408, height: 1920 },
  "9:16": { width: 1920, height: 3408 },
  "2:1": { width: 3840, height: 1920 },
  "1:2": { width: 1920, height: 3840 },
};

const SEEDREAM_3K: Record<string, Dimensions> = {
  "1:1": { width: 3056, height: 3056 },
  "4:3": { width: 3520, height: 2640 },
  "3:4": { width: 2640, height: 3520 },
  "3:2": { width: 3728, height: 2496 },
  "2:3": { width: 2496, height: 3728 },
  "16:9": { width: 4064, height: 2288 },
  "9:16": { width: 2288, height: 4064 },
  // The 4096 side cap binds before the area target does.
  "2:1": { width: 4096, height: 2048 },
  "1:2": { width: 2048, height: 4096 },
};

const SEEDREAM_4K: Record<string, Dimensions> = {
  "1:1": { width: 3872, height: 3872 },
  "4:3": { width: 4096, height: 3072 },
  "3:4": { width: 3072, height: 4096 },
  "3:2": { width: 4096, height: 2736 },
  "2:3": { width: 2736, height: 4096 },
  "16:9": { width: 4096, height: 2304 },
  "9:16": { width: 2304, height: 4096 },
  "2:1": { width: 4096, height: 2048 },
  "1:2": { width: 2048, height: 4096 },
};

/** Seedream 5.0 Pro: total pixels 1024×1024 … 2048×2048. Stays ≤1536² → $0.0675. */
const SEEDREAM_PRO_1K: Record<string, Dimensions> = {
  "1:1": { width: 1504, height: 1504 },
  "4:3": { width: 1728, height: 1296 },
  "3:4": { width: 1296, height: 1728 },
  "3:2": { width: 1840, height: 1232 },
  "2:3": { width: 1232, height: 1840 },
  "16:9": { width: 2000, height: 1120 },
  "9:16": { width: 1120, height: 2000 },
  "2:1": { width: 2128, height: 1056 },
  "1:2": { width: 1056, height: 2128 },
};

/** Above 1536² and inside 2048² → $0.135. */
const SEEDREAM_PRO_2K: Record<string, Dimensions> = {
  "1:1": { width: 2016, height: 2016 },
  "4:3": { width: 2320, height: 1744 },
  "3:4": { width: 1744, height: 2320 },
  "3:2": { width: 2464, height: 1648 },
  "2:3": { width: 1648, height: 2464 },
  "16:9": { width: 2688, height: 1504 },
  "9:16": { width: 1504, height: 2688 },
  "2:1": { width: 2848, height: 1424 },
  "1:2": { width: 1424, height: 2848 },
};

/** Documented pixel envelopes, used by the test to prove the tables stay legal. */
export const SEEDREAM_LIMITS = {
  "seedream-4.5": { minSide: 1920, maxSide: 4096, minArea: 2560 * 1440, maxArea: 4096 * 4096 },
  "seedream-5-lite": { minSide: 1920, maxSide: 4096, minArea: 2560 * 1440, maxArea: 4096 * 4096 },
  "seedream-5-pro": { minSide: 1, maxSide: 4096, minArea: 1024 * 1024, maxArea: 2048 * 2048 },
} as const;

/** Pro's price bracket flips above this many pixels. */
export const PRO_CHEAP_TIER_MAX_PIXELS = 1536 * 1536;

// ---------------------------------------------------------------------------
// Endpoints
// ---------------------------------------------------------------------------

const SEEDANCE_ENDPOINTS: Record<VideoTier, { text: string; image: string; reference: string }> = {
  mini: {
    text: "bytedance/seedance-2.0/mini/text-to-video",
    image: "bytedance/seedance-2.0/mini/image-to-video",
    reference: "bytedance/seedance-2.0/mini/reference-to-video",
  },
  fast: {
    text: "bytedance/seedance-2.0/fast/text-to-video",
    image: "bytedance/seedance-2.0/fast/image-to-video",
    reference: "bytedance/seedance-2.0/fast/reference-to-video",
  },
  standard: {
    text: "bytedance/seedance-2.0/text-to-video",
    image: "bytedance/seedance-2.0/image-to-video",
    reference: "bytedance/seedance-2.0/reference-to-video",
  },
};

/** Shared by every Seedream model — only the endpoints and pixel tables differ. */
const SEEDANCE_VIDEO_CAPS: SeedanceVideoCaps = {
  kind: "seedance",
  aspectRatios: SEEDANCE_ASPECT_RATIOS,
  durations: SEEDANCE_DURATIONS,
  defaultDuration: 10,
  defaultResolution: "720p",
  maxReferences: 9,
  tiers: ["mini", "fast", "standard"],
  defaultTier: "mini",
  resolutionsByTier: {
    mini: ["480p", "720p"],
    fast: ["480p", "720p"],
    standard: ["480p", "720p", "1080p", "4k"],
  },
  bitrateModeByTier: { mini: false, fast: true, standard: true },
  endpointsByTier: SEEDANCE_ENDPOINTS,
  supportsAudio: true,
  supportsEndFrame: true,
};

// ---------------------------------------------------------------------------
// The registry
// ---------------------------------------------------------------------------

/**
 * Higgsfield's video catalogue, transcribed from `higgsfield model get`.
 *
 * The differences are load-bearing, not cosmetic: only the Seedance pair takes
 * `image_references`, so only there does @-tagging in the prompt mean anything.
 * The others animate a first frame, and one of them cannot even do a last one.
 */
const HIGGSFIELD_VIDEO_MODELS: HiggsfieldVideoModel[] = [
  {
    jobType: "seedance_2_0",
    label: "Seedance 2.0",
    aspectRatios: ["auto", "16:9", "9:16", "4:3", "3:4", "1:1", "21:9"],
    durations: [4, 5, 6, 8, 10, 12, 15],
    resolutions: ["480p", "720p", "1080p", "4k"],
    defaultResolution: "720p",
    supportsReferences: true,
    // Their rule: at most 9 image references, counting start and end frames.
    maxReferences: 9,
    supportsStartFrame: true,
    supportsEndFrame: true,
    // "Seedance 2.0 Fast" is this parameter, not a separate model. Their rule:
    // fast supports 480p/720p only.
    modeParam: { name: "mode", values: ["std", "fast"], default: "std" },
    audioParam: { name: "generate_audio", kind: "boolean" },
  },
  {
    jobType: "seedance_2_0_mini",
    label: "Seedance 2.0 Mini",
    aspectRatios: ["auto", "16:9", "9:16", "4:3", "3:4", "1:1", "21:9"],
    durations: [4, 5, 6, 8, 10, 12, 15],
    resolutions: ["480p", "720p"],
    defaultResolution: "720p",
    supportsReferences: true,
    maxReferences: 9,
    supportsStartFrame: true,
    supportsEndFrame: true,
    audioParam: { name: "generate_audio", kind: "boolean" },
  },
  {
    jobType: "wan2_7",
    label: "Wan 2.7",
    aspectRatios: ["16:9", "9:16", "1:1", "4:3", "3:4"],
    // The only one that goes below three seconds.
    durations: [2, 3, 4, 5, 6, 8, 10, 12, 15],
    resolutions: ["720p", "1080p"],
    defaultResolution: "720p",
    supportsReferences: false,
    maxReferences: 0,
    supportsStartFrame: true,
    supportsEndFrame: true,
  },
  {
    jobType: "kling3_0",
    label: "Kling v3.0",
    aspectRatios: ["16:9", "9:16", "1:1"],
    durations: [3, 4, 5, 6, 8, 10, 12, 15],
    // Kling exposes no resolution parameter at all; quality rides on `mode`.
    resolutions: [],
    defaultResolution: "",
    supportsReferences: false,
    maxReferences: 0,
    supportsStartFrame: true,
    supportsEndFrame: true,
    modeParam: { name: "mode", values: ["std", "pro", "4k"], default: "std" },
    // Kling's own spelling. Turning it off is 25% cheaper and was unreachable
    // while this was modelled as a plain boolean.
    audioParam: { name: "sound", kind: "on-off" },
  },
  {
    jobType: "happy_horse_video",
    label: "Happy Horse",
    aspectRatios: ["16:9", "9:16", "1:1", "4:3", "3:4"],
    durations: [3, 4, 5, 6, 8, 10, 12, 15],
    resolutions: ["720p", "1080p"],
    defaultResolution: "720p",
    supportsReferences: false,
    maxReferences: 0,
    supportsStartFrame: true,
    // The only one with no end frame.
    supportsEndFrame: false,
  },
];

/** Durations are a plain integer on Higgsfield, unlike fal's string enum. */
const HIGGSFIELD_DURATIONS = [4, 5, 6, 8, 10, 12, 15] as const;

const HIGGSFIELD_VIDEO_CAPS: HiggsfieldVideoCaps = {
  kind: "higgsfield-video",
  models: HIGGSFIELD_VIDEO_MODELS,
  defaultJobType: "seedance_2_0",
  // Aggregates, used only where a specific model has not been chosen yet.
  aspectRatios: ["auto", "16:9", "9:16", "4:3", "3:4", "1:1", "21:9"],
  durations: HIGGSFIELD_DURATIONS,
  defaultDuration: 10,
  defaultResolution: "720p",
  maxReferences: 9,
};

/** Their image enum: no `auto`, no `2:1`, no `1:2`, but it does have 21:9. */
const HIGGSFIELD_IMAGE_RATIOS = ["1:1", "4:3", "3:4", "16:9", "9:16", "3:2", "2:3", "21:9"];
const HIGGSFIELD_QUALITY_TIERS = [
  { value: "basic", label: "Basic" },
  { value: "high", label: "High" },
];

function higgsfieldImageCaps(options: {
  jobType: string;
  ratios?: readonly string[];
  sizeParam: "quality" | "resolution";
  sizeTiers?: readonly SizeTier[];
  defaultSizeTier: string;
  maxReferences: number;
}): HiggsfieldImageCaps {
  return {
    kind: "higgsfield-image",
    jobType: options.jobType,
    mediaFlag: "image-references",
    sizeParam: options.sizeParam,
    aspectRatios: options.ratios ?? HIGGSFIELD_IMAGE_RATIOS,
    sizeTiers: options.sizeTiers ?? HIGGSFIELD_QUALITY_TIERS,
    defaultSizeTier: options.defaultSizeTier,
    // No batch parameter exists, so several images means several jobs — the
    // same fan-out already used for Grok's parallel reference edits.
    counts: [1, 2, 3, 4],
    maxReferences: options.maxReferences,
  };
}

export const API_MODELS: Record<ApiModelId, ApiModel> = {
  "hf-seedream-4.5": {
    id: "hf-seedream-4.5",
    label: "Seedream 4.5",
    badge: "HF SD 4.5",
    provider: "higgsfield",
    image: higgsfieldImageCaps({
      jobType: "seedream_v4_5",
      sizeParam: "quality",
      defaultSizeTier: "basic",
      maxReferences: 14,
    }),
    video: HIGGSFIELD_VIDEO_CAPS,
  },

  "hf-seedream-5-lite": {
    id: "hf-seedream-5-lite",
    label: "Seedream 5.0 Lite",
    badge: "HF SD 5 Lite",
    provider: "higgsfield",
    image: higgsfieldImageCaps({
      jobType: "seedream_v5_lite",
      // Lite's enum is narrower — no 3:2 or 2:3.
      ratios: ["1:1", "4:3", "3:4", "16:9", "9:16", "21:9"],
      sizeParam: "quality",
      defaultSizeTier: "basic",
      // Its schema declares no reference rule at all, unlike 4.5 (14) and Pro
      // (10), so this takes the conservative documented figure rather than a
      // number nothing backs.
      maxReferences: 10,
    }),
    video: HIGGSFIELD_VIDEO_CAPS,
  },

  "hf-seedream-5-pro": {
    id: "hf-seedream-5-pro",
    label: "Seedream 5.0 Pro",
    badge: "HF SD 5 Pro",
    provider: "higgsfield",
    image: higgsfieldImageCaps({
      jobType: "seedream_v5_pro",
      // Pro sizes by resolution rather than a quality flag.
      sizeParam: "resolution",
      sizeTiers: [
        { value: "1k", label: "1K" },
        { value: "1.5k", label: "1.5K" },
        { value: "2k", label: "2K" },
      ],
      defaultSizeTier: "2k",
      maxReferences: 10,
    }),
    video: HIGGSFIELD_VIDEO_CAPS,
  },

  grok: {
    id: "grok",
    label: "Grok",
    badge: "Grok",
    provider: "grok",
    image: {
      kind: "grok",
      aspectRatios: GROK_IMAGE_ASPECT_RATIOS,
      sizeTiers: [
        { value: "1k", label: "1K" },
        { value: "2k", label: "2K" },
      ],
      // 2K by default: the subscription bills the same either way, so the
      // smaller one is only ever a downgrade you didn't ask for.
      defaultSizeTier: "2k",
      // xAI's `n` goes to 10 ("up to 10 images per request", 2026-10). A plain
      // prompt stays one request whatever the count; an edit is `count`
      // concurrent requests, which is why grokProcessor retries 429s.
      counts: [1, 2, 4, 6, 8, 10],
      maxReferences: GROK_IMAGE_MAX_REFERENCES,
      qualities: [
        { value: "standard", label: "Standard" },
        { value: "quality", label: "Quality" },
        { value: "v2-low", label: "2.0 Low" },
        { value: "v2-medium", label: "2.0 Medium" },
        { value: "v2-auto", label: "2.0 Auto" },
      ],
      qualityOverrides: {
        "v2-low": {
          aspectRatios: GROK_IMAGE_V2_ASPECT_RATIOS,
          maxReferences: GROK_IMAGE_V2_MAX_REFERENCES,
        },
        "v2-medium": {
          aspectRatios: GROK_IMAGE_V2_ASPECT_RATIOS,
          maxReferences: GROK_IMAGE_V2_MAX_REFERENCES,
        },
        "v2-auto": {
          aspectRatios: GROK_IMAGE_V2_ASPECT_RATIOS,
          maxReferences: GROK_IMAGE_V2_MAX_REFERENCES,
        },
      },
    },
    video: {
      kind: "grok",
      aspectRatios: GROK_VIDEO_ASPECT_RATIOS,
      durations: GROK_VIDEO_DURATIONS,
      defaultDuration: 6,
      resolutions: GROK_VIDEO_RESOLUTIONS,
      // Defaults stay at the cheap end deliberately. On 1.5, 1080p meters at
      // about 1.8× 720p and 15s at 2.5× 6s against the same subscription quota,
      // so both should be something asked for rather than arrived at.
      defaultResolution: "480p",
      // 1.5 takes up to 14 reference images (xAI, 2026-10); the old figure was
      // the base model's 7. Lite takes one image, Edit and Extend none — the
      // selected mode's figure comes from `grokVideoOptions`.
      maxReferences: 14,
      voices: GROK_VIDEO_VOICES,
      maxVoices: GROK_VIDEO_MAX_VOICES,
      models: [
        {
          id: GROK_VIDEO_MODEL_V15,
          label: "1.5",
          resolutions: GROK_VIDEO_RESOLUTIONS,
          maxImages: 14,
          supportsReferenceToVideo: true,
          note: "Native 1080p, references, voices and pinned frames.",
        },
        {
          id: GROK_VIDEO_MODEL_LITE,
          label: "1.5 Lite",
          resolutions: GROK_VIDEO_RESOLUTIONS,
          maxImages: 1,
          supportsReferenceToVideo: false,
          note: "Text or one start image only; cheapest per second, 1080p is upscaled from 720p.",
        },
      ],
      defaultModel: GROK_VIDEO_MODEL_V15,
      modes: [
        { value: "generate", label: "Generate" },
        { value: "edit", label: "Edit" },
        { value: "extend", label: "Extend" },
      ],
      maxKeyframes: GROK_VIDEO_MAX_KEYFRAMES,
      extendDurations: GROK_VIDEO_EXTEND_DURATIONS,
      defaultExtendDuration: GROK_VIDEO_EXTEND_DEFAULT_DURATION,
    },
  },

  "seedream-4.5": {
    id: "seedream-4.5",
    label: "Seedream 4.5",
    badge: "SD 4.5",
    provider: "fal",
    image: {
      kind: "seedream",
      aspectRatios: IMAGE_ASPECT_RATIOS,
      // 4.5's floor is ~3.7 MP, so there is no meaningful "1K" for it.
      sizeTiers: [
        { value: "2K", label: "2K" },
        { value: "4K", label: "4K" },
      ],
      defaultSizeTier: "2K",
      counts: [1, 2, 4, 6],
      maxReferences: 10,
      textEndpoint: "fal-ai/bytedance/seedream/v4.5/text-to-image",
      editEndpoint: "fal-ai/bytedance/seedream/v4.5/edit",
      supportsSeed: true,
      supportsMaxImages: true,
      supportsOutputFormat: false,
      ratioPixels: { "2K": SEEDREAM_2K, "4K": SEEDREAM_4K },
    },
    video: SEEDANCE_VIDEO_CAPS,
  },

  "seedream-5-lite": {
    id: "seedream-5-lite",
    label: "Seedream 5.0 Lite",
    badge: "SD 5 Lite",
    provider: "fal",
    image: {
      kind: "seedream",
      aspectRatios: IMAGE_ASPECT_RATIOS,
      sizeTiers: [
        { value: "2K", label: "2K" },
        { value: "3K", label: "3K" },
        { value: "4K", label: "4K" },
      ],
      defaultSizeTier: "2K",
      counts: [1, 2, 4, 6],
      maxReferences: 10,
      textEndpoint: "fal-ai/bytedance/seedream/v5/lite/text-to-image",
      editEndpoint: "fal-ai/bytedance/seedream/v5/lite/edit",
      supportsSeed: false,
      supportsMaxImages: true,
      supportsOutputFormat: false,
      ratioPixels: { "2K": SEEDREAM_2K, "3K": SEEDREAM_3K, "4K": SEEDREAM_4K },
    },
    video: SEEDANCE_VIDEO_CAPS,
  },

  "seedream-5-pro": {
    id: "seedream-5-pro",
    label: "Seedream 5.0 Pro",
    badge: "SD 5 Pro",
    provider: "fal",
    image: {
      kind: "seedream",
      aspectRatios: IMAGE_ASPECT_RATIOS,
      sizeTiers: [
        { value: "1K", label: "1K" },
        { value: "2K", label: "2K" },
      ],
      defaultSizeTier: "2K",
      counts: [1, 2, 4, 6],
      maxReferences: 10,
      textEndpoint: "bytedance/seedream/v5/pro/text-to-image",
      editEndpoint: "bytedance/seedream/v5/pro/edit",
      supportsSeed: false,
      // Pro's schema omits max_images entirely.
      supportsMaxImages: false,
      supportsOutputFormat: true,
      ratioPixels: { "1K": SEEDREAM_PRO_1K, "2K": SEEDREAM_PRO_2K },
    },
    video: SEEDANCE_VIDEO_CAPS,
  },
};

export const API_MODEL_IDS = Object.keys(API_MODELS) as ApiModelId[];

export function isApiModelId(value: string): value is ApiModelId {
  return Object.hasOwn(API_MODELS, value);
}

/** Throws on an unknown id: an unregistered model is a bug, not a runtime state. */
export function getApiModel(id: string): ApiModel {
  const model = API_MODELS[id as ApiModelId];
  if (!model) throw new Error(`Unknown API model: ${id}`);
  return model;
}

// ---------------------------------------------------------------------------
// Derived lookups
// ---------------------------------------------------------------------------

/** Numeric width/height ratio; "auto" has none. */
export function ratioValue(ratio: string): number | null {
  if (!ratio || ratio === "auto") return null;
  const [w, h] = ratio.split(":").map(Number);
  return w > 0 && h > 0 ? w / h : null;
}

/**
 * The largest centred region of a `width` × `height` picture with the shape of
 * `ratio`, in whole pixels. The whole picture where the ratio is "auto",
 * unparseable, or already the picture's own.
 */
export function centerCropRect(
  width: number,
  height: number,
  ratio: string | undefined,
): { x: number; y: number; width: number; height: number } {
  const whole = { x: 0, y: 0, width, height };
  const target = ratio ? ratioValue(ratio) : null;
  if (target === null || width <= 0 || height <= 0) return whole;
  // Whichever edge is too long for the ratio is the one that gets cut.
  const crop =
    width / height > target
      ? { width: Math.max(1, Math.round(height * target)), height }
      : { width, height: Math.max(1, Math.round(width / target)) };
  if (crop.width === width && crop.height === height) return whole;
  return {
    x: Math.floor((width - crop.width) / 2),
    y: Math.floor((height - crop.height) / 2),
    ...crop,
  };
}

/** Closest ratio in `allowed` to the given numeric value, compared in log space
 *  so 2:1 and 1:2 are equidistant from 1:1. */
export function nearestRatio(target: number, allowed: readonly string[]): string {
  let best = allowed[0];
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const candidate of allowed) {
    const value = ratioValue(candidate);
    if (value === null) continue;
    const distance = Math.abs(Math.log(value / target));
    if (distance < bestDistance) {
      bestDistance = distance;
      best = candidate;
    }
  }
  return best;
}

/**
 * Turns the form's aspect ratio into one the pixel tables actually have.
 *
 * "auto" is never forwarded to fal: the `auto_*` presets leave the output size
 * (and therefore Pro's price bracket) up to the model. With a reference we
 * match its shape; without one there is nothing to match, so square it is.
 */
export function resolveImageRatio(
  ratio: string | undefined,
  allowed: readonly string[],
  referenceAspect?: number,
): string {
  const concrete = allowed.filter((candidate) => candidate !== "auto");
  if (ratio && ratio !== "auto" && concrete.includes(ratio)) return ratio;
  if (ratio && ratio !== "auto") {
    const value = ratioValue(ratio);
    if (value !== null) return nearestRatio(value, concrete);
  }
  if (referenceAspect && referenceAspect > 0) return nearestRatio(referenceAspect, concrete);
  return concrete.includes("1:1") ? "1:1" : concrete[0];
}

export function imageDimensions(
  caps: SeedreamImageCaps,
  sizeTier: string,
  ratio: string,
): Dimensions {
  const table = caps.ratioPixels[sizeTier];
  if (!table) throw new Error(`Unknown size tier "${sizeTier}" for this model`);
  const dimensions = table[ratio];
  if (!dimensions) throw new Error(`Unknown aspect ratio "${ratio}" for size tier ${sizeTier}`);
  return dimensions;
}

/**
 * The Grok video request a caller is asking about, for the lookups below.
 *
 * Every field is optional, and absent means what a client that predates the
 * model choice always meant: Generate, on 1.5, with references and voices
 * deciding reference-to-video exactly as `referenceCount` and `voiceCount`
 * always did. `referenceToVideo` is `planGrokVideo(...).kind === "reference"`
 * (grok-imagine.ts) — passed in rather than recomputed here, because pinned
 * frames make it more than a count.
 */
export type GrokVideoContext = {
  mode?: string;
  model?: string;
  referenceToVideo?: boolean;
};

/** The Generate-mode model a stored value names, falling back to 1.5. */
export function grokVideoModelSpec(
  caps: GrokVideoCaps,
  model: string | undefined,
): GrokVideoModelSpec {
  return (
    caps.models.find((spec) => spec.id === model) ??
    caps.models.find((spec) => spec.id === caps.defaultModel) ??
    caps.models[0]
  );
}

/**
 * Ratios the image model accepts at this quality. Grok 2.0 adds 21:9 and 5:2
 * to what the legacy pair takes; every other model has one list.
 */
export function imageAspectRatios(caps: ImageCaps, quality?: string): readonly string[] {
  if (caps.kind !== "grok" || !isGrokImageQuality(quality)) return caps.aspectRatios;
  return caps.qualityOverrides[quality]?.aspectRatios ?? caps.aspectRatios;
}

/** Edit sources the image model takes at this quality: 3 on Grok's legacy pair, 5 on 2.0. */
export function imageMaxReferences(caps: ImageCaps, quality?: string): number {
  if (caps.kind !== "grok" || !isGrokImageQuality(quality)) return caps.maxReferences;
  return caps.qualityOverrides[quality]?.maxReferences ?? caps.maxReferences;
}

export function videoResolutions(
  caps: VideoCaps,
  tier: VideoTier | undefined,
  jobType?: string,
  mode?: string,
  /**
   * References attached to the request. Only Grok reads it, and only to decide
   * whether 1080p is on the table. Optional so the many callers that never see
   * Grok video keep working; when it is absent the conditional resolution is
   * withheld, which is the safe direction — offering it and taking it away at
   * submit is worse than not showing it.
   */
  referenceCount?: number,
  /**
   * Preset voices on the request. Grok-only, like `referenceCount`, and for the
   * same rule: any voice makes the job reference-to-video (probed live
   * 2026-08-16 — a voices-only request is refused at 1080p with the
   * reference-to-video message), so 1080p leaves the menu with the first one.
   */
  voiceCount?: number,
  /**
   * Grok only: mode, model and whether the request is reference-to-video.
   * Edit and Extend have no resolution parameter — the clip follows its source,
   * capped at 720p — so they answer an empty list, as Kling does.
   */
  grok?: GrokVideoContext,
): readonly string[] {
  if (caps.kind === "grok") {
    if ((grok?.mode ?? "generate") !== "generate") return [];
    const spec = grokVideoModelSpec(caps, grok?.model);
    const referenceToVideo =
      grok?.referenceToVideo ??
      (referenceCount === undefined ||
        referenceCount > GROK_VIDEO_HD_MAX_REFERENCES ||
        (voiceCount ?? 0) > 0);
    // Lite never runs reference-to-video, so nothing takes its 1080p away.
    return spec.resolutions.filter(
      (resolution) =>
        resolution !== GROK_VIDEO_HD_RESOLUTION ||
        !spec.supportsReferenceToVideo ||
        !referenceToVideo,
    );
  }
  if (caps.kind === "seedance") return caps.resolutionsByTier[tier ?? caps.defaultTier];
  if (caps.kind === "higgsfield-video") {
    const video = higgsfieldVideoModel(caps, jobType);
    // Their rule: Seedance fast supports 480p and 720p only. Offering 1080p
    // there would fail at generation time rather than on the form.
    if (mode === "fast") {
      return video.resolutions.filter(
        (resolution) => resolution === "480p" || resolution === "720p",
      );
    }
    return video.resolutions;
  }
  // Exhaustive: every VideoCaps kind returned above. Kept as a compile-time
  // assertion so adding a fourth provider fails here rather than silently
  // offering it nothing.
  const exhaustive: never = caps;
  return exhaustive;
}

/** Lengths the selected model accepts, which differ between them. */
export function videoDurations(caps: VideoCaps, jobType?: string): readonly number[] {
  if (caps.kind === "higgsfield-video") return higgsfieldVideoModel(caps, jobType).durations;
  return caps.durations;
}

/** The selected Higgsfield video model, falling back to the default. */
export function higgsfieldVideoModel(
  caps: HiggsfieldVideoCaps,
  jobType: string | undefined,
): HiggsfieldVideoModel {
  return (
    caps.models.find((model) => model.jobType === jobType) ??
    caps.models.find((model) => model.jobType === caps.defaultJobType) ??
    caps.models[0]
  );
}

/** Models offered by a provider, in registry order — drives the two-row switcher. */
export function modelsForProvider(provider: Provider): ApiModel[] {
  return API_MODEL_IDS.map((id) => API_MODELS[id]).filter((model) => model.provider === provider);
}

/** 0 references → text, exactly 1 → first-frame animation, 2+ → reference guides. */
export function seedanceMode(referenceCount: number): "text" | "image" | "reference" {
  if (referenceCount === 0) return "text";
  return referenceCount === 1 ? "image" : "reference";
}

export function seedanceEndpoint(
  caps: SeedanceVideoCaps,
  tier: VideoTier,
  referenceCount: number,
): string {
  const endpoints = caps.endpointsByTier[tier];
  if (!endpoints) throw new Error(`Unknown Seedance tier: ${tier}`);
  return endpoints[seedanceMode(referenceCount)];
}

export function seedreamEndpoint(caps: SeedreamImageCaps, referenceCount: number): string {
  return referenceCount > 0 ? caps.editEndpoint : caps.textEndpoint;
}

/** Attachment cap for the model — the higher of its image and video limits, so
 *  switching media type never silently drops already-attached references.
 *  Grok 2.0's five edit sources count, though the caps' own figure is three. */
export function maxAttachableReferences(model: ApiModel): number {
  const image =
    model.image.kind === "grok"
      ? Math.max(
          model.image.maxReferences,
          ...Object.values(model.image.qualityOverrides).map((entry) => entry?.maxReferences ?? 0),
        )
      : model.image.maxReferences;
  return Math.max(image, model.video.maxReferences);
}
