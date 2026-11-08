import { v } from "convex/values";

/**
 * Stored shape of packages/shared/h3-video.ts's H3VideoSettings. Kept field for
 * field in step with that type: the processor rebuilds the graph from this,
 * so a "Reproduce" months later runs exactly what the first click ran (seed
 * included — it is resolved before the row is written).
 */
export const h3SettingsValidator = v.object({
  mode: v.union(v.literal("text"), v.literal("frames"), v.literal("reference")),
  prompt: v.string(),
  checkpoint: v.string(),
  loras: v.array(v.object({ name: v.string(), strength: v.number() })),
  turbo: v.boolean(),
  width: v.number(),
  height: v.number(),
  durationSeconds: v.number(),
  steps: v.number(),
  sampler: v.string(),
  scheduler: v.string(),
  shiftEnabled: v.boolean(),
  shiftVideo: v.number(),
  shiftAudio: v.number(),
  fastAttention: v.boolean(),
  sparseAttention: v.union(v.literal("off"), v.literal("sol-attn"), v.literal("vsa")),
  sparseValue: v.number(),
  easyCache: v.boolean(),
  easyCacheThreshold: v.number(),
  seed: v.number(),
  audio: v.boolean(),
  referenceSize: v.union(v.literal("match"), v.literal("max")),
  // Community add-ons, 2026-10-12. Optional: rows written before them must
  // still validate, and normalizeH3Settings reads absent as off.
  interpolate: v.optional(v.boolean()),
  upscale: v.optional(v.boolean()),
});

/** What each entry of `referenceStorageIds` is, in the same order. */
export const h3InputRoleValidator = v.union(
  v.literal("first"),
  v.literal("last"),
  v.literal("reference"),
);

/**
 * Stored shape of packages/shared/comfy-run-stats.ts's ComfyRunStats: where a
 * self-hosted clip's time went and what it ran on, for the lightbox's details
 * panel. Filled in as the job reaches each point; nothing reads it back.
 */
export const comfyRunValidator = v.object({
  submittedAt: v.optional(v.number()),
  executionStartedAt: v.optional(v.number()),
  executionEndedAt: v.optional(v.number()),
  cachedNodes: v.optional(v.array(v.string())),
  nodes: v.optional(
    v.array(v.object({ id: v.string(), startedAt: v.number(), total: v.optional(v.number()) })),
  ),
  nodesEndedAt: v.optional(v.number()),
  clockOffset: v.optional(v.number()),
  gpuName: v.optional(v.string()),
  vramBytes: v.optional(v.number()),
  comfyuiVersion: v.optional(v.string()),
  pytorchVersion: v.optional(v.string()),
});

/** Stored shape of packages/shared/ltx-video.ts's LtxVideoSettings. */
export const ltxSettingsValidator = v.object({
  mode: v.union(v.literal("text"), v.literal("frames"), v.literal("sheet")),
  prompt: v.string(),
  negativePrompt: v.string(),
  checkpoint: v.string(),
  loras: v.array(v.object({ name: v.string(), strength: v.number() })),
  width: v.number(),
  height: v.number(),
  durationSeconds: v.number(),
  fps: v.union(v.literal(24), v.literal(30)),
  steps: v.number(),
  imageStrength: v.number(),
  imageCompression: v.number(),
  twoPass: v.boolean(),
  cfg: v.number(),
  seed: v.number(),
  audio: v.boolean(),
  sheetStrength: v.optional(v.number()),
});
