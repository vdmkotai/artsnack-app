/**
 * Pre-flight cost for an Atlas Cloud generation.
 *
 * Atlas publishes one number per model, `base_price`, and its unit depends on
 * the media: dollars per second of video, dollars per image. That is enough to
 * price most of the catalogue exactly, and this module is careful to say so
 * when it is not, rather than showing a confident wrong figure.
 *
 * Three cases genuinely cannot be priced ahead of the click, and all three
 * return null with a reason instead of guessing:
 *
 *   - 33 video models take no `duration` at all (upscalers, face swaps, video
 *     edits). Their length comes from the input clip, which nobody has measured
 *     at the time the button is drawn.
 *   - 9 models accept `duration: -1`, meaning "let the model decide". The same
 *     reason the fal registry refuses to expose Seedance's "auto".
 *   - One model publishes no base price.
 */

import {
  atlasBatchSplit,
  atlasBatchValue,
  atlasParam,
  getAtlasModel,
  isAtlasModelId,
  type AtlasModel,
  type AtlasParamValue,
} from "./atlas-models";

/** Exact output counts. Seedream's max_images is only a cap and is excluded. */
const COUNT_PARAMS = ["num_images", "n", "count"] as const;

/**
 * Studio's five video schemas publish these per-second rates in resolution's
 * description and explicitly multiply the price by count. Their catalogue
 * base_price badges disagree with those rates, so use the documented tiers.
 * Source: https://static.atlascloud.ai/model/schema/atlascloud-studio-food-motion.json
 * The same rates appear on virtual-try-on, ugc-ad, trend-remix and tvc-maker.
 */
const STUDIO_VIDEO_MODELS = new Set([
  "atlascloud/studio/food-motion",
  "atlascloud/studio/virtual-try-on",
  "atlascloud/studio/ugc-ad",
  "atlascloud/studio/trend-remix",
  "atlascloud/studio/tvc-maker",
]);
const STUDIO_VIDEO_RATES: Record<string, number> = {
  "480p": 0.1409,
  "720p": 0.303,
  "720p-esr": 0.2536,
  "1080p": 0.5963,
  "1080p-esr": 0.4544,
  "1440p-esr": 1.7246,
  "4k-esr": 3.8582,
};

/**
 * The shortest length Atlas will bill for.
 *
 * Their billing docs give per-second video as `Rate × max(5, Duration)`. 93 of
 * the 155 shipped video models accept something under five seconds, so without
 * the floor a 2-second clip was quoted at 40% of what it actually costs — and
 * that number is what lands in `costUsd` and is summed as account spend.
 */
export const ATLAS_MIN_BILLED_SECONDS = 5;

/*
 * Resolution scales the estimate where real charges or published tier rates
 * prove that Atlas's `base_price` is only the cheapest tier.
 *
 * This was "deliberately not priced" until real charges said otherwise. Settled
 * predictions carry a `price` field, and for Seedance 2.x it tracks the token
 * formula — pixels × frames — not the flat per-second badge: a 30s 720p
 * Seedance 2.5 clip quoted at $4.02 (0.134 × 30) actually charged $9.026,
 * which is the quote times 1280×720 / 854×480 to within 0.2%. A 15s 720p 2.0
 * clip: quoted $1.68, charged $3.64 — same pixel ratio. So `base_price` is the
 * 480p rate, and higher tiers cost their pixel multiple of it. The v1-pro
 * per-resolution model ids corroborate: their published rates (0.022 / 0.047 /
 * 0.11 per second for 480p/720p/1080p) sit in almost exactly pixel proportion.
 *
 * The scaling is scoped to seedance-2.x, where the charges above prove it.
 * Other models keep the flat estimate — inventing multipliers for models whose
 * billing basis is unknown is how the last table here went wrong — and every
 * completed row now records the vendor-reported price over the estimate, so a
 * model that underquotes will show itself in the history rather than compound.
 *
 * "-SR" tiers are priced at their numeric resolution. If Atlas bills the
 * pre-upscale render instead, the estimate errs high and the recorded price
 * corrects it.
 */
const SEEDANCE_SCALED_MODELS = /^bytedance\/seedance-2/;
const SEEDANCE_BASE_PIXELS = 854 * 480;
const SEEDANCE_TIER_PIXELS: Record<string, number> = {
  "480p": 854 * 480,
  "720p": 1280 * 720,
  "1080p": 1920 * 1080,
  "1440p": 2560 * 1440,
  "4k": 3840 * 2160,
};

/**
 * Wan 3.0's catalogue badge is a "from" price, despite `base_price` looking
 * like one flat per-second rate in the models API.
 *
 * Atlas's own pricing article gives Standard's 480P/720P/1080P tiers as
 * $0.05/$0.10/$0.20 before the current 20% discount. Prime's production
 * transactions are the stronger signal: a 30-second 1080P reference clip was
 * charged $7.56, and two active 15-second clips reserved $3.78 each. That is
 * exactly $0.252/s, not the $0.061/s floor the catalogue returned.
 *
 * Prime's lower tiers follow the same published tier structure and current
 * 10% discount. Keep the explicit numbers here: multiplying the rounded
 * $0.061 catalogue floor by four would still underquote 1080P ($0.244 vs
 * $0.252).
 */
const WAN_3_RATES: Record<"standard" | "prime", Record<string, number>> = {
  standard: { "480p": 0.04, "720p": 0.08, "1080p": 0.16 },
  prime: { "480p": 0.061, "720p": 0.126, "1080p": 0.252 },
};

/**
 * FLUX 3 video's per-second rates by resolution, from each endpoint's own
 * documentation ("Billed per second of generated video, by resolution").
 *
 * The catalogue's base_price sits about 9% under the documented 720p row
 * ($0.17 vs $0.187, $0.41 vs $0.451) and says nothing of 1080p, which costs
 * 1.3–1.7x more. The documented table is used; if the badge is the true 720p
 * rate the estimate errs high, and the recorded vendor price corrects it.
 * Sources: https://static.atlascloud.ai/model/readme/black-forest-labs-flux-3-*.md
 */
const FLUX_3_GENERATE_RATES = { "720p": 0.187, "1080p": 0.319 };
const FLUX_3_VIDEO_RATES: Record<string, Record<string, number>> = {
  "black-forest-labs/flux-3/text-to-video": FLUX_3_GENERATE_RATES,
  "black-forest-labs/flux-3/image-to-video": FLUX_3_GENERATE_RATES,
  "black-forest-labs/flux-3/first-last-frame-to-video": FLUX_3_GENERATE_RATES,
  "black-forest-labs/flux-3/extend-video": { "720p": 0.451, "1080p": 0.583 },
};

/**
 * MiniMax H3's badge fell from $0.08/s to $0.038/s on 2026-09-25, in the same
 * sync that added a 480P tier below its 768P and 2K ones — Atlas's page now
 * reads "Starting from $0.038". Each figure was the catalogue floor while its
 * tier was the cheapest one offered, so 480P and 768P are known. 2K (the
 * default) and the ESR tiers are published nowhere, and quoting them at the
 * 480P floor would show the default clip at under half its old price, so they
 * are withheld rather than guessed.
 */
const MINIMAX_H3_RATES: Record<string, number> = { "480p": 0.038, "768p": 0.08 };

/**
 * List rates by resolution tier that a model's own documentation publishes,
 * where `base_price` is only the cheapest tier.
 *
 * The catalogue badge equals the cheapest row of each table, so a tier costs
 * `base_price` times its multiple of that row — which keeps whatever discount
 * Atlas runs (Nano Banana 2.1 at 80%, its Developer edition and Grok's at 35%).
 * Add-ons from the same documents are scaled by the same discount.
 *
 * - Nano Banana 2.1: "`2k` costs $0.075, `4k` costs $0.14, and `1k` (the
 *   default) costs $0.05", plus $0.00168 per input image, $0.20 for the source
 *   clip on reference-to-image, and $0.014 per enabled search grounding.
 *   https://static.atlascloud.ai/model/readme/google-nano-banana-2.1-*.md
 * - MiniMax H3 Max reference-to-video: $0.05/s at 480P and $0.08/s at 768P,
 *   the first 2 reference images free and $0.074 for each one after, and
 *   reference video billed per input second — which nobody has measured when
 *   the button is drawn, so a quote with a video reference is withheld.
 *   https://static.atlascloud.ai/model/readme/minimax-h3-max-reference-to-video.md
 * - Grok Imagine Video 1.5 and 1.5 Lite: xAI's own per-second table
 *   (https://docs.x.ai/docs/models): 1.5 at $0.08/$0.14/$0.25, Lite at
 *   $0.02/$0.03/$0.14 for 480p/720p/1080p. Atlas lists exactly the 480p
 *   figure, and its schema says "Billed per second at the selected tier".
 */
type ListRateTable = {
  pattern: RegExp;
  rates: Record<string, number>;
  /** List-price add-ons for one request, before the discount. */
  /** Returns a reason instead when an add-on cannot be known before the run. */
  extras?: (
    params: Record<string, AtlasParamValue>,
    referenceCount: number,
    model: AtlasModel,
  ) => number | { reason: string };
};

const NANO_BANANA_2_1_EXTRAS: ListRateTable["extras"] = (params, referenceCount, model) =>
  (params.enable_web_search === true ? 0.014 : 0) +
  (params.enable_image_search === true ? 0.014 : 0) +
  referenceCount * 0.00168 +
  (atlasParam(model, "video_clips") ? 0.2 : 0);

const LIST_RATE_TABLES: readonly ListRateTable[] = [
  {
    pattern: /^google\/nano-banana-2\.1(?:-developer)?\//,
    rates: { "1k": 0.05, "2k": 0.075, "4k": 0.14 },
    extras: NANO_BANANA_2_1_EXTRAS,
  },
  {
    pattern: /^minimax\/h3-max\/reference-to-video$/,
    rates: { "480p": 0.05, "768p": 0.08 },
    extras: (params, referenceCount) => {
      const videos = params.refers_video_urls;
      if (Array.isArray(videos) && videos.length > 0) {
        return {
          reason:
            "Reference video is billed per second of input, which is not known before the run",
        };
      }
      return Math.max(0, referenceCount - 2) * 0.074;
    },
  },
  {
    pattern: /^xai\/grok-imagine-video-v1\.5-lite(?:-developer)?\//,
    rates: { "480p": 0.02, "720p": 0.03, "1080p": 0.14 },
  },
  {
    pattern: /^xai\/grok-imagine-video-v1\.5(?:-developer)?\//,
    rates: { "480p": 0.08, "720p": 0.14, "1080p": 0.25 },
  },
];

/**
 * The selected tier's multiple of the cheapest one and the discounted add-ons,
 * for a model with a published table; a reason when the table cannot price the
 * settings, null for a model without one.
 */
function listRateQuote(
  model: AtlasModel,
  params: Record<string, AtlasParamValue>,
  referenceCount: number,
): { factor: number; extras: number } | { reason: string } | null {
  const table = LIST_RATE_TABLES.find((entry) => entry.pattern.test(model.id));
  if (!table || model.basePrice === null) return null;
  const resolution = atlasParam(model, "resolution");
  const tier = String(params.resolution ?? resolution?.default ?? "").toLowerCase();
  const rate = table.rates[tier];
  if (rate === undefined) {
    return {
      reason: `Atlas does not publish a confirmed price for this ${model.label} resolution tier`,
    };
  }
  const floor = Math.min(...Object.values(table.rates));
  const extras = table.extras?.(params, referenceCount, model) ?? 0;
  if (typeof extras !== "number") return extras;
  return { factor: rate / floor, extras: extras * (model.basePrice / floor) };
}

/** A documented per-second rate for the selected resolution, "unknown" for a
 *  tier the documentation leaves out, null for a model without a table. */
function resolutionRate(
  model: AtlasModel,
  params: Record<string, AtlasParamValue>,
): number | "unknown" | null {
  const wan = model.id.match(/^alibaba\/wan-3\.0(-prime)?\//);
  const table = wan
    ? WAN_3_RATES[wan[1] ? "prime" : "standard"]
    : /^minimax\/h3\/(?:text|image|reference)-to-video$/.test(model.id)
      ? MINIMAX_H3_RATES
      : FLUX_3_VIDEO_RATES[model.id];
  if (!table) return null;
  const resolution = atlasParam(model, "resolution");
  const value = String(params.resolution ?? resolution?.default ?? "").toLowerCase();
  return table[value] ?? "unknown";
}

/**
 * Image tiers the schema prices in its own descriptions.
 *
 * Grok Imagine Image 2.0 writes "Per-image price: low/1k $0.04, low/2k $0.06,
 * medium/1k $0.06, medium/2k $0.08" into `quality`, and Grok Imagine Image
 * Quality writes "1k = 1024x1024 ($0.05/image), 2k = 2048x2048 ($0.07/image)"
 * into `resolution`. `base_price` is the cheapest row, so the default
 * medium/1k was quoted at two thirds of its price and a 2k Quality image at
 * $0.05 when production charged $0.07. The table gives each tier's multiple of
 * the cheapest; scaling `base_price` by it keeps any promotional discount
 * (the Developer editions run at 35% of these list figures).
 */
function publishedTierFactor(model: AtlasModel, params: Record<string, AtlasParamValue>): number {
  const resolution = atlasParam(model, "resolution");
  if (!resolution) return 1;
  const quality = atlasParam(model, "quality");
  const read = (param: typeof resolution) =>
    String(params[param.name] ?? param.default ?? "").toLowerCase();

  const rates = new Map<string, number>();
  const text = `${quality?.description ?? ""} ${resolution.description ?? ""}`;
  for (const match of text.matchAll(/\b([a-z]+)\/(\d+k)\s+\$(\d+(?:\.\d+)?)/gi)) {
    rates.set(`${match[1]}/${match[2]}`.toLowerCase(), Number(match[3]));
  }
  for (const match of text.matchAll(/\b(\d+k)\s*=\s*\d+x\d+\s*\(\$(\d+(?:\.\d+)?)\/image\)/gi)) {
    rates.set(match[1].toLowerCase(), Number(match[2]));
  }
  if (rates.size < 2) return 1;

  const key =
    quality && rates.has(`${read(quality)}/${read(resolution)}`)
      ? `${read(quality)}/${read(resolution)}`
      : read(resolution);
  const rate = rates.get(key);
  return rate === undefined ? 1 : rate / Math.min(...rates.values());
}

function seedanceResolutionFactor(
  model: AtlasModel,
  params: Record<string, AtlasParamValue>,
): number {
  if (!SEEDANCE_SCALED_MODELS.test(model.id)) return 1;
  const param = atlasParam(model, "resolution");
  if (!param) return 1;
  // "A draft is billed as a normal 480p render", whatever resolution says.
  if (params.draft === true) return 1;
  // The submit path clamps an absent scalar to its default, so the default is
  // what an untouched form actually renders — and pays for.
  const value = params[param.name] ?? param.default;
  const tier = String(value ?? "")
    .toLowerCase()
    .replace(/-(?:e?sr).*$/i, "");
  const pixels = SEEDANCE_TIER_PIXELS[tier];
  return pixels === undefined ? 1 : pixels / SEEDANCE_BASE_PIXELS;
}

/**
 * Midjourney's (formerly Youchuan's) native-2K toggle is the one image
 * parameter with a documented price effect: "Enable native 2K HD generation.
 * Costs 1.5x." Read from the schema's own words rather than from the model id,
 * so it applies to exactly the endpoints that say it and to nothing else.
 */
function hdFactor(model: AtlasModel, params: Record<string, AtlasParamValue>): number {
  const hd = atlasParam(model, "hd");
  if (!hd || hd.kind !== "boolean") return 1;
  const match = String(hd.description ?? "").match(/costs\s+(\d+(?:\.\d+)?)x/i);
  if (!match) return 1;
  const value = params.hd ?? hd.default;
  return value === true ? Number(match[1]) : 1;
}

export type AtlasQuote = {
  /** USD for one job, or null when the inputs do not determine it. */
  usd: number | null;
  /** Why it is null. Shown next to the button so "—" is never unexplained. */
  reason?: string;
};

function readNumber(value: AtlasParamValue | undefined): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  // Enum durations arrive as numbers, but a persisted form can hold the string.
  if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) {
    return Number(value);
  }
  return null;
}

/** Output count for one request, including Studio's image or video count. */
export function atlasImageCount(
  model: AtlasModel,
  params: Record<string, AtlasParamValue>,
): number {
  for (const name of COUNT_PARAMS) {
    const param = atlasParam(model, name);
    if (!param) continue;
    const value = readNumber(params[name] ?? param.default);
    if (value !== null && value > 0) return Math.round(value);
  }
  return 1;
}

/**
 * Cost of a single job at the given settings.
 *
 * `jobs` is our own fan-out — the app turns "4 clips" into four independent
 * submissions, each billed in full — so it multiplies the per-job figure rather
 * than feeding any vendor parameter.
 */
export function quoteAtlas(options: {
  model: string;
  params: Record<string, AtlasParamValue>;
  jobs?: number;
  /** Attached reference images, where a model bills per input image. */
  referenceCount?: number;
}): AtlasQuote {
  const model = getAtlasModel(options.model);
  const jobs = Math.max(1, Math.round(options.jobs ?? 1));
  const referenceCount = Math.max(0, Math.round(options.referenceCount ?? 0));

  if (model.basePrice === null) {
    return { usd: null, reason: "Atlas publishes no price for this model" };
  }
  if (UNPRICED_MODELS.has(model.id)) {
    return { usd: null, reason: UNPRICED_MODELS.get(model.id)! };
  }

  const listed = listRateQuote(model, options.params, referenceCount);
  if (listed && "reason" in listed) return { usd: null, reason: listed.reason };

  if (model.media === "image") {
    const count = atlasImageCount(model, options.params);
    return {
      usd:
        (model.basePrice *
          count *
          hdFactor(model, options.params) *
          publishedTierFactor(model, options.params) *
          (listed?.factor ?? 1) +
          (listed?.extras ?? 0)) *
        jobs,
    };
  }

  const duration = atlasParam(model, "duration");
  if (!duration) {
    return { usd: null, reason: lengthUnknownReason(model) };
  }

  const seconds = readNumber(options.params[duration.name]);
  if (seconds === null || seconds <= 0) {
    // -1 is Atlas's "you decide", and the price rides on whatever it picks.
    return { usd: null, reason: "Length is set to auto, so the cost is not known before the run" };
  }

  // The five-second floor is documented for per-second video: `max(5, Duration)`.
  const billed = Math.max(ATLAS_MIN_BILLED_SECONDS, seconds);
  if (STUDIO_VIDEO_MODELS.has(model.id)) {
    const resolution = String(
      options.params.resolution ?? atlasParam(model, "resolution")?.default ?? "",
    ).toLowerCase();
    const rate = STUDIO_VIDEO_RATES[resolution];
    if (rate === undefined) {
      return {
        usd: null,
        reason: "Atlas does not publish a confirmed price for this Studio resolution tier",
      };
    }
    return { usd: rate * billed * atlasImageCount(model, options.params) * jobs };
  }
  const tierRate = resolutionRate(model, options.params);
  if (tierRate === "unknown") {
    return {
      usd: null,
      reason: `Atlas does not publish a confirmed price for this ${model.label} resolution tier`,
    };
  }
  return {
    usd:
      ((tierRate ?? model.basePrice) *
        billed *
        seedanceResolutionFactor(model, options.params) *
        (listed?.factor ?? 1) +
        (listed?.extras ?? 0)) *
      jobs,
  };
}

/**
 * Models whose price cannot be stated from the catalogue at all.
 *
 * Studio's Template Video Clone lists $3.14 with no unit and no tier table,
 * where its five Studio siblings document per-second rates of $0.14–$3.86 by
 * resolution. Neither reading of the badge is safe to show as a cost.
 */
const UNPRICED_MODELS = new Map<string, string>([
  [
    "atlascloud/studio/video-clone",
    "Atlas publishes no per-second rate for Template Video Clone; the charge is recorded after the run",
  ],
]);

/** Why a video model with no `duration` cannot be priced ahead of the run. */
function lengthUnknownReason(model: AtlasModel): string {
  if (atlasParam(model, "draft_id")) {
    return "Length comes from the draft, so the cost is not known yet";
  }
  if (model.params.some((param) => param.role === "audio" && param.required)) {
    return "Length follows the driving audio, so the cost is not known yet";
  }
  return "Length comes from the source clip, so the cost is not known yet";
}

/** Whether a quote can be shown as a number at all. */
export function hasAtlasPrice(quote: AtlasQuote): quote is AtlasQuote & { usd: number } {
  return quote.usd !== null;
}

/** Re-evaluates a stored pre-flight estimate without touching settled prices. */
export function atlasCostForDisplay(options: {
  model?: string;
  params?: Record<string, AtlasParamValue>;
  costUsd?: number;
  costEstimated?: boolean;
}): number | undefined {
  if (!options.costEstimated || !options.model || !isAtlasModelId(options.model)) {
    return options.costUsd;
  }
  return quoteAtlas({ model: options.model, params: options.params ?? {} }).usd ?? undefined;
}

/**
 * Whether the resolution choice moves the price — so the form says that an
 * estimate for a tier with no published rate is only a floor. Every video
 * resolution does; an image one does where its schema says so ("Price is set
 * by this tier" on FLUX 3).
 */
export function atlasResolutionSetsPrice(model: AtlasModel): boolean {
  const resolution = atlasParam(model, "resolution");
  if (!resolution) return false;
  return (
    model.media === "video" ||
    /\b(?:price|priced|bill(?:ed|s)?|cost)/i.test(resolution.description ?? "")
  );
}

/**
 * What `images` images cost on an Atlas image model, split the way the form
 * sends them: equal requests of the model's own batch size where it has one
 * (atlasBatchSplit), one request per image where it does not. For the count
 * buttons, which price a total the form is not set to yet.
 */
export function quoteAtlasImages(options: {
  model: string;
  params: Record<string, AtlasParamValue>;
  images: number;
  referenceCount?: number;
}): AtlasQuote {
  const split = atlasBatchSplit(getAtlasModel(options.model), options.images);
  if (!split) {
    return quoteAtlas({ ...options, jobs: Math.max(1, Math.round(options.images)) });
  }
  return quoteAtlas({
    ...options,
    params: {
      ...options.params,
      [split.param.name]: atlasBatchValue(split.param, split.perRequest),
    },
    jobs: split.requests,
  });
}
