import type { AtlasParamValue } from "./atlas-models";

export const TENCENT_UPSCALER = "tencent/image/upscaler";
type Params = Record<string, AtlasParamValue>;
export type ImageDimensions = { width: number; height: number };

/** Optional dimensions default to 1 in the generic form. They are unset,
 * not a request for a one-pixel image. Send only the active sizing method. */
export function tencentSizing(params: Params): Params {
  if (!params.mode || params.mode === "percent") {
    return { mode: "percent", percent: params.percent ?? 2 };
  }
  const dimensions = Object.fromEntries(
    ["width", "height", "long_side", "short_side"]
      .filter((key) => typeof params[key] === "number" && params[key] > 1)
      .map((key) => [key, params[key]]),
  );
  return { mode: params.mode, ...dimensions };
}

export function tencentOutputSize(
  params: Params,
  source?: ImageDimensions,
): ImageDimensions | null {
  if (!source || source.width <= 0 || source.height <= 0) return null;
  const sizing = tencentSizing(params);
  if (sizing.mode === "fixed") return null; // Legacy forced dimensions: never promise preservation.
  let scale: number;
  if (sizing.mode === "percent") scale = Number(sizing.percent);
  else {
    const { width, height, long_side, short_side } = sizing;
    const methods = Number(!!long_side) + Number(!!short_side) + Number(!!(width || height));
    if (methods !== 1) return null; // Do not guess vendor precedence for conflicting saved settings.
    if (long_side) scale = Number(long_side) / Math.max(source.width, source.height);
    else if (short_side) scale = Number(short_side) / Math.min(source.width, source.height);
    else
      scale = Math.min(
        width ? Number(width) / source.width : Infinity,
        height ? Number(height) / source.height : Infinity,
      );
  }
  if (!Number.isFinite(scale) || scale <= 0) return null;
  return { width: Math.round(source.width * scale), height: Math.round(source.height * scale) };
}

/** A preset replaces all competing dimensions, including settings restored from history. */
export function tencentLongEdge(pixels: number): Params {
  return { mode: "aspect", long_side: pixels, width: 1, height: 1, short_side: 1 };
}
