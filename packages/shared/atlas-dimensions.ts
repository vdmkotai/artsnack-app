/**
 * Output size for the Atlas models that take it as free text.
 *
 * 24 of them spell it `1024*1024` in a plain string field, which the generic
 * renderer drew as exactly that: a text box with `1024*1024` in it, for the user
 * to edit character by character. Nobody wants to type an aspect ratio.
 *
 * So the shape is a small table of presets — the ratios people actually ask for,
 * at a resolution the model will accept — plus the text box, kept for the times
 * a specific number really is the point. This module holds the arithmetic; the
 * two clients hold the controls.
 */

import type { AtlasParam } from "./atlas-models";

/** The vendor's separator. Not an `x`, and not a `×`. */
const SEPARATOR = "*";

export type Dimensions = { width: number; height: number };

/**
 * Ratios offered as presets, in the order they are shown.
 *
 * Square first because it is the most common, then landscape and portrait in
 * pairs so the flipped version of whatever you want is always adjacent.
 */
export const ATLAS_RATIOS = [
  "1:1",
  "3:2",
  "2:3",
  "16:9",
  "9:16",
  "4:3",
  "3:4",
  "21:9",
  "16:10",
  "10:16",
] as const;

export type AtlasRatio = (typeof ATLAS_RATIOS)[number];

/**
 * Size tiers, by the length of the long side.
 *
 * Named rather than numbered because the actual pixels change with the ratio —
 * "1K" at 16:9 is 1360×768, and calling that "1360" would be true and useless.
 */
export const ATLAS_SIZE_TIERS = [
  { value: "1K", longSide: 1024 },
  { value: "1.5K", longSide: 1536 },
  { value: "2K", longSide: 2048 },
] as const;

export type AtlasSizeTier = (typeof ATLAS_SIZE_TIERS)[number]["value"];

/** Every dimension the vendors accept is a multiple of this. */
const STEP = 16;

function snap(value: number): number {
  return Math.max(STEP, Math.round(value / STEP) * STEP);
}

function ratioValue(ratio: AtlasRatio): number {
  const [w, h] = ratio.split(":").map(Number);
  return w / h;
}

export function formatDimensions(size: Dimensions): string {
  return `${size.width}${SEPARATOR}${size.height}`;
}

/** Reads `1024*1024`, and tolerates the `x` and `×` people type by hand. */
export function parseDimensions(value: unknown): Dimensions | null {
  if (typeof value !== "string") return null;
  const match = value.trim().match(/^(\d+)\s*[*x×]\s*(\d+)$/i);
  if (!match) return null;
  const width = Number(match[1]);
  const height = Number(match[2]);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null;
  return { width, height };
}

/**
 * The bounds a model states, with defaults for the ones that state nothing.
 *
 * Most of the 24 document no limits at all, and 512–2048 is the range their
 * examples and defaults live inside. The two MAI endpoints are the reason the
 * area cap exists: they take a minimum side of 768 and a product that must not
 * exceed 1,049,088, which no combination of "1K at 16:9" satisfies by accident.
 */
export function dimensionLimits(param: AtlasParam): {
  minSide: number;
  maxSide: number;
  maxPixels: number | null;
} {
  return {
    minSide: param.minSide ?? 512,
    maxSide: param.maxSide ?? 2048,
    maxPixels: param.maxPixels ?? null,
  };
}

/**
 * A ratio and a tier turned into pixels the model will accept.
 *
 * The area cap is applied by scaling both sides down together, so the ratio the
 * user picked survives — clamping each side independently would silently hand
 * them a different shape than the one they tapped.
 */
export function dimensionsFor(
  param: AtlasParam,
  ratio: AtlasRatio,
  tier: AtlasSizeTier,
): Dimensions {
  const limits = dimensionLimits(param);
  const longSide = ATLAS_SIZE_TIERS.find((entry) => entry.value === tier)?.longSide ?? 1024;
  const aspect = ratioValue(ratio);

  const wide = aspect >= 1;
  const stretch = wide ? aspect : 1 / aspect;
  const minimumLong = limits.minSide * stretch;
  const maximumLong = Math.min(
    limits.maxSide,
    limits.maxPixels === null ? Infinity : Math.sqrt(limits.maxPixels * stretch),
  );
  // Impossible ratios deliberately return an illegal size, filtered by presets.
  const targetLong = Math.max(minimumLong, Math.min(longSide, maximumLong));
  const long = Math.ceil(targetLong / STEP) * STEP;
  const short = Math.max(limits.minSide, snap(targetLong / stretch));
  const size = wide ? { width: long, height: short } : { width: short, height: long };
  if (minimumLong <= maximumLong * 1.025 && !isLegal(param, size)) {
    if (wide) size.width = Math.floor(maximumLong / STEP) * STEP;
    else size.height = Math.floor(maximumLong / STEP) * STEP;
  }
  if (minimumLong <= maximumLong * 1.025 && limits.maxPixels !== null) {
    while (size.width * size.height > limits.maxPixels) {
      if (size.width >= size.height && size.width - STEP >= limits.minSide) size.width -= STEP;
      else if (size.height - STEP >= limits.minSide) size.height -= STEP;
      else break;
    }
  }
  return size;
}

/** Whether a size satisfies everything the model asks of it. */
function isLegal(param: AtlasParam, size: Dimensions): boolean {
  const limits = dimensionLimits(param);
  if (size.width < limits.minSide || size.height < limits.minSide) return false;
  if (size.width > limits.maxSide || size.height > limits.maxSide) return false;
  if (limits.maxPixels !== null && size.width * size.height > limits.maxPixels) return false;
  return true;
}

/**
 * Every preset a model can actually produce.
 *
 * Filtered rather than clamped, because some ratios are genuinely impossible:
 * the two MAI endpoints demand a minimum side of 768 *and* cap the area at
 * 1,049,088, which 21:9 cannot satisfy at any scale — 768 tall forces 1792 wide
 * and 1.38 megapixels. Offering it anyway would either show a button that sends
 * a rejected value, or silently hand back a 16:9 image from a 21:9 button.
 */
export function dimensionPresets(
  param: AtlasParam,
  tier: AtlasSizeTier,
): { ratio: AtlasRatio; size: Dimensions; value: string }[] {
  const presets = [];
  for (const ratio of ATLAS_RATIOS) {
    const size = dimensionsFor(param, ratio, tier);
    if (!isLegal(param, size) || Math.abs(size.width / size.height / ratioValue(ratio) - 1) > 0.025)
      continue;
    presets.push({ ratio, size, value: formatDimensions(size) });
  }
  return presets;
}

/**
 * Which preset a stored value corresponds to, if any.
 *
 * Matched on the exact pixels rather than on the ratio, so a custom `1200*800`
 * does not light up the 3:2 preset that would have produced `1536*1024`.
 */
export function matchPreset(
  param: AtlasParam,
  value: unknown,
): { ratio: AtlasRatio; tier: AtlasSizeTier } | null {
  const parsed = parseDimensions(value);
  if (!parsed) return null;
  for (const tier of ATLAS_SIZE_TIERS) {
    for (const preset of dimensionPresets(param, tier.value)) {
      if (preset.size.width === parsed.width && preset.size.height === parsed.height) {
        return { ratio: preset.ratio, tier: tier.value };
      }
    }
  }
  return null;
}

/**
 * Forces a hand-typed size into what the model accepts.
 *
 * Returns null for a value that is not a size at all, which is the caller's cue
 * to leave the field alone while it is being typed into.
 */
export function clampDimensions(param: AtlasParam, value: unknown): Dimensions | null {
  const parsed = parseDimensions(value);
  if (!parsed) return null;
  const limits = dimensionLimits(param);

  let width = Math.min(limits.maxSide, Math.max(limits.minSide, snap(parsed.width)));
  let height = Math.min(limits.maxSide, Math.max(limits.minSide, snap(parsed.height)));

  if (limits.maxPixels !== null && width * height > limits.maxPixels) {
    const scale = Math.sqrt(limits.maxPixels / (width * height));
    width = Math.max(limits.minSide, snap(width * scale));
    height = Math.max(limits.minSide, snap(height * scale));
  }
  while (limits.maxPixels !== null && width * height > limits.maxPixels) {
    if (width >= height && width - STEP >= limits.minSide) width -= STEP;
    else if (height - STEP >= limits.minSide) height -= STEP;
    else break;
  }
  return { width, height };
}

/** What one of a model's size words does, for the readout beside the picker. */
export function specialSizeNote(word: string): string {
  if (word === "default") return "the model's own default size";
  if (word === "auto") return "the model picks the shape from the prompt";
  return word;
}

/** The size a fresh form starts on: the vendor's default when it parses. */
export function defaultDimensionValue(param: AtlasParam): string {
  // MAI-Image-2.6 defaults to the word `default`, its own native size.
  if (typeof param.default === "string" && param.specialValues?.includes(param.default)) {
    return param.default;
  }
  const fromSchema = parseDimensions(param.default);
  if (fromSchema) return formatDimensions(fromSchema);
  // The two Qwen edit endpoints document an empty value as "keep the source
  // resolution", which is a better default for an edit than any number.
  if (param.allowAuto) return "";
  return formatDimensions(dimensionsFor(param, "1:1", "1K"));
}
