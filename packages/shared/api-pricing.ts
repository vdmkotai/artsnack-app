/**
 * Cost of a generation, in USD.
 *
 * The contract here is deliberately total: every function returns a `number`,
 * never `number | null`. The UI shows a price at every stage — on the button,
 * on the queued tile, on the finished result — so "we couldn't work it out"
 * is not a state the interface can render. A combination we can't price is a
 * gap in the registry, and it throws during validation, before a record is
 * ever created.
 */

import {
  getApiModel,
  PRO_CHEAP_TIER_MAX_PIXELS,
  type ApiModelId,
  type Dimensions,
  type VideoTier,
} from "./api-models";

/** Flat per-image price for the models that have one. */
const IMAGE_PRICE_USD: Record<string, number> = {
  "seedream-4.5": 0.04,
  "seedream-5-lite": 0.035,
};

/** Pro is priced by output size: the 1536² boundary doubles the cost. */
const PRO_PRICE_USD = { cheap: 0.0675, expensive: 0.135 } as const;

/** Pro only: every input image beyond the first, charged per output image. */
const PRO_EXTRA_INPUT_USD = 0.0045;

/**
 * Seedance $/second.
 *
 * Published by fal: Standard 720p / 1080p / 4k, Fast 720p, and both Mini rows.
 *
 * Derived, and marked "≈" in the UI: Standard 480p comes from fal's own token
 * formula (`width × height × seconds × 24 / 1024` tokens at $0.014 per 1000 for
 * 480p–1080p) assuming an 854×480 output; Fast 480p applies Fast's 0.8× ratio
 * to that. Mini's published pair does not follow either derivation, which is
 * one more reason to treat the two derived numbers as provisional.
 *
 * TODO: replace both with measured values once a real 480p job has been billed.
 */
const SEEDANCE_RATE_USD_PER_SECOND: Record<VideoTier, Record<string, number>> = {
  mini: { "480p": 0.0721, "720p": 0.1547 },
  fast: { "480p": 0.1076, "720p": 0.2419 },
  standard: { "480p": 0.1345, "720p": 0.3024, "1080p": 0.6804, "4k": 1.5552 },
};

export type ImageCostInput = {
  model: ApiModelId;
  /** Size tier value from the model's descriptor ("2K", "1K", …). */
  sizeTier: string;
  count: number;
  referenceCount: number;
};

export type VideoCostInput = {
  model: ApiModelId;
  tier?: VideoTier;
  resolution: string;
  durationSeconds: number;
};

/** Price of one Pro output at a given pixel count. */
function proPricePerImage(pixels: number): number {
  return pixels <= PRO_CHEAP_TIER_MAX_PIXELS ? PRO_PRICE_USD.cheap : PRO_PRICE_USD.expensive;
}

function proPixelsForTier(model: ApiModelId, sizeTier: string): number {
  const caps = getApiModel(model).image;
  if (caps.kind !== "seedream") throw new Error(`${model} is not a Seedream model`);
  const table = caps.ratioPixels[sizeTier];
  if (!table) throw new Error(`Unknown size tier "${sizeTier}" for ${model}`);
  // Every ratio in a Pro tier sits on the same side of the price boundary, so
  // any entry answers the question. 1:1 is guaranteed present.
  const dimensions = table["1:1"];
  return dimensions.width * dimensions.height;
}

/** Cost before the request, from the settings the user picked. */
export function imageCostUsd({ model, sizeTier, count, referenceCount }: ImageCostInput): number {
  // Only fal bills in dollars. Grok runs on a subscription and Higgsfield on
  // plan credits — both are priced elsewhere, so there is nothing to charge here.
  if (getApiModel(model).provider !== "fal") return 0;

  const outputs = Math.max(1, count);
  if (model === "seedream-5-pro") {
    const perImage =
      proPricePerImage(proPixelsForTier(model, sizeTier)) +
      PRO_EXTRA_INPUT_USD * Math.max(0, referenceCount - 1);
    return round(perImage * outputs);
  }

  const perImage = IMAGE_PRICE_USD[model];
  if (perImage === undefined) throw new Error(`No image price registered for ${model}`);
  return round(perImage * outputs);
}

/** Cost after the request, from the sizes fal actually returned. */
export function imageCostFromDimensions(
  model: ApiModelId,
  images: readonly Dimensions[],
  referenceCount: number,
): number {
  // Same guard as imageCostUsd, and it has to be the same one: the Higgsfield
  // Seedream models have no entry in IMAGE_PRICE_USD (they bill in credits), so
  // testing only for "grok" here let them fall through to a lookup that throws.
  if (getApiModel(model).provider !== "fal") return 0;
  if (images.length === 0) return 0;

  if (model === "seedream-5-pro") {
    const surcharge = PRO_EXTRA_INPUT_USD * Math.max(0, referenceCount - 1);
    return round(
      images.reduce(
        (total, size) => total + proPricePerImage(size.width * size.height) + surcharge,
        0,
      ),
    );
  }

  const perImage = IMAGE_PRICE_USD[model];
  if (perImage === undefined) throw new Error(`No image price registered for ${model}`);
  return round(perImage * images.length);
}

export function videoCostUsd({ model, tier, resolution, durationSeconds }: VideoCostInput): number {
  const caps = getApiModel(model).video;
  // Seedance-on-fal is the only video path billed in dollars.
  if (caps.kind !== "seedance") return 0;

  const effectiveTier = tier ?? caps.defaultTier;
  const rates = SEEDANCE_RATE_USD_PER_SECOND[effectiveTier];
  if (!rates) throw new Error(`No video rates registered for tier ${effectiveTier}`);
  const rate = rates[resolution];
  if (rate === undefined) {
    throw new Error(`No video rate for ${resolution} on the ${effectiveTier} tier`);
  }
  return round(rate * Math.max(0, durationSeconds));
}

/** Rounded to cents-and-a-bit; sub-cent prices ($0.035) must survive. */
function round(value: number): number {
  return Math.round(value * 10000) / 10000;
}

/**
 * What a generation costs, in whatever unit the provider bills in.
 *
 * fal charges dollars, Higgsfield spends plan credits, and Grok is covered by a
 * subscription. Collapsing those into one number would have meant inventing an
 * exchange rate, so the unit travels with the amount.
 */
export type Price =
  | { currency: "usd"; amount: number }
  | { currency: "credits"; amount: number }
  /**
   * Covered by the SuperGrok subscription. `meteredUsd` is the quota the job
   * uses at xAI's API rates — an estimate from the rate card unless `measured`,
   * when it is the figure xAI reported for the finished job. Absent on a price
   * that predates the rate card, which still reads "Included in SuperGrok".
   */
  | { currency: "included"; meteredUsd?: number; measured?: boolean }
  /**
   * The settings genuinely do not determine a price yet.
   *
   * Distinct from `null`, which means "a quote is on its way" — this one is a
   * final answer. Atlas has models whose length comes from a source clip and
   * models that pick their own duration, and inventing a figure for either
   * would be worse than saying so.
   */
  | { currency: "unknown"; reason: string };

export function usdPrice(amount: number): Price {
  return { currency: "usd", amount };
}

export function creditsPrice(amount: number): Price {
  return { currency: "credits", amount };
}

export const INCLUDED_PRICE: Price = { currency: "included" };

/** A SuperGrok price carrying the quota the job meters. */
export function includedPrice(meteredUsd: number, measured = false): Price {
  return measured
    ? { currency: "included", meteredUsd, measured }
    : { currency: "included", meteredUsd };
}

/**
 * The metered figure on its own — "≈$0.48", or "$0.48" once measured — for a
 * price beside an option, where "quota" would crowd the button. Null for a
 * price with no metered figure.
 */
export function formatMetered(price: Price | null): string | null {
  if (!price || price.currency !== "included" || price.meteredUsd === undefined) return null;
  return `${price.measured ? "" : "≈"}${formatUsd(price.meteredUsd)}`;
}

/**
 * Renderable in every state.
 *
 * `null` means a Higgsfield quote is still in flight: those come from the
 * vendor's own `generate cost` rather than a table we made up, so there is a
 * brief moment before the real figure lands. Showing a placeholder beats
 * showing a number we invented.
 */
export function formatPrice(price: Price | null): string {
  if (!price) return "…";
  switch (price.currency) {
    case "included":
      return price.meteredUsd === undefined
        ? "Included in SuperGrok"
        : `${formatMetered(price)} quota`;
    case "credits":
      return `${formatCredits(price.amount)} credits`;
    case "usd":
      return formatUsd(price.amount);
    case "unknown":
      return "price unknown";
  }
}

/**
 * Credits, keeping the half.
 *
 * Half-credit rates are everywhere in Higgsfield's card — 7.5, 12.5, 22.5 —
 * so rounding each tile to a whole number made four clips of 7.5 read as 32
 * next to a button that correctly said 30.
 */
export function formatCredits(amount: number): string {
  return Number.isInteger(amount) ? String(amount) : amount.toFixed(1);
}

/**
 * Display form. Always returns something renderable — the interface never has
 * an empty spot where a price should be.
 */
export function formatUsd(value: number): string {
  if (value <= 0) return "$0";
  if (value < 0.01) return `$${value.toFixed(4).replace(/0+$/, "").replace(/\.$/, "")}`;
  if (value < 1) return `$${value.toFixed(3).replace(/0$/, "")}`;
  return `$${value.toFixed(2)}`;
}
