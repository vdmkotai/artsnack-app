import { REFERENCE_PROFILES, type ReferenceProfile } from "./reference-profile";

export function referenceDimensions(width: number, height: number, profile: ReferenceProfile) {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    throw new Error("The reference image has invalid dimensions.");
  }
  const { maxDimension, minDimension } = REFERENCE_PROFILES[profile];
  const down = Math.min(1, maxDimension / Math.max(width, height));
  let nextWidth = Math.max(1, Math.round(width * down));
  let nextHeight = Math.max(1, Math.round(height * down));
  const up = Math.max(1, minDimension / Math.min(nextWidth, nextHeight));
  nextWidth = Math.min(maxDimension, Math.round(nextWidth * up));
  nextHeight = Math.min(maxDimension, Math.round(nextHeight * up));
  return { width: nextWidth, height: nextHeight };
}
