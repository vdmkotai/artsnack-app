/**
 * Request bodies for fal.
 *
 * Kept free of any Convex or Node dependency so the shapes can be asserted in
 * plain unit tests — which matters more than usual here, because fal rejects a
 * body containing a field the model doesn't declare. Sending `seed` to Lite or
 * `bitrate_mode` to Mini is a 422, not a harmless extra.
 */

import {
  getApiModel,
  imageDimensions,
  resolveImageRatio,
  seedanceEndpoint,
  seedanceMode,
  seedreamEndpoint,
  type ApiModelId,
  type VideoTier,
} from "./api-models";
import { toGrokApiPrompt, toSeedanceApiPrompt } from "./grok-prompt";

export type FalRequest = { endpoint: string; payload: Record<string, unknown> };

export type SeedreamRequestInput = {
  model: ApiModelId;
  prompt: string;
  aspectRatio: string;
  sizeTier: string;
  count: number;
  referenceUrls: readonly string[];
  /** width/height of the first reference, used to resolve an "auto" ratio. */
  referenceAspect?: number;
};

export function buildSeedreamRequest(input: SeedreamRequestInput): FalRequest {
  const caps = getApiModel(input.model).image;
  if (caps.kind !== "seedream") throw new Error(`${input.model} has no Seedream image endpoint`);

  const references = input.referenceUrls.slice(0, caps.maxReferences);
  const ratio = resolveImageRatio(input.aspectRatio, caps.aspectRatios, input.referenceAspect);

  const payload: Record<string, unknown> = {
    prompt: toGrokApiPrompt(input.prompt),
    num_images: Math.min(Math.max(1, input.count), Math.max(...caps.counts)),
    // Always explicit pixels. The auto_* presets would hand the output size —
    // and with it Pro's price bracket — to the model.
    image_size: imageDimensions(caps, input.sizeTier, ratio),
  };

  if (references.length > 0) payload.image_urls = references;
  if (caps.supportsOutputFormat) payload.output_format = "png";

  return { endpoint: seedreamEndpoint(caps, references.length), payload };
}

export type SeedanceRequestInput = {
  model: ApiModelId;
  prompt: string;
  aspectRatio: string;
  durationSeconds: number;
  resolution: string;
  tier: VideoTier;
  generateAudio: boolean;
  bitrateMode: "standard" | "high";
  referenceUrls: readonly string[];
};

export function buildSeedanceRequest(input: SeedanceRequestInput): FalRequest {
  const caps = getApiModel(input.model).video;
  if (caps.kind !== "seedance") throw new Error(`${input.model} has no Seedance video endpoint`);

  const references = input.referenceUrls.slice(0, caps.maxReferences);
  const mode = seedanceMode(references.length);
  const allowedResolutions = caps.resolutionsByTier[input.tier];
  if (!allowedResolutions?.includes(input.resolution)) {
    throw new Error(`${input.resolution} is not available on the ${input.tier} tier`);
  }

  const payload: Record<string, unknown> = {
    prompt: toSeedanceApiPrompt(input.prompt),
    resolution: input.resolution,
    // Seedance types duration as a string enum, not a number.
    duration: String(input.durationSeconds),
    generate_audio: input.generateAudio,
  };

  if (mode === "image") {
    payload.image_url = references[0];
    // A single frame defines the shape; asking for another would crop it.
    payload.aspect_ratio = "auto";
  } else {
    if (mode === "reference") payload.image_urls = references;
    payload.aspect_ratio = caps.aspectRatios.includes(input.aspectRatio)
      ? input.aspectRatio
      : "auto";
  }

  // Mini's schema omits bitrate_mode entirely.
  if (caps.bitrateModeByTier[input.tier] && input.bitrateMode === "high") {
    payload.bitrate_mode = "high";
  }

  return { endpoint: seedanceEndpoint(caps, input.tier, references.length), payload };
}
