import { v } from "convex/values";
import { query, mutation, internalMutation } from "./_generated/server";
import { allowedUserOrNull, requireAllowedUser } from "./authz";
import { internal } from "./_generated/api";
import { paginationOptsValidator } from "convex/server";
import { Id } from "./_generated/dataModel";
import { progressChanged } from "../../shared/comfyui-progress";

const loraSlotValidator = v.object({
  enabled: v.boolean(),
  loraName: v.string(),
  strengthModel: v.number(),
  strengthClip: v.number(),
});

const formStateValidator = v.object({
  prompt: v.string(),
  negativePrompt: v.string(),
  checkpoint: v.string(),
  width: v.number(),
  height: v.number(),
  seed: v.number(),
  steps: v.number(),
  cfg: v.number(),
  sampler: v.string(),
  scheduler: v.string(),
  denoise: v.number(),
  batchSize: v.number(),
  loras: v.array(loraSlotValidator),
});

export const list = query({
  args: {},
  handler: async (ctx) => {
    const identity = await allowedUserOrNull(ctx);
    if (!identity) {
      return [];
    }

    const generations = await ctx.db
      .query("generations")
      .withIndex("by_user_timestamp", (q) => q.eq("userId", identity.subject))
      .order("desc")
      .take(100);

    return generations;
  },
});

export const listPaginated = query({
  args: { paginationOpts: paginationOptsValidator },
  handler: async (ctx, args) => {
    const identity = await allowedUserOrNull(ctx);
    if (!identity) {
      return {
        page: [],
        isDone: true,
        continueCursor: "",
      };
    }

    return await ctx.db
      .query("generations")
      .withIndex("by_user_timestamp", (q) => q.eq("userId", identity.subject))
      .order("desc")
      .paginate(args.paginationOpts);
  },
});

export const getById = query({
  args: { id: v.id("generations") },
  handler: async (ctx, args) => {
    const identity = await allowedUserOrNull(ctx);
    if (!identity) {
      return null;
    }

    const generation = await ctx.db.get(args.id);
    if (!generation || generation.userId !== identity.subject) {
      return null;
    }

    return generation;
  },
});

export const save = mutation({
  args: {
    timestamp: v.number(),
    formState: formStateValidator,
    imageUrls: v.optional(v.array(v.string())),
    b2Keys: v.optional(v.array(v.string())),
  },
  handler: async (ctx, args) => {
    const identity = await requireAllowedUser(ctx);

    const generationId = await ctx.db.insert("generations", {
      userId: identity.subject,
      timestamp: args.timestamp,
      formState: args.formState,
      imageUrls: args.imageUrls ?? [],
      b2Keys: args.b2Keys,
      searchablePrompt: args.formState.prompt,
    });

    return generationId;
  },
});

export const remove = mutation({
  args: { id: v.id("generations") },
  handler: async (ctx, args) => {
    const identity = await requireAllowedUser(ctx);

    const generation = await ctx.db.get(args.id);
    if (!generation || generation.userId !== identity.subject) {
      throw new Error("Generation not found or not owned by user");
    }

    // Same cleanup removeImages does per key: a favorite outliving its
    // generation is the one thing that keeps a deleted image on screen, and the
    // Favorites page can no longer read anything about it.
    for (const b2Key of generation.b2Keys ?? []) {
      const favorite = await ctx.db
        .query("favorites")
        .withIndex("by_user_key", (q) => q.eq("userId", identity.subject).eq("b2Key", b2Key))
        .first();
      if (favorite) {
        await ctx.db.delete(favorite._id);
      }
    }

    await ctx.db.delete(args.id);
  },
});

export const removeImages = mutation({
  args: {
    images: v.array(v.object({ generationId: v.id("generations"), b2Key: v.string() })),
  },
  handler: async (ctx, args) => {
    const identity = await requireAllowedUser(ctx);

    const byGeneration = new Map<Id<"generations">, Set<string>>();
    for (const img of args.images) {
      const set = byGeneration.get(img.generationId) ?? new Set<string>();
      set.add(img.b2Key);
      byGeneration.set(img.generationId, set);
    }

    let removed = 0;
    for (const [generationId, requestedKeys] of byGeneration) {
      const generation = await ctx.db.get(generationId);
      if (!generation || generation.userId !== identity.subject) {
        throw new Error("Generation not found or not owned by user");
      }

      const existing = generation.b2Keys ?? [];
      const keysToRemove = existing.filter((k) => requestedKeys.has(k));
      if (keysToRemove.length === 0) continue;

      const remaining = existing.filter((k) => !requestedKeys.has(k));
      if (remaining.length === 0) {
        await ctx.db.delete(generation._id);
      } else {
        await ctx.db.patch(generation._id, { b2Keys: remaining });
      }

      for (const b2Key of keysToRemove) {
        const favorite = await ctx.db
          .query("favorites")
          .withIndex("by_user_key", (q) => q.eq("userId", identity.subject).eq("b2Key", b2Key))
          .first();
        if (favorite) {
          await ctx.db.delete(favorite._id);
        }
      }
      removed += keysToRemove.length;
    }

    return removed;
  },
});

/**
 * Delete every failed self-hosted generation.
 *
 * The hosted-API side has had `grokGenerations.removeAllFailed` for a while;
 * this is its counterpart, so one button can clear both. It does not need that
 * one's cost check — a self-hosted failure spent GPU time, not money, and there
 * is no figure on the row to preserve.
 *
 * Rows written by `save` carry no `status` at all and are therefore never
 * matched, which is what keeps this from touching finished work.
 */
export const removeAllFailed = mutation({
  args: {},
  handler: async (ctx) => {
    const identity = await requireAllowedUser(ctx);

    const failed = await ctx.db
      .query("generations")
      .withIndex("by_user_status_timestamp", (q) =>
        q.eq("userId", identity.subject).eq("status", "failed"),
      )
      .collect();

    for (const generation of failed) {
      // Same cleanup `remove` does: a favourite that outlives its generation is
      // the one thing that keeps a deleted image on screen.
      for (const b2Key of generation.b2Keys ?? []) {
        const favorite = await ctx.db
          .query("favorites")
          .withIndex("by_user_key", (q) => q.eq("userId", identity.subject).eq("b2Key", b2Key))
          .first();
        if (favorite) {
          await ctx.db.delete(favorite._id);
        }
      }
      await ctx.db.delete(generation._id);
    }

    return failed.length;
  },
});

export const clearAll = mutation({
  args: {},
  handler: async (ctx) => {
    const identity = await requireAllowedUser(ctx);

    const generations = await ctx.db
      .query("generations")
      .withIndex("by_user", (q) => q.eq("userId", identity.subject))
      .collect();

    for (const generation of generations) {
      await ctx.db.delete(generation._id);
    }
  },
});

export const startGeneration = mutation({
  args: {
    promptId: v.string(),
    backendType: v.string(),
    formState: formStateValidator,
    clientId: v.optional(v.string()),
    nodeLabels: v.optional(v.record(v.string(), v.string())),
  },
  handler: async (ctx, args) => {
    const identity = await requireAllowedUser(ctx);

    const generationId = await ctx.db.insert("generations", {
      userId: identity.subject,
      timestamp: Date.now(),
      formState: args.formState,
      imageUrls: [],
      b2Keys: [],
      status: "pending",
      promptId: args.promptId,
      comfyClientId: args.clientId,
      backend: args.backendType,
      searchablePrompt: args.formState.prompt,
      progressStage: "provider-queued",
      progressMessage: "Waiting on self-hosted backend...",
      progressUpdatedAt: Date.now(),
    });

    await ctx.scheduler.runAfter(0, internal.generationProcessor.processGeneration, {
      generationId,
      promptId: args.promptId,
      backendType: args.backendType,
      clientId: args.clientId,
      nodeLabels: args.nodeLabels,
    });

    return generationId;
  },
});

export const updateGenerationStatus = internalMutation({
  args: {
    generationId: v.id("generations"),
    status: v.union(
      v.literal("pending"),
      v.literal("processing"),
      v.literal("completed"),
      v.literal("failed"),
    ),
    b2Keys: v.optional(v.array(v.string())),
    error: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const updates: Record<string, unknown> = { status: args.status };
    if (args.b2Keys !== undefined) {
      updates.b2Keys = args.b2Keys;
      updates.imageUrls = [];
    }
    if (args.error !== undefined) updates.error = args.error;
    if (args.status === "completed" || args.status === "failed") {
      updates.progressStage = undefined;
      updates.progressMessage = undefined;
      updates.progressCurrent = undefined;
      updates.progressTotal = undefined;
      updates.queuePosition = undefined;
      updates.providerStatus = undefined;
      updates.progressUpdatedAt = undefined;
    }
    await ctx.db.patch(args.generationId, updates);
  },
});

export const updateGenerationProgress = internalMutation({
  args: {
    generationId: v.id("generations"),
    stage: v.string(),
    message: v.optional(v.string()),
    current: v.optional(v.number()),
    total: v.optional(v.number()),
    queuePosition: v.optional(v.number()),
    providerStatus: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const generation = await ctx.db.get(args.generationId);
    if (!generation || (generation.status !== "pending" && generation.status !== "processing")) {
      return;
    }
    const progress = {
      progressStage: args.stage,
      progressMessage: args.message,
      progressCurrent: args.current,
      progressTotal: args.total,
      queuePosition: args.queuePosition,
      providerStatus: args.providerStatus,
    };
    // Same rule as grokGenerations.updateProgress: a report that changes
    // nothing on the card is not written, because every write re-runs the
    // history grid for each subscriber. Nothing reads `progressUpdatedAt` —
    // failStalled measures from `timestamp` — so it is no reason to write.
    if (!progressChanged(generation, progress)) return;
    await ctx.db.patch(args.generationId, { ...progress, progressUpdatedAt: Date.now() });
  },
});

/**
 * Fails self-hosted generations whose action never got to report back. Convex
 * kills an isolate that outlives its ceiling and a killed isolate runs no catch
 * block, so the row would otherwise sit in `processing` forever — a permanent
 * spinner on /history that Reproduce cannot even be pointed at.
 *
 * Keyed on `timestamp`, the insert time, because this table has no `updatedAt`:
 * the action that owns a row starts immediately after the insert and cannot
 * outlive the ceiling, so a window comfortably wider than the ceiling can never
 * cut a healthy job short.
 */
export const failStalled = internalMutation({
  args: { olderThanMs: v.number() },
  handler: async (ctx, args) => {
    const cutoff = Date.now() - args.olderThanMs;

    // One indexed pass per status, sharing a single 100-row budget: Convex
    // applies `.filter()` after the read, so an unindexed version would page
    // the whole table on every run and `.take()` would never short-circuit.
    const stalled = [];
    for (const status of ["pending", "processing"] as const) {
      if (stalled.length >= 100) break;
      const rows = await ctx.db
        .query("generations")
        .withIndex("by_status_timestamp", (q) => q.eq("status", status).lt("timestamp", cutoff))
        .take(100 - stalled.length);
      stalled.push(...rows);
    }

    for (const generation of stalled) {
      await ctx.db.patch(generation._id, {
        status: "failed",
        error: "Generation timed out — the worker stopped reporting.",
        progressStage: undefined,
        progressMessage: undefined,
        progressCurrent: undefined,
        progressTotal: undefined,
        queuePosition: undefined,
        providerStatus: undefined,
        progressUpdatedAt: undefined,
      });
    }

    return stalled.length;
  },
});

export const searchByPrompt = query({
  args: {
    query: v.string(),
    paginationOpts: paginationOptsValidator,
  },
  handler: async (ctx, args) => {
    const identity = await allowedUserOrNull(ctx);
    if (!identity) {
      return {
        page: [],
        isDone: true,
        continueCursor: "",
      };
    }

    return await ctx.db
      .query("generations")
      .withSearchIndex("search_prompt", (q) =>
        q.search("searchablePrompt", args.query).eq("userId", identity.subject),
      )
      .paginate(args.paginationOpts);
  },
});
