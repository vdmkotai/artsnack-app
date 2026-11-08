import { v } from "convex/values";

/**
 * The shapes of a Prompt Studio session, shared by the schema and the
 * functions. They mirror the types in packages/shared/prompt-studio.ts.
 */

export const studioVariantValidator = v.object({
  label: v.string(),
  title: v.string(),
  summary: v.string(),
  prompt: v.string(),
  changes: v.optional(v.string()),
  parentLabel: v.optional(v.string()),
});

export const studioUserMessageValidator = v.object({
  role: v.literal("user"),
  text: v.string(),
  replyTo: v.optional(v.string()),
  imageCount: v.optional(v.number()),
  at: v.number(),
});

export const studioAssistantMessageValidator = v.object({
  role: v.literal("assistant"),
  variants: v.array(studioVariantValidator),
  model: v.string(),
  provider: v.union(v.literal("grok"), v.literal("atlas")),
  fellBack: v.boolean(),
  reason: v.optional(v.string()),
  costUsd: v.optional(v.number()),
  durationMs: v.number(),
  at: v.number(),
});

export const studioMessageValidator = v.union(
  studioUserMessageValidator,
  studioAssistantMessageValidator,
);

/** A variant as the model returned it, before the session labels it. */
export const parsedStudioVariantValidator = v.object({
  title: v.string(),
  summary: v.string(),
  prompt: v.string(),
  changes: v.optional(v.string()),
  basedOn: v.optional(v.string()),
});

export const studioContextValidator = v.object({
  media: v.union(v.literal("image"), v.literal("video")),
  targetModel: v.optional(v.string()),
  duration: v.optional(v.number()),
  aspectRatio: v.optional(v.string()),
  referenceCount: v.optional(v.number()),
  frameInputs: v.optional(v.union(v.literal("first"), v.literal("last"), v.literal("both"))),
  tagsInPrompt: v.optional(v.boolean()),
  frameSlots: v.optional(v.array(v.string())),
  referenceRoles: v.optional(v.array(v.string())),
});
