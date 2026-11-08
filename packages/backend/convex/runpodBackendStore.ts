import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import {
  internalMutation,
  internalQuery,
  query,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server";
import { allowedUserOrNull } from "./authz";
import { acceptsVastProgress, type VastProgressStage } from "../../shared/vast-backend";
import {
  RUNPOD_PROVISIONING_MAX_AGE_MS,
  RUNPOD_FAILED_CLEANUP_DELAY_MS,
  shouldCleanupRunpodBackend,
} from "../../shared/runpod-backend";

const state = v.union(
  v.literal("reserving"),
  v.literal("loading"),
  v.literal("provisioning"),
  v.literal("ready"),
  v.literal("stopped"),
  v.literal("destroying"),
  v.literal("destroyed"),
  v.literal("error"),
);

export const purposeValidator = v.union(v.literal("image"), v.literal("video"));
export type RunpodPurpose = "image" | "video";

/**
 * Every active row of one purpose, in `by_active` order (creation time).
 *
 * Read through `by_active_purpose` so a query's read set is that purpose's
 * rows only: a booting image pod reports progress ~140 times, and reading
 * every active row would re-run each video-pod subscriber on every report. A
 * row written before the video pod existed has no purpose and is the image
 * pod, so the image read is two ranges — tagged and untagged — merged.
 */
async function activeRowsFor(ctx: QueryCtx | MutationCtx, purpose: RunpodPurpose) {
  const tagged = await ctx.db
    .query("runpodBackends")
    .withIndex("by_active_purpose", (q) => q.eq("active", true).eq("purpose", purpose))
    .collect();
  if (purpose !== "image") return tagged;
  const untagged = await ctx.db
    .query("runpodBackends")
    .withIndex("by_active_purpose", (q) => q.eq("active", true).eq("purpose", undefined))
    .collect();
  if (untagged.length === 0) return tagged;
  return [...untagged, ...tagged].sort((a, b) => a._creationTime - b._creationTime);
}

/**
 * The active pod for one purpose. There is one image pod and one video pod at
 * most, so "active" alone is no longer unique — and a row written before the
 * video pod existed has no purpose and is the image pod.
 */
async function activeFor(ctx: QueryCtx | MutationCtx, purpose: RunpodPurpose) {
  return (await activeRowsFor(ctx, purpose))[0] ?? null;
}

/** Every active pod of a purpose, oldest first. Video may have several. */
async function activeAllFor(ctx: QueryCtx | MutationCtx, purpose: RunpodPurpose) {
  return (await activeRowsFor(ctx, purpose)).sort((a, b) => a.createdAt - b.createdAt);
}

/**
 * Fields a provider-state patch writes on every call whatever happened, so
 * they say nothing about whether the row changed.
 */
const PROVIDER_STATE_BOOKKEEPING = new Set([
  "updatedAt",
  "lifecycleRevision",
  "progressUpdatedAt",
  "destroyedAt",
]);

/**
 * Whether a provider-state patch would change anything but bookkeeping.
 *
 * The backend dialogs poll `refresh` every 5 s, and a stopped or failed pod
 * answers the same thing each time; writing that answer bumped `updatedAt`
 * (and, for terminal states, the revision) and pushed the row to every client
 * watching it. Shared with vastBackendStore, which has the same lifecycle.
 */
export function providerStatePatchChanges(
  row: Record<string, unknown>,
  patch: Record<string, unknown>,
): boolean {
  return Object.entries(patch).some(
    ([key, value]) => !PROVIDER_STATE_BOOKKEEPING.has(key) && !Object.is(row[key], value),
  );
}

/**
 * Slack after a failed pod's cleanup was due before an unchanged "error"
 * report re-arms it. The watchdog armed when the row entered `error` fires at
 * `progressUpdatedAt + RUNPOD_FAILED_CLEANUP_DELAY_MS` and moves it on to
 * `destroying`; a row still in `error` this long after that means it never
 * ran (a lost action, a revision that moved), and the report re-arms it.
 */
export const RUNPOD_ERROR_REARM_GRACE_MS = 60_000;

/**
 * What `setProviderState` does with a report: `skip` it — nothing would change
 * and, for a failed pod, its cleanup is already scheduled — or `write` it.
 *
 * Every report into `error` used to stamp `progressUpdatedAt` and schedule a
 * cleanup, so a dialog polling a failed pod scheduled one every 5 s and each
 * one found the timestamp too fresh to act on: the pod was destroyed only
 * after the dialog closed. Now the first report arms one watchdog, repeats
 * leave it alone, and only an overdue one is re-armed.
 */
export function runpodProviderStateWrite(
  row: Record<string, unknown> & { state: string; podId?: string; progressUpdatedAt: number },
  patch: Record<string, unknown>,
  now: number,
): "skip" | "write" {
  if (patch.state === "destroyed" || providerStatePatchChanges(row, patch)) return "write";
  if (patch.state !== "error" || !row.podId) return "skip";
  const cleanupOverdueAt =
    row.progressUpdatedAt + RUNPOD_FAILED_CLEANUP_DELAY_MS + RUNPOD_ERROR_REARM_GRACE_MS;
  return now < cleanupOverdueAt ? "skip" : "write";
}

/** Video pods can run side by side — say an H100 for H3 and a B200 for LTX —
 *  and a job goes to the one picked in the form or the least busy one. */
export const MAX_VIDEO_PODS = 4;

/** Every active video pod, oldest first, for the tab's pod list and picker. */
export const videoPods = query({
  args: {},
  handler: async (ctx) => {
    if (!(await allowedUserOrNull(ctx))) return [];
    return activeAllFor(ctx, "video");
  },
});

/** One active pod by id, for a panel that manages that pod. */
export const byId = query({
  args: { id: v.id("runpodBackends") },
  handler: async (ctx, args) => {
    if (!(await allowedUserOrNull(ctx))) return null;
    const row = await ctx.db.get(args.id);
    return row?.active ? row : null;
  },
});

export const readyVideoPods = internalQuery({
  args: {},
  handler: async (ctx) => (await activeAllFor(ctx, "video")).filter((row) => row.state === "ready"),
});

/** Absent purpose = image, so every existing caller (web, iOS) keeps meaning
 *  the image pod without changing a line. */
export const current = query({
  args: { purpose: v.optional(purposeValidator) },
  handler: async (ctx, args) => {
    if (!(await allowedUserOrNull(ctx))) return null;
    return activeFor(ctx, args.purpose ?? "image");
  },
});

export const activeById = internalQuery({
  args: { id: v.id("runpodBackends") },
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.id);
    return row?.active ? row : null;
  },
});

/** The active row of a purpose in any state — booting included. */
export const active = internalQuery({
  args: { purpose: v.optional(purposeValidator) },
  handler: async (ctx, args) => activeFor(ctx, args.purpose ?? "image"),
});

export const activeReady = internalQuery({
  args: { purpose: v.optional(purposeValidator) },
  handler: async (ctx, args) => {
    const row = await activeFor(ctx, args.purpose ?? "image");
    return row?.state === "ready" ? row : null;
  },
});

async function scheduleWatchdog(
  ctx: MutationCtx,
  row: {
    _id: Id<"runpodBackends">;
    provisioningDeadlineAt: number;
    lifecycleRevision: number;
    state?: string;
  },
  now: number,
) {
  const delay =
    row.state === "error"
      ? Math.min(RUNPOD_FAILED_CLEANUP_DELAY_MS, row.provisioningDeadlineAt - now)
      : row.provisioningDeadlineAt - now;
  await ctx.scheduler.runAfter(
    Math.max(0, delay),
    internal.runpodBackendActions.cleanupProvisioning,
    { id: row._id, expectedRevision: row.lifecycleRevision, attempt: 0 },
  );
}

export const reserve = internalMutation({
  args: {
    launchName: v.string(),
    progressTokenHash: v.string(),
    gpuTypeId: v.string(),
    gpuName: v.string(),
    numGpus: v.number(),
    cloudType: v.union(v.literal("SECURE"), v.literal("COMMUNITY")),
    templateProfile: v.union(v.literal("cuda12.8"), v.literal("cuda13.0")),
    templateId: v.string(),
    purpose: purposeValidator,
    containerDiskGb: v.number(),
    volumeDiskGb: v.number(),
    hourlyUsd: v.number(),
    maxHourlyUsd: v.number(),
  },
  handler: async (ctx, args) => {
    if (args.purpose === "video") {
      if ((await activeAllFor(ctx, "video")).length >= MAX_VIDEO_PODS) {
        throw new ConvexError(`At most ${MAX_VIDEO_PODS} video pods at once. Destroy one first.`);
      }
    } else if (await activeFor(ctx, args.purpose)) {
      throw new ConvexError("A managed RunPod backend is already active. Destroy it first.");
    }
    const now = Date.now();
    const id = await ctx.db.insert("runpodBackends", {
      ...args,
      active: true,
      publicUrl: "",
      state: "reserving",
      stage: "reserving",
      message: "Requesting a RunPod GPU…",
      progress: 2,
      createdAt: now,
      progressUpdatedAt: now,
      provisioningDeadlineAt: now + RUNPOD_PROVISIONING_MAX_AGE_MS,
      lifecycleRevision: 0,
      cleanupAttempts: 0,
      updatedAt: now,
    });
    await ctx.scheduler.runAfter(20_000, internal.runpodBackendActions.reconcileLaunch, {
      id,
      attempt: 0,
    });
    return id;
  },
});

export const attachPod = internalMutation({
  args: {
    id: v.id("runpodBackends"),
    podId: v.string(),
    publicUrl: v.string(),
    hourlyUsd: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.id);
    if (!row?.active) return null;
    const now = Date.now();
    const lifecycleRevision = row.lifecycleRevision + 1;
    await ctx.db.patch(args.id, {
      podId: args.podId,
      publicUrl: args.publicUrl,
      hourlyUsd: args.hourlyUsd ?? row.hourlyUsd,
      state: "loading",
      stage: "starting",
      message: "GPU reserved. RunPod is pulling the ComfyUI image…",
      progress: 5,
      progressUpdatedAt: now,
      lifecycleRevision,
      cleanupAttempts: 0,
      updatedAt: now,
    });
    await scheduleWatchdog(ctx, { ...row, _id: args.id, lifecycleRevision }, now);
    return { lifecycleRevision };
  },
});

export const beginStart = internalMutation({
  args: { id: v.id("runpodBackends") },
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.id);
    if (!row?.active || !row.podId) return null;
    const now = Date.now();
    const lifecycleRevision = row.lifecycleRevision + 1;
    const provisioningDeadlineAt = now + RUNPOD_PROVISIONING_MAX_AGE_MS;
    await ctx.db.patch(args.id, {
      state: "loading",
      stage: "starting",
      message: "Starting RunPod. The wiped container disk will be provisioned again…",
      progress: 5,
      error: undefined,
      progressUpdatedAt: now,
      provisioningDeadlineAt,
      lifecycleRevision,
      cleanupAttempts: 0,
      updatedAt: now,
    });
    await scheduleWatchdog(
      ctx,
      { ...row, _id: args.id, lifecycleRevision, provisioningDeadlineAt },
      now,
    );
    return { lifecycleRevision };
  },
});

export const restoreStoppedIfRevision = internalMutation({
  args: { id: v.id("runpodBackends"), expectedRevision: v.number(), message: v.string() },
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.id);
    if (!row?.active || row.lifecycleRevision !== args.expectedRevision) return false;
    await ctx.db.patch(args.id, {
      state: "stopped",
      stage: "stopped",
      message: args.message.slice(0, 500),
      progress: 100,
      lifecycleRevision: row.lifecycleRevision + 1,
      updatedAt: Date.now(),
    });
    return true;
  },
});

export const setProviderState = internalMutation({
  args: {
    id: v.id("runpodBackends"),
    state,
    providerStatus: v.optional(v.string()),
    message: v.optional(v.string()),
    error: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.id);
    if (!row) return;
    const now = Date.now();
    const terminal = ["ready", "stopped", "destroyed"].includes(args.state);
    const patch: Record<string, unknown> = {
      state: args.state,
      providerStatus: args.providerStatus,
      lifecycleRevision: terminal ? row.lifecycleRevision + 1 : row.lifecycleRevision,
      updatedAt: now,
    };
    if (args.message !== undefined) patch.message = args.message;
    if (args.error !== undefined) patch.error = args.error;
    if (args.state === "destroyed") {
      patch.active = false;
      patch.progress = 100;
      patch.destroyedAt = now;
    }
    if (args.state === "error" && row.podId) {
      patch.progressUpdatedAt = now;
    }
    if (runpodProviderStateWrite(row, patch, now) === "skip") return;
    await ctx.db.patch(args.id, patch);
    if (args.state === "error" && row.podId) {
      await scheduleWatchdog(ctx, { ...row, state: "error" }, now);
    }
  },
});

export const reportProgress = internalMutation({
  args: {
    id: v.id("runpodBackends"),
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
    const reportedStage = args.stage as VastProgressStage;
    const stage = reportedStage === "ready" ? "verifying" : reportedStage;
    const now = Date.now();
    const lifecycleRevision = row.lifecycleRevision + 1;
    await ctx.db.patch(args.id, {
      state: stage === "error" ? "error" : "provisioning",
      stage,
      message: args.message.slice(0, 500),
      progress: Math.max(row.progress, Math.min(100, Math.max(0, args.progress))),
      error: stage === "error" ? args.message.slice(0, 500) : undefined,
      progressUpdatedAt: now,
      lifecycleRevision,
      cleanupAttempts: 0,
      updatedAt: now,
    });
    await scheduleWatchdog(ctx, { ...row, _id: args.id, lifecycleRevision, state: stage }, now);
    if (reportedStage === "ready") {
      await ctx.scheduler.runAfter(0, internal.runpodBackendActions.verifyReady, {
        id: args.id,
        expectedRevision: lifecycleRevision,
        attempt: 0,
      });
    }
    return { stage, lifecycleRevision };
  },
});

export const setReadyIfRevision = internalMutation({
  args: {
    id: v.id("runpodBackends"),
    expectedRevision: v.number(),
    instanceUrls: v.optional(v.array(v.string())),
  },
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.id);
    if (
      !row?.active ||
      row.lifecycleRevision !== args.expectedRevision ||
      row.stage !== "verifying" ||
      row.state === "destroying"
    ) {
      return false;
    }
    await ctx.db.patch(args.id, {
      state: "ready",
      stage: "ready",
      providerStatus: "RUNNING",
      // provision.sh reports "online with warnings: …" when a check failed;
      // keep that, it is what the video pod's amber chip reads.
      message: /with warnings/i.test(row.message ?? "")
        ? row.message
        : "Backend is online and ready for generations.",
      instanceUrls: args.instanceUrls,
      progress: 100,
      error: undefined,
      lifecycleRevision: row.lifecycleRevision + 1,
      updatedAt: Date.now(),
    });
    // The image tab's provider switch is about image pods only; a video pod
    // coming up must not steal it.
    if ((row.purpose ?? "image") === "image") {
      await ctx.scheduler.runAfter(0, internal.selfHostedSelection.setInternal, {
        provider: "runpod",
      });
    }
    return true;
  },
});

export const scheduleReadyRetry = internalMutation({
  args: { id: v.id("runpodBackends"), expectedRevision: v.number(), attempt: v.number() },
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.id);
    if (
      !row?.active ||
      row.lifecycleRevision !== args.expectedRevision ||
      row.stage !== "verifying" ||
      Date.now() >= row.provisioningDeadlineAt
    ) {
      return;
    }
    await ctx.scheduler.runAfter(
      Math.min(30_000, 2_000 * 2 ** Math.min(args.attempt, 4)),
      internal.runpodBackendActions.verifyReady,
      { id: args.id, expectedRevision: args.expectedRevision, attempt: args.attempt + 1 },
    );
  },
});

export const claimCleanup = internalMutation({
  args: { id: v.id("runpodBackends"), expectedRevision: v.number(), now: v.number() },
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.id);
    if (!row?.active || !row.podId || row.lifecycleRevision !== args.expectedRevision) {
      return null;
    }
    if (row.state === "destroying") {
      return { podId: row.podId, lifecycleRevision: row.lifecycleRevision };
    }
    if (
      !shouldCleanupRunpodBackend(row, {
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
      message: "Provisioning timed out; destroying the pod to stop billing…",
      lifecycleRevision,
      updatedAt: args.now,
    });
    return { podId: row.podId, lifecycleRevision };
  },
});

export const finishCleanup = internalMutation({
  args: { id: v.id("runpodBackends"), expectedRevision: v.number(), message: v.string() },
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.id);
    if (!row || row.lifecycleRevision !== args.expectedRevision) return;
    await ctx.db.patch(args.id, {
      active: false,
      state: "destroyed",
      stage: "cleanup",
      providerStatus: "TERMINATED",
      message: args.message,
      progress: 100,
      lifecycleRevision: row.lifecycleRevision + 1,
      destroyedAt: Date.now(),
      updatedAt: Date.now(),
    });
  },
});

export const markLaunchUncertain = internalMutation({
  args: { id: v.id("runpodBackends"), message: v.string() },
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.id);
    if (!row?.active || row.podId) return;
    await ctx.db.patch(args.id, {
      state: "loading",
      stage: "launch_uncertain",
      message: args.message.slice(0, 500),
      updatedAt: Date.now(),
    });
  },
});

export const failReservation = internalMutation({
  args: { id: v.id("runpodBackends"), message: v.string() },
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

export const scheduleLaunchReconcile = internalMutation({
  args: { id: v.id("runpodBackends"), attempt: v.number() },
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.id);
    if (!row?.active || row.podId) return;
    await ctx.scheduler.runAfter(
      Math.min(60_000, 10_000 * 2 ** Math.min(args.attempt, 3)),
      internal.runpodBackendActions.reconcileLaunch,
      { id: args.id, attempt: args.attempt + 1 },
    );
  },
});

export const scheduleCleanupRetry = internalMutation({
  args: {
    id: v.id("runpodBackends"),
    expectedRevision: v.number(),
    attempt: v.number(),
    error: v.string(),
  },
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.id);
    if (!row?.active || row.lifecycleRevision !== args.expectedRevision) return;
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
      internal.runpodBackendActions.cleanupProvisioning,
      { id: args.id, expectedRevision: args.expectedRevision, attempt },
    );
  },
});
