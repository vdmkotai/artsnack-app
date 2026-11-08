import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { internalMutation, internalQuery, query, type MutationCtx } from "./_generated/server";
import { allowedUserOrNull } from "./authz";
import { providerStatePatchChanges } from "./runpodBackendStore";
import {
  acceptsVastProgress,
  boundedWatchdogDelayMs,
  normalizeReportedVastStage,
  shouldCleanupVastBackend,
  VAST_PROVISIONING_MAX_AGE_MS,
  type VastProgressStage,
} from "../../shared/vast-backend";

const state = v.union(
  v.literal("reserving"),
  v.literal("loading"),
  v.literal("provisioning"),
  v.literal("ready"),
  v.literal("stopped"),
  v.literal("offline"),
  v.literal("destroying"),
  v.literal("destroyed"),
  v.literal("error"),
);

export const current = query({
  args: {},
  handler: async (ctx) => {
    const identity = await allowedUserOrNull(ctx);
    if (!identity) return null;
    return ctx.db
      .query("vastBackends")
      .withIndex("by_active", (q) => q.eq("active", true))
      .unique();
  },
});

export const activeById = internalQuery({
  args: { id: v.id("vastBackends") },
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.id);
    return row?.active ? row : null;
  },
});

export const activeReady = internalQuery({
  args: {},
  handler: async (ctx) => {
    const row = await ctx.db
      .query("vastBackends")
      .withIndex("by_active", (q) => q.eq("active", true))
      .unique();
    return row?.state === "ready" ? row : null;
  },
});

async function scheduleWatchdog(
  ctx: MutationCtx,
  row: {
    _id: Id<"vastBackends">;
    stage: string;
    provisioningDeadlineAt: number;
    lifecycleRevision: number;
  },
  now: number,
) {
  const delay = boundedWatchdogDelayMs(row.stage, row.provisioningDeadlineAt, now);
  if (delay === null) return;
  await ctx.scheduler.runAfter(delay, internal.vastBackendActions.cleanupProvisioning, {
    id: row._id,
    expectedRevision: row.lifecycleRevision,
    attempt: 0,
  });
}

export const reserve = internalMutation({
  args: {
    launchLabel: v.string(),
    progressTokenHash: v.string(),
    gpuName: v.string(),
    numGpus: v.number(),
    diskGb: v.number(),
    diskBandwidthMbps: v.number(),
    diskName: v.string(),
    location: v.string(),
    reliability: v.number(),
    hourlyUsd: v.number(),
    storageHourlyUsd: v.number(),
    publicUrl: v.string(),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("vastBackends")
      .withIndex("by_active", (q) => q.eq("active", true))
      .unique();
    if (existing) {
      throw new ConvexError(
        "A Vast.ai backend is already active. Destroy it before renting another.",
      );
    }
    const now = Date.now();
    const id = await ctx.db.insert("vastBackends", {
      ...args,
      active: true,
      state: "reserving",
      stage: "reserving",
      message: "Reserving the selected Vast.ai offer…",
      progress: 2,
      createdAt: now,
      progressUpdatedAt: now,
      provisioningDeadlineAt: now + VAST_PROVISIONING_MAX_AGE_MS,
      lifecycleRevision: 0,
      cleanupAttempts: 0,
      updatedAt: now,
    });
    // If the launch action dies after Vast accepts payment but before it stores
    // the contract id, this independent reconciliation still finds it by label.
    await ctx.scheduler.runAfter(20_000, internal.vastBackendActions.reconcileLaunch, {
      id,
      attempt: 0,
    });
    return id;
  },
});

export const attachInstance = internalMutation({
  args: { id: v.id("vastBackends"), instanceId: v.number() },
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.id);
    if (!row?.active) return null;
    const updatedAt = Date.now();
    const lifecycleRevision = row.lifecycleRevision + 1;
    await ctx.db.patch(args.id, {
      instanceId: args.instanceId,
      state: "loading",
      stage: "starting",
      message: "GPU reserved. Vast.ai is pulling the container image…",
      progress: 5,
      progressUpdatedAt: updatedAt,
      lifecycleRevision,
      cleanupAttempts: 0,
      updatedAt,
    });
    await scheduleWatchdog(
      ctx,
      { ...row, _id: args.id, stage: "starting", lifecycleRevision },
      updatedAt,
    );
    return { stage: "starting" as const, lifecycleRevision };
  },
});

export const beginStart = internalMutation({
  args: { id: v.id("vastBackends") },
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.id);
    if (!row?.active || !row.instanceId) return null;
    const progressUpdatedAt = Date.now();
    const lifecycleRevision = row.lifecycleRevision + 1;
    const provisioningDeadlineAt = progressUpdatedAt + VAST_PROVISIONING_MAX_AGE_MS;
    await ctx.db.patch(args.id, {
      state: "loading",
      stage: "starting",
      message: "Starting the preserved Vast.ai instance…",
      progress: 5,
      error: undefined,
      progressUpdatedAt,
      provisioningDeadlineAt,
      lifecycleRevision,
      cleanupAttempts: 0,
      updatedAt: progressUpdatedAt,
    });
    await scheduleWatchdog(
      ctx,
      { ...row, _id: args.id, stage: "starting", lifecycleRevision, provisioningDeadlineAt },
      progressUpdatedAt,
    );
    return { stage: "starting" as const, lifecycleRevision };
  },
});

export const setProviderState = internalMutation({
  args: {
    id: v.id("vastBackends"),
    state,
    providerStatus: v.optional(v.string()),
    message: v.optional(v.string()),
    error: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.id);
    if (!row) return;
    const terminal = ["ready", "stopped", "destroyed"].includes(args.state);
    const patch: Record<string, unknown> = {
      state: args.state,
      providerStatus: args.providerStatus,
      updatedAt: Date.now(),
      lifecycleRevision: terminal ? row.lifecycleRevision + 1 : row.lifecycleRevision,
    };
    if (args.message !== undefined) patch.message = args.message;
    if (args.error !== undefined) patch.error = args.error;
    if (args.state === "ready") {
      patch.stage = "ready";
      patch.progress = 100;
      patch.error = undefined;
    }
    if (args.state === "destroyed") {
      patch.active = false;
      patch.progress = 100;
      patch.destroyedAt = Date.now();
    }
    // The dialog's 5-second refresh of a stopped, offline or failed instance
    // reports the same thing each time; writing it again changes nothing but
    // `updatedAt` (and, for "stopped", a revision bump the first report
    // already made) and pushes the row to every client. Nothing here
    // schedules cleanup, so a skipped repeat loses no watchdog.
    if (args.state !== "destroyed" && !providerStatePatchChanges(row, patch)) return;
    await ctx.db.patch(args.id, patch);
  },
});

export const setReadyIfRevision = internalMutation({
  args: { id: v.id("vastBackends"), expectedRevision: v.number(), message: v.string() },
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.id);
    if (
      !row?.active ||
      row.lifecycleRevision !== args.expectedRevision ||
      row.stage !== "tunnel" ||
      row.state === "destroying"
    ) {
      return false;
    }
    await ctx.db.patch(args.id, {
      state: "ready",
      stage: "ready",
      providerStatus: "running",
      message: args.message,
      progress: 100,
      error: undefined,
      lifecycleRevision: row.lifecycleRevision + 1,
      updatedAt: Date.now(),
    });
    await ctx.scheduler.runAfter(0, internal.selfHostedSelection.setInternal, {
      provider: "vast",
    });
    return true;
  },
});

export const claimCleanup = internalMutation({
  args: { id: v.id("vastBackends"), expectedRevision: v.number(), now: v.number() },
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.id);
    if (!row?.active || !row.instanceId || row.lifecycleRevision !== args.expectedRevision) {
      return null;
    }
    if (row.state === "destroying") {
      return { instanceId: row.instanceId, lifecycleRevision: row.lifecycleRevision };
    }
    if (
      !shouldCleanupVastBackend(row, {
        lifecycleRevision: args.expectedRevision,
        now: args.now,
      })
    ) {
      return null;
    }
    const lifecycleRevision = row.lifecycleRevision + 1;
    await ctx.db.patch(args.id, {
      state: "destroying",
      stage: "cleanup",
      providerStatus: "cleanup_in_progress",
      message: "Provisioning timed out; destroying the instance to stop billing…",
      lifecycleRevision,
      updatedAt: args.now,
    });
    return { instanceId: row.instanceId, lifecycleRevision };
  },
});

export const finishCleanup = internalMutation({
  args: { id: v.id("vastBackends"), expectedRevision: v.number(), message: v.string() },
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.id);
    if (!row || row.lifecycleRevision !== args.expectedRevision) return;
    await ctx.db.patch(args.id, {
      active: false,
      state: "destroyed",
      stage: "cleanup",
      providerStatus: "destroyed",
      message: args.message,
      progress: 100,
      lifecycleRevision: row.lifecycleRevision + 1,
      destroyedAt: Date.now(),
      updatedAt: Date.now(),
    });
  },
});

export const reportProgress = internalMutation({
  args: {
    id: v.id("vastBackends"),
    stage: v.string(),
    message: v.string(),
    progress: v.number(),
    progressTokenHash: v.string(),
  },
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.id);
    if (!row || !acceptsVastProgress(row) || row.progressTokenHash !== args.progressTokenHash) {
      return null;
    }
    // Readiness is decided from outside the tunnel. A pod can only say that it
    // has started the tunnel process, never that the public route works.
    const stage = normalizeReportedVastStage(args.stage as VastProgressStage);
    const progress = Math.max(row.progress, Math.min(100, Math.max(0, args.progress)));
    const updatedAt = Date.now();
    const lifecycleRevision = row.lifecycleRevision + 1;
    await ctx.db.patch(args.id, {
      state: stage === "error" ? "error" : "provisioning",
      stage,
      message: args.message.slice(0, 500),
      progress,
      error: stage === "error" ? args.message.slice(0, 500) : undefined,
      progressUpdatedAt: updatedAt,
      lifecycleRevision,
      cleanupAttempts: 0,
      updatedAt,
    });
    if (stage === "tunnel") {
      await ctx.scheduler.runAfter(0, internal.vastBackendActions.verifyTunnel, {
        id: args.id,
        expectedRevision: lifecycleRevision,
        attempt: 0,
      });
    } else {
      await scheduleWatchdog(ctx, { ...row, _id: args.id, stage, lifecycleRevision }, updatedAt);
    }
    return { stage, lifecycleRevision };
  },
});

export const markLaunchUncertain = internalMutation({
  args: { id: v.id("vastBackends"), message: v.string() },
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.id);
    if (!row?.active || row.instanceId) return;
    await ctx.db.patch(args.id, {
      state: "loading",
      stage: "launch_uncertain",
      message: args.message.slice(0, 500),
      updatedAt: Date.now(),
    });
  },
});

export const recordCleanupRequired = internalMutation({
  args: { id: v.id("vastBackends"), instanceId: v.number(), message: v.string() },
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.id);
    if (!row?.active) return;
    const now = Date.now();
    const lifecycleRevision = row.lifecycleRevision + 1;
    await ctx.db.patch(args.id, {
      instanceId: args.instanceId,
      state: "error",
      stage: "error",
      providerStatus: "cleanup_required",
      message: "Launch failed and automatic cleanup is retrying.",
      error: args.message.slice(0, 500),
      progressUpdatedAt: now,
      lifecycleRevision,
      updatedAt: now,
    });
    await scheduleWatchdog(ctx, { ...row, _id: args.id, stage: "error", lifecycleRevision }, now);
  },
});

export const scheduleLaunchReconcile = internalMutation({
  args: { id: v.id("vastBackends"), attempt: v.number() },
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.id);
    if (!row?.active || row.instanceId) return;
    await ctx.scheduler.runAfter(
      Math.min(60_000, 10_000 * 2 ** Math.min(args.attempt, 3)),
      internal.vastBackendActions.reconcileLaunch,
      { id: args.id, attempt: args.attempt + 1 },
    );
  },
});

export const scheduleTunnelRetry = internalMutation({
  args: { id: v.id("vastBackends"), expectedRevision: v.number(), attempt: v.number() },
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.id);
    if (
      !row?.active ||
      row.lifecycleRevision !== args.expectedRevision ||
      row.stage !== "tunnel" ||
      Date.now() >= row.provisioningDeadlineAt
    ) {
      return;
    }
    await ctx.scheduler.runAfter(
      Math.min(30_000, 2_000 * 2 ** Math.min(args.attempt, 4)),
      internal.vastBackendActions.verifyTunnel,
      { id: args.id, expectedRevision: args.expectedRevision, attempt: args.attempt + 1 },
    );
  },
});

export const scheduleCleanupRetry = internalMutation({
  args: {
    id: v.id("vastBackends"),
    expectedRevision: v.number(),
    attempt: v.number(),
    error: v.string(),
  },
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.id);
    if (!row?.active || row.lifecycleRevision !== args.expectedRevision) return;
    if (["ready", "stopped", "destroyed"].includes(row.state)) return;
    const attempt = args.attempt + 1;
    await ctx.db.patch(args.id, {
      cleanupAttempts: attempt,
      providerStatus: "cleanup_retrying",
      message: `Automatic cleanup failed; retry ${attempt} is scheduled.`,
      error: args.error.slice(0, 500),
      updatedAt: Date.now(),
    });
    await ctx.scheduler.runAfter(
      Math.min(5 * 60_000, 15_000 * 2 ** Math.min(attempt, 5)),
      internal.vastBackendActions.cleanupProvisioning,
      { id: args.id, expectedRevision: args.expectedRevision, attempt },
    );
  },
});

export const failReservation = internalMutation({
  args: { id: v.id("vastBackends"), message: v.string() },
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.id);
    if (!row) return;
    await ctx.db.patch(args.id, {
      active: false,
      state: "error",
      stage: "error",
      message: args.message.slice(0, 500),
      error: args.message.slice(0, 500),
      lifecycleRevision: row.lifecycleRevision + 1,
      updatedAt: Date.now(),
    });
  },
});
