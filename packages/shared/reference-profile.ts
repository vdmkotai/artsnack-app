/**
 * How each provider wants a reference image, and nothing about how to make one.
 *
 * xAI's Imagine edit and video endpoints reject references over ~400KB or
 * outside 256–768px (limits read from grok-build's image_edit tool). fal has no
 * such ceiling — Seedream edits at multi-megapixel resolution and Seedance takes
 * up to 30MB per frame — so squeezing an image into Grok's box before sending it
 * to Seedream would throw away most of what makes the edit worth doing.
 *
 * The numbers live here, apart from the resizing, because the two clients resize
 * by different means: the browser has canvas, the phone has ImageManipulator.
 * The limits are the part that must not diverge.
 */

export type ReferenceProfile = "grok" | "fal" | "describe" | "studio";

export type ProfileLimits = {
  maxDimension: number;
  minDimension: number;
  maxBytes: number;
  /** Tried in order until the result fits `maxBytes`. */
  qualitySteps: number[];
};

export const REFERENCE_PROFILES: Record<ReferenceProfile, ProfileLimits> = {
  grok: {
    maxDimension: 768,
    minDimension: 256,
    maxBytes: 400 * 1024,
    qualitySteps: [0.8, 0.65, 0.5, 0.35],
  },
  fal: {
    maxDimension: 2048,
    minDimension: 256,
    // Well under fal's 30MB input ceiling while keeping request bodies sane.
    maxBytes: 4 * 1024 * 1024,
    qualitySteps: [0.92, 0.85, 0.75, 0.6],
  },
  /**
   * Image to prompt: sent to a vision model, not an image model. Grok's box
   * loses the fine detail a description is for (fabric, jewellery, small
   * text); fal's makes a request body several megabytes long for no gain in
   * what the model can read. No API minimum to meet either, and stretching
   * each edge up to one would squash a wide banner into the wrong proportions
   * before the model describes them.
   */
  describe: {
    maxDimension: 1536,
    minDimension: 1,
    maxBytes: 1536 * 1024,
    qualitySteps: [0.88, 0.8, 0.7, 0.55],
  },
  /** Four base64 images together must fit a Node action's 5 MiB arguments. */
  studio: {
    maxDimension: 1536,
    minDimension: 1,
    maxBytes: 768 * 1024,
    qualitySteps: [0.88, 0.8, 0.7, 0.55, 0.4, 0.3],
  },
};

/** Grok is the only provider with the tight box; everything else uses fal's. */
export function referenceProfileFor(provider: string): ReferenceProfile {
  return provider === "grok" ? "grok" : "fal";
}
