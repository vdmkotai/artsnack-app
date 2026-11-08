import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { paginationOptsValidator } from "convex/server";
import {
  internalMutation,
  internalQuery,
  mutation,
  query,
  type MutationCtx,
} from "./_generated/server";
import { allowedUserOrNull, requireAllowedUser } from "./authz";
import {
  comfyRunValidator,
  h3InputRoleValidator,
  h3SettingsValidator,
  ltxSettingsValidator,
} from "./h3Validators";
import { mergeComfyRunStats } from "../../shared/comfy-run-stats";
import { runpodInstanceUrls } from "../../shared/runpod-backend";
import {
  H3_LIMITS,
  h3ReferenceTagProblem,
  normalizeH3Settings,
  type H3VideoSettings,
} from "../../shared/h3-video";
import { LTX_LIMITS, normalizeLtxSettings } from "../../shared/ltx-video";

/**
 * Self-hosted MiniMax H3 jobs on the video pod.
 *
 * Rows live in `grokGenerations` with provider "comfy", so the API tab's grid,
 * lightbox, favourites and search show them with no second code path — and the
 * table already carries the poll-lease fields the Atlas processor introduced
 * for jobs that outlive one 10-minute Convex action. Those fields are reused
 * here as they are: `falRequestId` holds the ComfyUI prompt id (the "vendor
 * accepted it" marker), `atlasPollLeaseId/Until` the ownership lease, and
 * `atlasWaitEndsAt` the absolute deadline across every continuation.
 *
 * A 15-second 768p clip on an RTX PRO 6000 is ~6 minutes alone and the pod
 * runs one prompt at a time, so a job behind two others can legitimately wait
 * half an hour. The processor polls for ~7 minutes, then hands the job to a
 * fresh action; the cron below re-arms any job whose action died silently.
 */

/** How long one claim is good for. */
export const COMFY_LEASE_MS = 3 * 60_000;
/**
 * A held lease is only written again once less than this is left. Every write
 * to the row re-runs each grid that lists it and pushes the page to every
 * client, and the processor checks ownership every few seconds — renewing on
 * each check made a queued clip rewrite its row ~20 times a minute for nothing
 * anyone sees. Renewing at half-life writes once a minute and a half; the
 * processor's 30-second heartbeat keeps at least a minute in hand.
 */
export const COMFY_LEASE_RENEW_BELOW_MS = 90_000;
/** Queue + render + upload, across every continuation of one job. */
export const COMFY_TOTAL_WAIT_MS = 2 * 60 * 60_000;
/** Clips per click — each is its own prompt in the pod's queue. */
export const COMFY_MAX_COUNT = 4;

const inputValidator = v.object({
  storageId: v.id("_storage"),
  role: h3InputRoleValidator,
  /** The B2 key the image came from when picked out of history, else null. */
  sourceKey: v.optional(v.union(v.string(), v.null())),
});

function validateInputs(
  settings: H3VideoSettings,
  inputs: { role: "first" | "last" | "reference" }[],
): void {
  if (settings.mode === "text") return;
  if (settings.mode === "frames") {
    const firsts = inputs.filter((input) => input.role === "first").length;
    const lasts = inputs.filter((input) => input.role === "last").length;
    if (firsts + lasts === 0) throw new ConvexError("Add a first frame, a last frame, or both");
    if (firsts > 1 || lasts > 1)
      throw new ConvexError("One first frame and one last frame at most");
    if (inputs.some((input) => input.role === "reference")) {
      throw new ConvexError("Reference images belong to Reference mode");
    }
    return;
  }
  const references = inputs.filter((input) => input.role === "reference").length;
  if (references === 0) throw new ConvexError("Add at least one reference image");
  if (references > H3_LIMITS.references) {
    throw new ConvexError(`At most ${H3_LIMITS.references} reference images`);
  }
  if (references !== inputs.length) {
    throw new ConvexError("First and last frames belong to Image → video mode");
  }
}

/** A pod picked in the form must be an active video pod; it is checked again
 *  (ready, has the models) when the job runs. */
async function pinnedVideoPod(
  ctx: MutationCtx,
  backendId: Id<"runpodBackends"> | undefined,
): Promise<Id<"runpodBackends"> | undefined> {
  if (!backendId) return undefined;
  const pod = await ctx.db.get(backendId);
  if (!pod?.active || pod.purpose !== "video") {
    throw new ConvexError("That video pod is no longer running — pick another or Auto");
  }
  return backendId;
}

function randomSeed(): number {
  // Within RandomNoise's range and exactly representable as a JS number.
  return Math.floor(Math.random() * 2 ** 48);
}

export const start = mutation({
  args: {
    settings: h3SettingsValidator,
    inputs: v.optional(v.array(inputValidator)),
    count: v.optional(v.number()),
    /** A video pod picked in the form; absent = the least busy one with the models. */
    backendId: v.optional(v.id("runpodBackends")),
  },
  handler: async (ctx, args) => {
    const identity = await requireAllowedUser(ctx);
    const pinnedPod = await pinnedVideoPod(ctx, args.backendId);
    const settings = normalizeH3Settings(args.settings);
    const prompt = settings.prompt.trim();
    if (!prompt) throw new ConvexError("Prompt is required");

    // Normalisation falls back to the official checkpoint and drops LoRAs with
    // unusable names; doing that silently would render a different clip than
    // the one asked for, so a name it would change is an error instead.
    if (args.settings.checkpoint && settings.checkpoint !== args.settings.checkpoint) {
      throw new ConvexError(`Checkpoint name not supported: ${args.settings.checkpoint}`);
    }
    const dropped = (args.settings.loras ?? []).find(
      (lora) => lora.name && !settings.loras.some((kept) => kept.name === lora.name),
    );
    if (dropped) throw new ConvexError(`LoRA name not supported: ${dropped.name}`);

    // Text mode ignores whatever is still attached in the form.
    const inputs = settings.mode === "text" ? [] : (args.inputs ?? []);
    validateInputs(settings, inputs);
    if (settings.mode === "reference") {
      const problem = h3ReferenceTagProblem(prompt, inputs.length);
      if (problem) throw new ConvexError(problem);
    }

    const count = Math.round(args.count ?? 1);
    if (count < 1 || count > COMFY_MAX_COUNT) {
      throw new ConvexError(`Clips per request must be 1–${COMFY_MAX_COUNT}`);
    }
    // One seed per clip: a fixed seed still yields `count` different clips,
    // and each row keeps the exact seed it ran with.
    const baseSeed = settings.seed === -1 ? randomSeed() : settings.seed;
    const batchId = count > 1 ? `${identity.subject}:${Date.now()}:${Math.random()}` : undefined;
    const ids: Id<"grokGenerations">[] = [];

    for (let index = 0; index < count; index++) {
      const now = Date.now();
      const leaseId = `${identity.subject}:${now}:${Math.random()}`;
      const id = await ctx.db.insert("grokGenerations", {
        userId: identity.subject,
        createdAt: now,
        prompt,
        searchablePrompt: prompt,
        mediaType: "video",
        status: "pending",
        duration: settings.durationSeconds,
        resolution: `${settings.width}×${settings.height}`,
        hasReferenceImage: inputs.length > 0,
        referenceStorageIds: inputs.length > 0 ? inputs.map((input) => input.storageId) : undefined,
        referenceSourceKeys:
          inputs.length > 0 ? inputs.map((input) => input.sourceKey ?? null) : undefined,
        h3InputRoles: inputs.length > 0 ? inputs.map((input) => input.role) : undefined,
        h3Settings: { ...settings, prompt, seed: baseSeed + index },
        provider: "comfy",
        apiModel: settings.checkpoint,
        comfyBackendId: pinnedPod,
        generateAudio: settings.audio,
        batchId,
        dispatchedAt: now,
        progressStage: "queued",
        progressMessage: "Waiting for the video pod…",
        progressUpdatedAt: now,
        // The pod is billed by the hour, not per clip.
        costUsd: 0,
        costEstimated: false,
        atlasPollLeaseId: leaseId,
        atlasPollLeaseUntil: now + COMFY_LEASE_MS,
        atlasWaitEndsAt: now + COMFY_TOTAL_WAIT_MS,
      });
      await ctx.scheduler.runAfter(0, internal.comfyVideoProcessor.run, {
        generationId: id,
        leaseId,
      });
      ids.push(id);
    }
    return ids[0];
  },
});

/**
 * An LTX 2.3 job on the same video pod. Same rows, lease and processor as H3;
 * `ltxSettings` instead of `h3Settings` tells the processor which graph to build.
 */
export const startLtx = mutation({
  args: {
    settings: ltxSettingsValidator,
    inputs: v.optional(v.array(inputValidator)),
    count: v.optional(v.number()),
    backendId: v.optional(v.id("runpodBackends")),
  },
  handler: async (ctx, args) => {
    const identity = await requireAllowedUser(ctx);
    const pinnedPod = await pinnedVideoPod(ctx, args.backendId);
    if (args.settings.loras.length > LTX_LIMITS.loras) {
      throw new ConvexError(`Up to ${LTX_LIMITS.loras} LoRAs per clip`);
    }
    const settings = normalizeLtxSettings(args.settings);
    const prompt = settings.prompt.trim();
    if (!prompt) throw new ConvexError("Prompt is required");
    if (args.settings.checkpoint && settings.checkpoint !== args.settings.checkpoint) {
      throw new ConvexError(`Checkpoint name not supported: ${args.settings.checkpoint}`);
    }
    const dropped = (args.settings.loras ?? []).find(
      (lora) => lora.name && !settings.loras.some((kept) => kept.name === lora.name),
    );
    if (dropped) throw new ConvexError(`LoRA name not supported: ${dropped.name}`);

    const inputs = settings.mode === "text" ? [] : (args.inputs ?? []);
    if (settings.mode === "frames") {
      const firsts = inputs.filter((input) => input.role === "first").length;
      const lasts = inputs.filter((input) => input.role === "last").length;
      if (firsts + lasts === 0) throw new ConvexError("Add a first frame, a last frame, or both");
      if (firsts > 1 || lasts > 1)
        throw new ConvexError("One first frame and one last frame at most");
      if (firsts + lasts !== inputs.length) {
        throw new ConvexError("LTX takes a first and/or last frame, not references");
      }
    }
    if (settings.mode === "sheet") {
      if (inputs.length !== 1 || inputs[0].role !== "reference") {
        throw new ConvexError("Reference sheet mode takes exactly one sheet image");
      }
    }

    const count = Math.round(args.count ?? 1);
    if (count < 1 || count > COMFY_MAX_COUNT) {
      throw new ConvexError(`Clips per request must be 1–${COMFY_MAX_COUNT}`);
    }
    const baseSeed = settings.seed === -1 ? randomSeed() : settings.seed;
    const batchId = count > 1 ? `${identity.subject}:${Date.now()}:${Math.random()}` : undefined;
    const ids: Id<"grokGenerations">[] = [];
    for (let index = 0; index < count; index++) {
      const now = Date.now();
      const leaseId = `${identity.subject}:${now}:${Math.random()}`;
      const id = await ctx.db.insert("grokGenerations", {
        userId: identity.subject,
        createdAt: now,
        prompt,
        searchablePrompt: prompt,
        mediaType: "video",
        status: "pending",
        duration: settings.durationSeconds,
        resolution: `${settings.width}×${settings.height}`,
        hasReferenceImage: inputs.length > 0,
        referenceStorageIds: inputs.length > 0 ? inputs.map((input) => input.storageId) : undefined,
        referenceSourceKeys:
          inputs.length > 0 ? inputs.map((input) => input.sourceKey ?? null) : undefined,
        h3InputRoles: inputs.length > 0 ? inputs.map((input) => input.role) : undefined,
        ltxSettings: { ...settings, prompt, seed: baseSeed + index },
        provider: "comfy",
        apiModel: settings.checkpoint,
        comfyBackendId: pinnedPod,
        generateAudio: settings.audio,
        batchId,
        dispatchedAt: now,
        progressStage: "queued",
        progressMessage: "Waiting for the video pod…",
        progressUpdatedAt: now,
        costUsd: 0,
        costEstimated: false,
        atlasPollLeaseId: leaseId,
        atlasPollLeaseUntil: now + COMFY_LEASE_MS,
        atlasWaitEndsAt: now + COMFY_TOTAL_WAIT_MS,
      });
      await ctx.scheduler.runAfter(0, internal.comfyVideoProcessor.run, {
        generationId: id,
        leaseId,
      });
      ids.push(id);
    }
    return ids[0];
  },
});

/** The Self-hosted video tab's grid — the same rows also appear in the API
 *  tab's history, search and favourites. */
export const list = query({
  args: { paginationOpts: paginationOptsValidator },
  handler: async (ctx, args) => {
    const identity = await allowedUserOrNull(ctx);
    if (!identity) return { page: [], isDone: true, continueCursor: "" };
    return await ctx.db
      .query("grokGenerations")
      .withIndex("by_user_provider_createdAt", (q) =>
        q.eq("userId", identity.subject).eq("provider", "comfy"),
      )
      .order("desc")
      .paginate(args.paginationOpts);
  },
});

export type ComfyLeaseRow = Pick<
  Doc<"grokGenerations">,
  "provider" | "status" | "atlasPollLeaseId" | "atlasPollLeaseUntil"
>;

/**
 * What a claim with `leaseId` would do to a row:
 *
 * - `lost`  — finished, deleted, not a self-hosted job, or a live lease that
 *   belongs to another action. The caller must stop.
 * - `held`  — this action owns it with more than COMFY_LEASE_RENEW_BELOW_MS
 *   left. Nothing to write.
 * - `renew` — this action may own it and should write the lease: a takeover
 *   of an expired lease, or its own lease running low (or already lapsed,
 *   which the rescue cron has not acted on yet).
 *
 * Ownership is exactly what it always was — the lease id, or an expired
 * lease — only the write is skipped while a held lease has time in hand.
 */
export function comfyLeaseDecision(
  row: ComfyLeaseRow | null,
  leaseId: string,
  now: number,
): "lost" | "held" | "renew" {
  if (!row || row.provider !== "comfy") return "lost";
  if (row.status !== "pending" && row.status !== "processing") return "lost";
  const until = row.atlasPollLeaseUntil ?? 0;
  if (row.atlasPollLeaseId !== leaseId) return until <= now ? "renew" : "lost";
  return until - now > COMFY_LEASE_RENEW_BELOW_MS ? "held" : "renew";
}

/**
 * Take or renew ownership of a job. Returns what the processor needs, or null
 * when the job is finished, gone, or owned by a live action. Writes only when
 * the lease changes hands or is due for renewal — see comfyLeaseDecision.
 */
export const claim = internalMutation({
  args: { id: v.id("grokGenerations"), leaseId: v.string() },
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.id);
    const now = Date.now();
    const decision = comfyLeaseDecision(row, args.leaseId, now);
    if (!row || decision === "lost") return null;
    if (decision === "renew") {
      await ctx.db.patch(args.id, {
        atlasPollLeaseId: args.leaseId,
        atlasPollLeaseUntil: now + COMFY_LEASE_MS,
      });
    }
    return row;
  },
});

/**
 * The processor's per-poll ownership check, read-only: `claim` is called only
 * when this answers `renew`, so a healthy poll loop writes nothing between
 * renewals and the grids that list the row are left alone.
 */
export const leaseStatus = internalQuery({
  args: { id: v.id("grokGenerations"), leaseId: v.string() },
  handler: async (ctx, args) =>
    comfyLeaseDecision(await ctx.db.get(args.id), args.leaseId, Date.now()),
});

/**
 * Picks the GPU a job renders on: the per-GPU ComfyUI with the fewest unfinished
 * jobs of this pod, written to the row in the same transaction — so four clips
 * queued in one click spread over four GPUs instead of all seeing an empty
 * queue and landing on the first. A job keeps the GPU it was given.
 */
export const assignInstance = internalMutation({
  args: {
    id: v.id("grokGenerations"),
    leaseId: v.string(),
    /** Every GPU the job may run on, across every video pod that has its models. */
    candidates: v.array(v.object({ backendId: v.id("runpodBackends"), url: v.string() })),
  },
  handler: async (ctx, args): Promise<{ backendId: Id<"runpodBackends">; url: string } | null> => {
    const row = await ctx.db.get(args.id);
    if (!row || row.atlasPollLeaseId !== args.leaseId || args.candidates.length === 0) return null;
    const kept = args.candidates.find(
      (candidate) => candidate.url === row.endpoint && candidate.backendId === row.comfyBackendId,
    );
    if (kept) return kept;
    // Unfinished jobs per GPU, across all pods: the next one goes to the least busy.
    const load = new Map(args.candidates.map((candidate) => [candidate.url, 0]));
    for (const status of ["pending", "processing"] as const) {
      const rows = await ctx.db
        .query("grokGenerations")
        .withIndex("by_provider_status_pollLease", (q) =>
          q.eq("provider", "comfy").eq("status", status),
        )
        .take(200);
      for (const other of rows) {
        if (other._id === row._id || other.endpoint === undefined) continue;
        const count = load.get(other.endpoint);
        if (count !== undefined) load.set(other.endpoint, count + 1);
      }
    }
    let chosen = args.candidates[0];
    for (const candidate of args.candidates) {
      if ((load.get(candidate.url) ?? 0) < (load.get(chosen.url) ?? 0)) chosen = candidate;
    }
    await ctx.db.patch(args.id, { endpoint: chosen.url, comfyBackendId: chosen.backendId });
    return chosen;
  },
});

/** Whether the row survives — tells "deleted" apart from "taken over". */
export const exists = internalQuery({
  args: { id: v.id("grokGenerations") },
  handler: async (ctx, args) => (await ctx.db.get(args.id)) !== null,
});

/** Durable record of the prompt id, written just before the POST that queues
 *  it: a killed action runs no catch block, and the next owner must poll this
 *  id rather than submit the job a second time. */
export const recordSubmit = internalMutation({
  args: {
    id: v.id("grokGenerations"),
    leaseId: v.string(),
    promptId: v.string(),
    clientId: v.string(),
    backendId: v.id("runpodBackends"),
    endpoint: v.string(),
  },
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.id);
    if (!row || row.atlasPollLeaseId !== args.leaseId) return false;
    await ctx.db.patch(args.id, {
      falRequestId: args.promptId,
      comfyClientId: args.clientId,
      comfyBackendId: args.backendId,
      endpoint: args.endpoint,
      comfyRun: mergeComfyRunStats(row.comfyRun, { submittedAt: Date.now() }),
    });
    return true;
  },
});

/**
 * Adds what a processor run learned about the job — node timings, execution
 * start and end, the GPU — to the row. Not lease-checked: a run that lost the
 * lease still saw real events, and the merge keeps the earliest of each.
 */
export const recordRun = internalMutation({
  args: { id: v.id("grokGenerations"), stats: comfyRunValidator },
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.id);
    if (!row || row.provider !== "comfy") return;
    await ctx.db.patch(args.id, { comfyRun: mergeComfyRunStats(row.comfyRun, args.stats) });
  },
});

/**
 * The pod a clip rendered on, for the lightbox's details panel. Backend rows
 * outlive their pods (destroyed, never deleted), so this answers for old clips
 * too. Which GPU of a multi-GPU pod is read off the ComfyUI the job was sent to
 * — matched against every GPU's URL, not `instanceUrls`, which leaves out the
 * ones that did not answer at boot and would shift the rest down a place.
 */
export const runDetails = query({
  // A string, like grokGenerations.get: an id that is not one reads as absent.
  args: { id: v.string() },
  handler: async (ctx, args) => {
    const identity = await allowedUserOrNull(ctx);
    if (!identity) return null;
    const id = ctx.db.normalizeId("grokGenerations", args.id);
    const row = id ? await ctx.db.get(id) : null;
    if (!row || row.userId !== identity.subject || !row.comfyBackendId) return null;
    const backend = await ctx.db.get(row.comfyBackendId);
    if (!backend) return null;
    const trim = (url: string) => url.replace(/\/+$/, "");
    const urls = (
      backend.podId ? runpodInstanceUrls(backend.podId, backend.numGpus) : [backend.publicUrl]
    ).map(trim);
    const gpuIndex = row.endpoint ? urls.indexOf(trim(row.endpoint)) : -1;
    return {
      gpuType: backend.gpuTypeId,
      gpuName: backend.gpuName,
      gpuCount: backend.numGpus,
      gpuIndex: gpuIndex >= 0 ? gpuIndex : undefined,
      cloudType: backend.cloudType,
      /** The whole pod's price, every GPU included. */
      hourlyUsd: backend.hourlyUsd,
      podId: backend.podId,
    };
  },
});

async function scheduleResume(ctx: MutationCtx, row: Doc<"grokGenerations">): Promise<boolean> {
  if (row.provider !== "comfy" || (row.status !== "pending" && row.status !== "processing")) {
    return false;
  }
  const leaseId = `${row._id}:${Date.now()}:${Math.random()}`;
  await ctx.db.patch(row._id, {
    atlasPollLeaseId: leaseId,
    // Short grace: if the scheduled action never starts, the cron re-arms it.
    atlasPollLeaseUntil: Date.now() + 60_000,
  });
  await ctx.scheduler.runAfter(0, internal.comfyVideoProcessor.run, {
    generationId: row._id,
    leaseId,
  });
  return true;
}

/** The processor's hand-off at the end of its time budget. */
export const resume = internalMutation({
  args: { id: v.id("grokGenerations"), leaseId: v.string() },
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.id);
    if (!row || row.atlasPollLeaseId !== args.leaseId) return false;
    return scheduleResume(ctx, row);
  },
});

/**
 * Re-arms jobs whose action vanished (platform kill, deploy) without handing
 * off. Polling an existing prompt id is safe to repeat; a job that never got
 * submitted is simply submitted by the next owner.
 */
export const rescue = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    let rescued = 0;
    for (const status of ["processing", "pending"] as const) {
      const rows = await ctx.db
        .query("grokGenerations")
        .withIndex("by_provider_status_pollLease", (q) =>
          q.eq("provider", "comfy").eq("status", status).lte("atlasPollLeaseUntil", now),
        )
        .take(50);
      for (const row of rows) {
        if (await scheduleResume(ctx, row)) rescued++;
      }
    }
    return rescued;
  },
});
