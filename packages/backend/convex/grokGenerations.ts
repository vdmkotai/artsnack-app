import { normalizeReferenceSourceKeys } from "../../shared/generation-references";
import { progressChanged } from "../../shared/comfyui-progress";
import { v } from "convex/values";
import {
  query,
  mutation,
  internalMutation,
  internalQuery,
  type MutationCtx,
} from "./_generated/server";
import { internal } from "./_generated/api";
import { paginationOptsValidator } from "convex/server";
import { Doc, Id } from "./_generated/dataModel";
import { allowedUserOrNull, requireAllowedUser } from "./authz";
import {
  GROK_VIDEO_EXTEND_DEFAULT_DURATION,
  GROK_VIDEO_SOURCE_RESOLUTIONS,
  VIDEO_COUNTS,
  getApiModel,
  higgsfieldVideoModel,
  imageAspectRatios,
  imageMaxReferences,
  isGrokVideoMode,
  isGrokVideoModelId,
  videoResolutions,
  type ApiModel,
  type ApiModelId,
  type GrokVideoMode,
  type VideoTier,
} from "../../shared/api-models";
import {
  grokVideoContext,
  grokVideoIssues,
  planGrokVideo,
  type GrokVideoInput,
} from "../../shared/grok-imagine";
import { isGrokSourceVideoKey } from "../../shared/image-key";
import { grokFrameRoleValidator } from "./schema";
import { imageCostUsd, videoCostUsd } from "../../shared/api-pricing";
import { buildHiggsfieldJob, costSignature } from "../../shared/higgsfield-job";
import { HIGGSFIELD_LIST_PRICE } from "../../shared/higgsfield-prices";
import { isUnbilledFailure } from "../../shared/fal-queue";
import { HIGGSFIELD_QUEUE_CEILING_MS, higgsfieldMaxConcurrent } from "./higgsfieldConfig";
import { isStalled, selectDispatchable } from "../../shared/higgsfield-queue";
import {
  ATLAS_RESUME_START_GRACE_MS,
  ATLAS_TOTAL_WAIT_MS,
  atlasCanClaimPoll,
  atlasNeedsPollRescue,
  atlasRecoveryDeadline,
} from "../../shared/atlas-lifecycle";

export const list = query({
  args: { paginationOpts: paginationOptsValidator },
  handler: async (ctx, args) => {
    const identity = await allowedUserOrNull(ctx);
    if (!identity) {
      return { page: [], isDone: true, continueCursor: "" };
    }

    return await ctx.db
      .query("grokGenerations")
      .withIndex("by_user_createdAt", (q) => q.eq("userId", identity.subject))
      .order("desc")
      .paginate(args.paginationOpts);
  },
});

/**
 * Full-text search over the API tab's own history.
 *
 * The `search_prompt` index has existed (and been billed for) since the table
 * was created, but nothing queried it: paid results were only reachable by
 * scrolling. Mirrors generations.searchByPrompt so both tabs behave the same.
 */
export const searchByPrompt = query({
  args: {
    query: v.string(),
    paginationOpts: paginationOptsValidator,
  },
  handler: async (ctx, args) => {
    const identity = await allowedUserOrNull(ctx);
    if (!identity) {
      return { page: [], isDone: true, continueCursor: "" };
    }

    return await ctx.db
      .query("grokGenerations")
      .withSearchIndex("search_prompt", (q) =>
        q.search("searchablePrompt", args.query).eq("userId", identity.subject),
      )
      .paginate(args.paginationOpts);
  },
});

/**
 * One generation, for reproducing its settings from another page.
 *
 * Returns null rather than throwing: the row may have been deleted since the
 * gallery tile was rendered, and that is a "settings unavailable" toast, not an
 * error page.
 */
export const get = query({
  // A string, not v.id: the id arrives from a URL the user can edit, and a
  // malformed one should read as "not found" rather than fail argument
  // validation and take the page down with it.
  args: { id: v.string() },
  handler: async (ctx, args) => {
    const identity = await allowedUserOrNull(ctx);
    if (!identity) return null;
    const id = ctx.db.normalizeId("grokGenerations", args.id);
    if (!id) return null;
    const generation = await ctx.db.get(id);
    if (!generation || generation.userId !== identity.subject) return null;
    return generation;
  },
});

/** Short-lived upload URL for the reference image (Convex file storage). */
export const generateRefUploadUrl = mutation({
  args: {},
  handler: async (ctx) => {
    await requireAllowedUser(ctx);
    return await ctx.storage.generateUploadUrl();
  },
});

/** Resolves the requested model, rejecting ids that aren't in the registry. */
function resolveModel(id: string | undefined): ApiModel {
  // Records predating the model switcher were all Grok.
  return getApiModel(id ?? "grok");
}

/**
 * Providers that charge for each job, as opposed to Grok's flat subscription.
 *
 * This is the discriminator both failure paths use to decide whether a dead row
 * keeps its pre-flight cost or is zeroed. It is a named helper rather than an
 * inline comparison because it has to be widened every time a paid provider is
 * added, and a missed site does not fail loudly — it silently reports real
 * spending as free.
 */
function billsPerJob(provider: string | undefined): boolean {
  return provider === "fal" || provider === "higgsfield" || provider === "atlas";
}

/** Each provider owns its own processor; the registry decides which one runs. */
function imageProcessorFor(model: ApiModel) {
  switch (model.provider) {
    case "grok":
      return internal.grokProcessor.processImage;
    case "higgsfield":
      return internal.higgsfieldProcessor.processImage;
    case "fal":
      return internal.falProcessor.processImage;
  }
}

function videoProcessorFor(model: ApiModel) {
  switch (model.provider) {
    case "grok":
      return internal.grokProcessor.processVideo;
    case "higgsfield":
      return internal.higgsfieldProcessor.processVideo;
    case "fal":
      return internal.falProcessor.processVideo;
  }
}

/**
 * Enough of a user's in-flight rows to count them. A user with more than this
 * many jobs at once is already far past any limit the dispatcher would allow.
 */
const QUEUE_SCAN_LIMIT = 200;

/**
 * Starts as many of a user's waiting Higgsfield jobs as the vendor will take at
 * once, oldest first.
 *
 * See `higgsfieldMaxConcurrent` for why the ceiling exists. Jobs above it are
 * inserted `pending` with no `dispatchedAt` and nothing scheduled — they are a
 * queue, and this is the only thing that drains it, so every path that frees a
 * slot has to call it: a job finishing, a job failing, and the sweeper.
 */
async function dispatchQueuedHiggsfield(ctx: MutationCtx, userId: string): Promise<void> {
  const unfinished = [];
  for (const status of ["pending", "processing"] as const) {
    unfinished.push(
      ...(await ctx.db
        .query("grokGenerations")
        .withIndex("by_user_status_createdAt", (q) => q.eq("userId", userId).eq("status", status))
        .take(QUEUE_SCAN_LIMIT)),
    );
  }

  for (const row of selectDispatchable(unfinished, higgsfieldMaxConcurrent())) {
    await ctx.db.patch(row._id, { dispatchedAt: Date.now() });
    await ctx.scheduler.runAfter(
      0,
      row.mediaType === "video"
        ? internal.higgsfieldProcessor.processVideo
        : internal.higgsfieldProcessor.processImage,
      { generationId: row._id, userId },
    );
  }
}

/**
 * Safety net for the queue.
 *
 * Every slot-freeing path drains it already, so this normally finds nothing.
 * It exists for the one case they cannot cover: if a dispatch is lost, the
 * queue has no other event coming to restart it, and the rows would sit
 * `pending` until the sweeper failed them for no reason at all.
 */
export const pumpHiggsfieldQueue = internalMutation({
  args: {},
  handler: async (ctx) => {
    const pending = await ctx.db
      .query("grokGenerations")
      .withIndex("by_status_createdAt", (q) => q.eq("status", "pending"))
      .take(QUEUE_SCAN_LIMIT);

    const users = new Set(
      pending
        .filter((row) => row.provider === "higgsfield" && row.dispatchedAt === undefined)
        .map((row) => row.userId),
    );
    for (const userId of users) {
      await dispatchQueuedHiggsfield(ctx, userId);
    }
    return users.size;
  },
});

/**
 * Last quoted credit cost for a Higgsfield configuration.
 *
 * Higgsfield publishes no rate card, so the figure comes from their own
 * `generate cost` — fetched by the client while the form is open and cached
 * here. Undefined on the very first use of a configuration; the real number is
 * written back when the job completes.
 */
async function cachedCredits(
  ctx: MutationCtx,
  model: ApiModelId,
  mediaType: "image" | "video",
  options: {
    aspectRatio?: string;
    sizeTier?: string;
    videoJobType?: string;
    videoMode?: string;
    /** Priced on Kling, so it belongs in the quote key. */
    generateAudio?: boolean;
    duration?: number;
    resolution?: string;
    referenceCount: number;
  },
): Promise<number | undefined> {
  const request = buildHiggsfieldJob({
    model,
    mediaType,
    prompt: "cost probe",
    aspectRatio: options.aspectRatio,
    sizeTier: options.sizeTier,
    videoJobType: options.videoJobType,
    mode: options.videoMode,
    generateAudio: options.generateAudio,
    durationSeconds: options.duration,
    resolution: options.resolution,
    referenceCount: options.referenceCount,
  });
  const signature = costSignature(request);
  const row = await ctx.db
    .query("higgsfieldCosts")
    .withIndex("by_signature", (q) => q.eq("signature", signature))
    .unique();
  // The captured rate card is the floor. A tile that has never been quoted
  // would otherwise carry no figure at all, and the real one is written back
  // from the vendor's own charge when the job finishes either way.
  return row?.credits ?? HIGGSFIELD_LIST_PRICE[signature];
}

export const startImage = mutation({
  args: {
    model: v.optional(v.string()),
    prompt: v.string(),
    aspectRatio: v.string(),
    count: v.number(),
    quality: v.string(),
    /** Size tier: "1k"/"2k" on Grok, "2K"/"3K"/"4K" on Seedream. */
    resolution: v.string(),
    referenceStorageIds: v.optional(v.array(v.id("_storage"))),
    referenceSourceKeys: v.optional(v.array(v.union(v.string(), v.null()))),
  },
  handler: async (ctx, args) => {
    const identity = await requireAllowedUser(ctx);

    const prompt = args.prompt.trim();
    if (!prompt) throw new Error("Prompt is required");

    const model = resolveModel(args.model);
    const caps = model.image;

    if (!caps.counts.includes(args.count)) {
      throw new Error(`${model.label} supports ${caps.counts.join(", ")} images per request`);
    }
    if (!caps.sizeTiers.some((tier) => tier.value === args.resolution)) {
      throw new Error(
        `${model.label} supports ${caps.sizeTiers.map((tier) => tier.label).join(", ")}`,
      );
    }

    const refs = args.referenceStorageIds ?? [];
    // Per quality on Grok: 2.0 takes five edit sources where the legacy pair
    // takes three.
    const maxReferences = imageMaxReferences(caps, args.quality);
    if (refs.length > maxReferences) {
      throw new Error(`${model.label} accepts at most ${maxReferences} reference images`);
    }

    if (caps.kind === "grok") {
      if (!caps.qualities.some((quality) => quality.value === args.quality)) {
        throw new Error(
          `Quality must be one of ${caps.qualities.map((quality) => quality.value).join(", ")}`,
        );
      }
      // 21:9 and 5:2 exist on 2.0 only.
      if (!imageAspectRatios(caps, args.quality).includes(args.aspectRatio)) {
        throw new Error(`Unsupported aspect ratio for this quality: ${args.aspectRatio}`);
      }
    } else if (caps.kind === "seedream") {
      // fal is sent explicit pixels, so the ratio must exist in the size table.
      // "auto" is resolved on the client, where the reference dimensions are known.
      if (!caps.ratioPixels[args.resolution]?.[args.aspectRatio]) {
        throw new Error(`Unsupported aspect ratio ${args.aspectRatio} at ${args.resolution}`);
      }
    } else if (!caps.aspectRatios.includes(args.aspectRatio)) {
      // Higgsfield derives the output size from the ratio alone.
      throw new Error(`Unsupported aspect ratio: ${args.aspectRatio}`);
    }

    // Providers bill in different units, so only one of the two is ever set.
    const costUsd =
      model.provider === "higgsfield"
        ? undefined
        : imageCostUsd({
            model: model.id,
            sizeTier: args.resolution,
            count: args.count,
            referenceCount: refs.length,
          });
    // Each Higgsfield job produces one image, so the stored figure is per job.
    const creditsUsed =
      model.provider === "higgsfield"
        ? await cachedCredits(ctx, model.id, "image", {
            aspectRatio: args.aspectRatio,
            sizeTier: args.resolution,
            referenceCount: refs.length,
          })
        : undefined;

    // Higgsfield declares no batch parameter, so several images means several
    // jobs. The others take a count and fan out on their own side.
    const jobs = model.provider === "higgsfield" ? args.count : 1;
    const perJobCount = model.provider === "higgsfield" ? 1 : args.count;
    // Siblings share one set of reference blobs, so they need to be identifiable
    // as a group before any of them can safely release them.
    const batchId = jobs > 1 ? `${identity.subject}:${Date.now()}:${Math.random()}` : undefined;

    // Higgsfield rows are inserted un-dispatched and started by the queue, which
    // is what keeps a second click from putting sixteen jobs on their side at
    // once. Every other provider starts immediately, as it always has.
    const queued = model.provider === "higgsfield";

    const ids = [];
    for (let index = 0; index < jobs; index++) {
      const id = await ctx.db.insert("grokGenerations", {
        userId: identity.subject,
        createdAt: Date.now(),
        prompt,
        searchablePrompt: prompt,
        mediaType: "image",
        status: "pending",
        aspectRatio: args.aspectRatio,
        count: perJobCount,
        quality: args.quality,
        resolution: args.resolution,
        hasReferenceImage: refs.length > 0,
        referenceStorageIds: refs.length > 0 ? refs : undefined,
        referenceSourceKeys: normalizeReferenceSourceKeys(args.referenceSourceKeys, refs.length),
        provider: model.provider,
        apiModel: model.id,
        batchId,
        dispatchedAt: queued ? undefined : Date.now(),
        progressStage: "queued",
        progressUpdatedAt: Date.now(),
        // Priced up front so a queued tile can show a figure before the vendor replies.
        costUsd,
        creditsUsed,
        // Grok is covered by the subscription: its zero is exact, not a guess.
        costEstimated: model.provider !== "grok",
      });
      if (!queued) {
        await ctx.scheduler.runAfter(0, imageProcessorFor(model), {
          generationId: id,
          userId: identity.subject,
        });
      }
      ids.push(id);
    }

    if (queued) await dispatchQueuedHiggsfield(ctx, identity.subject);

    return ids[0];
  },
});

export const startVideo = mutation({
  args: {
    model: v.optional(v.string()),
    prompt: v.string(),
    duration: v.number(),
    resolution: v.string(),
    aspectRatio: v.optional(v.string()),
    videoTier: v.optional(v.string()),
    videoJobType: v.optional(v.string()),
    videoMode: v.optional(v.string()),
    generateAudio: v.optional(v.boolean()),
    bitrateMode: v.optional(v.string()),
    /** Clips to produce. Optional so older clients keep working. */
    count: v.optional(v.number()),
    referenceStorageIds: v.optional(v.array(v.id("_storage"))),
    referenceSourceKeys: v.optional(v.array(v.union(v.string(), v.null()))),
    /** Grok only: preset voice ids the clip's subjects speak with. */
    referenceVoices: v.optional(v.array(v.string())),
    /**
     * Grok only, and optional so shipped clients keep working: "generate",
     * "edit" or "extend". Absent ⇒ generate.
     */
    grokVideoMode: v.optional(v.string()),
    /** Grok generate: grok-imagine-video-1.5 or -1.5-lite. Absent ⇒ 1.5. */
    grokVideoModel: v.optional(v.string()),
    /** Grok 1.5: each reference's role, in reference order; null is automatic. */
    frameRoles: v.optional(v.array(v.union(v.null(), grokFrameRoleValidator))),
    /** Grok edit/extend: the source clip's B2 key, and its measured length. */
    sourceVideoKey: v.optional(v.string()),
    sourceVideoSeconds: v.optional(v.number()),
    /** Grok extend: seconds to add (2–10). `duration` stays the Generate length. */
    extendDuration: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const identity = await requireAllowedUser(ctx);

    const prompt = args.prompt.trim();
    if (!prompt) throw new Error("Prompt is required");

    // No video model here takes a batch parameter, so this is our own fan-out
    // and the ceiling is ours to enforce: each clip is a separate job billed in
    // full, and an unbounded count is an unbounded charge.
    const jobs = args.count ?? 1;
    if (!VIDEO_COUNTS.includes(jobs as (typeof VIDEO_COUNTS)[number])) {
      throw new Error(`Videos per request must be one of ${VIDEO_COUNTS.join(", ")}`);
    }

    const model = resolveModel(args.model);
    const caps = model.video;

    // --- Grok's own surface: mode, model, roles, source clip ---
    // Parsed before anything generic, because Edit and Extend have no duration,
    // ratio or resolution of their own and the generic checks below would
    // refuse a perfectly good edit for lacking them.
    if (args.grokVideoMode !== undefined && !isGrokVideoMode(args.grokVideoMode)) {
      throw new Error(`Unknown Grok video mode: ${args.grokVideoMode}`);
    }
    if (args.grokVideoModel !== undefined && !isGrokVideoModelId(args.grokVideoModel)) {
      throw new Error(`Unknown Grok video model: ${args.grokVideoModel}`);
    }
    const grokMode: GrokVideoMode = (args.grokVideoMode as GrokVideoMode | undefined) ?? "generate";
    const usesGrokSurface =
      grokMode !== "generate" ||
      args.grokVideoModel !== undefined ||
      (args.frameRoles?.length ?? 0) > 0 ||
      args.sourceVideoKey !== undefined;
    if (caps.kind !== "grok" && usesGrokSurface) {
      throw new Error(`${model.label} has no Grok video modes, roles or source clips`);
    }
    const grokEditing = caps.kind === "grok" && grokMode !== "generate";
    const grokInput: GrokVideoInput | null =
      caps.kind === "grok"
        ? {
            mode: grokMode,
            model: args.grokVideoModel,
            referenceCount: args.referenceStorageIds?.length ?? 0,
            frameRoles: args.frameRoles,
            voiceCount: args.referenceVoices?.length ?? 0,
            duration: args.duration,
            extendDuration: args.extendDuration,
            source: args.sourceVideoKey === undefined ? null : { seconds: args.sourceVideoSeconds },
            prompt,
          }
        : null;
    const grokPlan = grokInput ? planGrokVideo(grokInput) : null;
    if (grokInput) {
      if (args.sourceVideoKey !== undefined && !grokEditing) {
        throw new Error("A source video only belongs to Grok's Edit and Extend");
      }
      if (args.sourceVideoKey !== undefined && !isGrokSourceVideoKey(args.sourceVideoKey)) {
        throw new Error("The source video must be an mp4 from your results or an upload");
      }
      if (grokEditing && (args.referenceStorageIds?.length ?? 0) > 0) {
        throw new Error("Grok's Edit and Extend take no reference images");
      }
      if (grokEditing && (args.referenceVoices?.length ?? 0) > 0) {
        throw new Error("Grok's Edit and Extend take no voices");
      }
      if (grokPlan && !grokPlan.usesVoices && (args.referenceVoices?.length ?? 0) > 0) {
        throw new Error("Grok 1.5 Lite has no preset voices");
      }
      // The same list the form shows and the payload builder throws on.
      const issue = grokVideoIssues(grokInput)[0];
      if (issue) throw new Error(issue);
      if (grokEditing && !GROK_VIDEO_SOURCE_RESOLUTIONS.includes(args.resolution as "720p")) {
        throw new Error(
          `An edited or extended clip follows its source, capped at 720p — not ${args.resolution}`,
        );
      }
    }

    let tier: VideoTier | undefined;
    if (caps.kind === "seedance") {
      tier = (args.videoTier as VideoTier | undefined) ?? caps.defaultTier;
      if (!caps.tiers.includes(tier)) throw new Error(`Unknown video tier: ${args.videoTier}`);
    }

    // Higgsfield's video models differ in ratios, resolutions, modes and how
    // many references they take, so the aggregate caps are not a validator.
    const hfVideo =
      caps.kind === "higgsfield-video"
        ? higgsfieldVideoModel(caps, args.videoJobType ?? caps.defaultJobType)
        : null;
    if (caps.kind === "higgsfield-video" && args.videoJobType) {
      if (!caps.models.some((entry) => entry.jobType === args.videoJobType)) {
        throw new Error(`Unknown video model: ${args.videoJobType}`);
      }
    }
    if (hfVideo?.modeParam && args.videoMode) {
      if (!hfVideo.modeParam.values.includes(args.videoMode)) {
        throw new Error(`${hfVideo.label} does not support mode ${args.videoMode}`);
      }
    }

    // Per selected model, not the aggregate: Wan reaches 2s and Kling 3s, and
    // the form offers those — rejecting them here with the union of every
    // model's lengths would refuse a legal choice under the wrong model's name.
    const allowedDurations = hfVideo?.durations ?? caps.durations;
    // Edit has no length of its own and Extend's is `extendDuration`, both
    // checked above; `duration` is only the Generate length there.
    if (!grokEditing && !allowedDurations.includes(args.duration)) {
      throw new Error(
        `${hfVideo?.label ?? model.label} supports ${allowedDurations.join(", ")} second clips`,
      );
    }

    const refs = args.referenceStorageIds ?? [];

    // Preset voices are a Grok-only concept, validated against the roster the
    // endpoint itself publishes — an unknown id would be a 400 at generation
    // time, long after the click.
    const voices = args.referenceVoices ?? [];
    if (voices.length > 0) {
      if (caps.kind !== "grok") {
        throw new Error(`${model.label} does not accept preset voices`);
      }
      if (voices.length > caps.maxVoices) {
        throw new Error(`${model.label} accepts at most ${caps.maxVoices} voices`);
      }
      const unknown = voices.filter((voice) => !caps.voices.includes(voice));
      if (unknown.length > 0) {
        throw new Error(`Unknown voice${unknown.length === 1 ? "" : "s"}: ${unknown.join(", ")}`);
      }
    }

    // Reference count is an input here because Grok's 1080p depends on it: the
    // endpoint refuses that resolution for reference-to-video, which is the
    // two-or-more-references path — and any voice makes the job
    // reference-to-video too. Same function the form filters its options
    // with, so the server cannot disagree with what was on screen.
    const allowedResolutions = videoResolutions(
      caps,
      tier,
      args.videoJobType,
      args.videoMode,
      refs.length,
      voices.length,
      // Pinned frames make a Grok job reference-to-video as surely as a second
      // reference does; Edit and Extend answer no list at all.
      grokInput ? grokVideoContext(grokInput) : undefined,
    );
    if (allowedResolutions.length > 0 && !allowedResolutions.includes(args.resolution)) {
      throw new Error(
        `${args.resolution} is not available here — choose ${allowedResolutions.join(", ")}`,
      );
    }
    // Frame-slot models take one media input per slot; a reference list is a
    // Seedance-only concept and repeating --start-image is a vendor rejection.
    const maxRefs = hfVideo
      ? hfVideo.supportsReferences
        ? hfVideo.maxReferences
        : (hfVideo.supportsStartFrame ? 1 : 0) + (hfVideo.supportsEndFrame ? 1 : 0)
      : caps.kind === "grok" && grokEditing
        ? 0
        : caps.maxReferences;
    if (refs.length > maxRefs) {
      const label = hfVideo?.label ?? model.label;
      throw new Error(
        maxRefs === 0
          ? `${label} does not accept reference images`
          : `${label} accepts at most ${maxRefs} reference image${maxRefs === 1 ? "" : "s"}`,
      );
    }
    // Text-to-video and reference-to-video (2+) need an explicit ratio;
    // single-image animation derives it from the input frame. On Grok the
    // plan decides: a pinned first frame or a source clip sets the shape.
    const needsRatio = grokPlan ? grokPlan.usesAspectRatio : refs.length !== 1;
    if (needsRatio && !args.aspectRatio) {
      throw new Error("Aspect ratio is required");
    }
    const allowedRatios = hfVideo?.aspectRatios ?? caps.aspectRatios;
    // A ratio a Grok request will not send is not checked — older clients send
    // the form's ratio whatever the shape. Every other provider checks it
    // whenever it arrives, as before.
    const checksRatio = grokPlan ? needsRatio : true;
    if (checksRatio && args.aspectRatio && !allowedRatios.includes(args.aspectRatio)) {
      throw new Error(`${hfVideo?.label ?? model.label} does not support ${args.aspectRatio}`);
    }

    // Providers bill in different units, so only one of the two is ever set.
    const costUsd =
      model.provider === "higgsfield"
        ? undefined
        : videoCostUsd({
            model: model.id,
            tier,
            resolution: args.resolution,
            durationSeconds: args.duration,
          });
    const creditsUsed =
      model.provider === "higgsfield"
        ? await cachedCredits(ctx, model.id, "video", {
            aspectRatio: refs.length === 1 ? undefined : args.aspectRatio,
            videoJobType: args.videoJobType,
            videoMode: args.videoMode,
            generateAudio:
              caps.kind === "seedance" || hfVideo?.audioParam
                ? (args.generateAudio ?? true)
                : undefined,
            duration: args.duration,
            resolution: args.resolution,
            referenceCount: refs.length,
          })
        : undefined;

    // Siblings share one set of reference blobs, so they need to be identifiable
    // as a group before any of them can safely release them.
    const batchId = jobs > 1 ? `${identity.subject}:${Date.now()}:${Math.random()}` : undefined;

    // Same queue as the image path — a clip is a job like any other on their side.
    const queued = model.provider === "higgsfield";

    const ids = [];
    for (let index = 0; index < jobs; index++) {
      const id = await ctx.db.insert("grokGenerations", {
        userId: identity.subject,
        createdAt: Date.now(),
        prompt,
        searchablePrompt: prompt,
        mediaType: "video",
        status: "pending",
        // A ratio the request does not send is not stored: a pinned first
        // frame or a source clip decided the shape, not this field.
        aspectRatio: grokPlan && !grokPlan.usesAspectRatio ? undefined : args.aspectRatio,
        // What the request's `duration` said: the clip's length, an
        // extension's, or — for an edit — nothing.
        duration:
          grokPlan?.mode === "edit"
            ? undefined
            : grokPlan?.mode === "extend"
              ? (args.extendDuration ?? GROK_VIDEO_EXTEND_DEFAULT_DURATION)
              : args.duration,
        resolution: args.resolution,
        hasReferenceImage: refs.length > 0,
        referenceStorageIds: refs.length > 0 ? refs : undefined,
        referenceSourceKeys: normalizeReferenceSourceKeys(args.referenceSourceKeys, refs.length),
        referenceVoices: voices.length > 0 ? voices : undefined,
        grokVideoModel: grokPlan?.model,
        grokVideoMode: grokPlan && grokPlan.mode !== "generate" ? grokPlan.mode : undefined,
        // Resolved, so reproducing the row cannot drift if the automatic rule
        // ever changes. Lite has no roles to keep.
        grokFrameRoles:
          grokPlan && grokPlan.usesFrameRoles && grokPlan.roles.length > 0
            ? grokPlan.roles
            : undefined,
        sourceVideoKey: grokEditing ? args.sourceVideoKey : undefined,
        sourceVideoSeconds: grokEditing ? args.sourceVideoSeconds : undefined,
        provider: model.provider,
        apiModel: model.id,
        videoTier: tier,
        videoJobType: caps.kind === "higgsfield-video" ? args.videoJobType : undefined,
        videoMode: caps.kind === "higgsfield-video" ? args.videoMode : undefined,
        // Only stored where it is actually sent — Wan and Happy Horse have no
        // audio parameter at all, and recording one would be a data lie.
        generateAudio:
          caps.kind === "seedance" || hfVideo?.audioParam
            ? (args.generateAudio ?? true)
            : undefined,
        bitrateMode:
          caps.kind === "seedance" && caps.bitrateModeByTier[tier!] && args.bitrateMode === "high"
            ? "high"
            : undefined,
        batchId,
        dispatchedAt: queued ? undefined : Date.now(),
        progressStage: "queued",
        progressUpdatedAt: Date.now(),
        // One clip per row, so both figures stay per job and the results total
        // is a sum rather than a multiple counted twice.
        costUsd,
        creditsUsed,
        // Grok is covered by the subscription: its zero is exact, not a guess.
        costEstimated: model.provider !== "grok",
      });

      if (!queued) {
        await ctx.scheduler.runAfter(0, videoProcessorFor(model), {
          generationId: id,
          userId: identity.subject,
        });
      }
      ids.push(id);
    }

    if (queued) await dispatchQueuedHiggsfield(ctx, identity.subject);

    return ids[0];
  },
});

/**
 * Deletes one generation, at any stage.
 *
 * An unfinished row can go too. Nothing here cancels the work — the vendor has
 * it, and on Higgsfield there is no way to take it back — so this is honestly
 * just "take it off my screen", and the internal mutations the processor
 * reports through all tolerate the row having vanished underneath them.
 */
export const remove = mutation({
  args: { id: v.id("grokGenerations") },
  handler: async (ctx, args) => {
    const identity = await requireAllowedUser(ctx);

    const generation = await ctx.db.get(args.id);
    if (!generation || generation.userId !== identity.subject) {
      throw new Error("Generation not found");
    }

    await deleteGeneration(ctx, identity.subject, generation);

    // Deleting a running job frees its slot as surely as finishing one does.
    if (generation.provider === "higgsfield") {
      await dispatchQueuedHiggsfield(ctx, identity.subject);
    }
  },
});

/** Enough for any selection a page of results can hold, small enough for one transaction. */
const MAX_BULK_REMOVE = 200;

/**
 * The results grid's multi-select delete: `remove`, for many rows in one
 * transaction, so a call either deletes all of its rows or none. The client
 * splits a selection larger than the cap into several calls.
 *
 * A row that is already gone — deleted in another tab, or swept by
 * `removeAllFailed` — is skipped rather than failing the batch; the count it
 * returns is what was actually deleted. A row belonging to someone else is
 * skipped the same way, which reveals nothing `remove` would not.
 */
export const removeMany = mutation({
  args: { ids: v.array(v.id("grokGenerations")) },
  handler: async (ctx, args) => {
    const identity = await requireAllowedUser(ctx);
    if (args.ids.length > MAX_BULK_REMOVE) {
      throw new Error(`Delete at most ${MAX_BULK_REMOVE} generations at a time`);
    }

    let removed = 0;
    let freedHiggsfield = false;
    for (const id of new Set(args.ids)) {
      const generation = await ctx.db.get(id);
      if (!generation || generation.userId !== identity.subject) continue;
      await deleteGeneration(ctx, identity.subject, generation);
      if (generation.provider === "higgsfield") freedHiggsfield = true;
      removed++;
    }

    // Once, after the loop: the dispatcher fills every free slot it finds.
    if (freedHiggsfield) await dispatchQueuedHiggsfield(ctx, identity.subject);
    return removed;
  },
});

async function deleteGeneration(
  ctx: MutationCtx,
  userId: string,
  generation: Doc<"grokGenerations">,
): Promise<void> {
  // Sibling-aware, which matters now that in-flight rows are deletable: a
  // fan-out shares one set of reference blobs, and deleting the tile of a job
  // still running would otherwise pull the images out from under the rest of
  // its batch mid-generation.
  await releaseReferences(ctx, generation);
  await removeFavoritesFor(ctx, userId, generation);
  // A self-hosted clip still in the pod's queue would keep the hourly-billed
  // GPU busy for minutes after its tile is gone — take it off the pod too.
  if (
    generation.provider === "comfy" &&
    generation.falRequestId &&
    (generation.status === "pending" || generation.status === "processing")
  ) {
    await ctx.scheduler.runAfter(0, internal.comfyVideoProcessor.cancelOnPod, {
      promptId: generation.falRequestId,
      // The GPU's own ComfyUI on a multi-GPU pod; absent on older rows.
      endpoint: generation.endpoint,
    });
  }
  // B2 objects are left in place, matching generations.removeImages — the
  // bucket lifecycle rules handle cleanup.
  await ctx.db.delete(generation._id);
}

/**
 * Drops any favorites pointing at a generation being deleted.
 *
 * The favorite is the only thing that keeps a deleted row on screen: without
 * this the Favorites page holds a tile whose media type it can no longer read,
 * so a clip renders as a broken still and Reproduce leads nowhere.
 */
async function removeFavoritesFor(
  ctx: MutationCtx,
  userId: string,
  generation: { b2Key?: string; b2Keys?: string[] },
): Promise<void> {
  const keys = generation.b2Keys?.length
    ? generation.b2Keys
    : generation.b2Key
      ? [generation.b2Key]
      : [];
  for (const b2Key of keys) {
    const favorite = await ctx.db
      .query("favorites")
      .withIndex("by_user_key", (q) => q.eq("userId", userId).eq("b2Key", b2Key))
      .first();
    if (favorite) await ctx.db.delete(favorite._id);
  }
}

/**
 * Clears out failed tiles in one press.
 *
 * Deliberately leaves behind anything that was actually charged for. `markFailed`
 * keeps `costUsd`/`creditsUsed` on a fal or Higgsfield job that failed *after*
 * the vendor accepted it, and the results header sums failed rows into the
 * displayed spend — so deleting them would quietly reduce our own record of
 * money already gone. A tile that cost nothing carries no such record, and
 * removing a single billed row stays available per tile as an explicit act.
 *
 * Timeouts are the exception, and they are why this button looked broken. We
 * never learned whether a timed-out job was charged, so the figure it carries is
 * the pre-flight guess and nothing more — not a record of money gone. Keeping
 * them made a tile the sweeper had itself just created permanently immune to the
 * one button whose whole job is to clear such tiles.
 */
export const removeAllFailed = mutation({
  args: {},
  handler: async (ctx) => {
    const identity = await requireAllowedUser(ctx);

    const failed = await ctx.db
      .query("grokGenerations")
      .withIndex("by_user_status_createdAt", (q) =>
        q.eq("userId", identity.subject).eq("status", "failed"),
      )
      .collect();

    let removed = 0;
    for (const generation of failed) {
      const billed = (generation.costUsd ?? 0) > 0 || (generation.creditsUsed ?? 0) > 0;
      if (billed && generation.errorKind !== "timeout") continue;
      // Via releaseReferences, not a direct delete: a fan-out shares one set of
      // reference blobs, and sweeping the first sibling used to destroy them
      // for the rest, which then failed with "Reference image not found".
      await releaseReferences(ctx, generation);
      if (generation.referenceStorageId) {
        await ctx.storage.delete(generation.referenceStorageId).catch(() => {});
      }
      await removeFavoritesFor(ctx, identity.subject, generation);
      await ctx.db.delete(generation._id);
      removed++;
    }

    return removed;
  },
});

// ---------------------------------------------------------------------------
// Internal helpers for the processor action.
// ---------------------------------------------------------------------------

export const getByIdInternal = internalQuery({
  args: { id: v.id("grokGenerations") },
  handler: async (ctx, args) => {
    return await ctx.db.get(args.id);
  },
});

/**
 * Every report from a processor has to survive its row being deleted.
 *
 * An unfinished generation can now be dismissed from the grid while its action
 * is still running, and `patch` on a missing id throws — which would turn a
 * deliberate deletion into a failed action and a scheduler retry.
 */
async function stillExists(ctx: MutationCtx, id: Id<"grokGenerations">): Promise<boolean> {
  return (await ctx.db.get(id)) !== null;
}

export const markProcessing = internalMutation({
  args: { id: v.id("grokGenerations") },
  handler: async (ctx, args) => {
    const generation = await ctx.db.get(args.id);
    if (!generation) return;
    await ctx.db.patch(args.id, {
      status: "processing",
      progressStage: generation.provider === "higgsfield" ? "generating" : "preparing",
      progressMessage: undefined,
      progressCurrent: undefined,
      progressTotal: undefined,
      queuePosition: undefined,
      providerStatus: undefined,
      progressUpdatedAt: Date.now(),
    });
  },
});

export const updateProgress = internalMutation({
  args: {
    id: v.id("grokGenerations"),
    stage: v.string(),
    message: v.optional(v.string()),
    current: v.optional(v.number()),
    total: v.optional(v.number()),
    queuePosition: v.optional(v.number()),
    providerStatus: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const generation = await ctx.db.get(args.id);
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
    // A report that changes nothing on the card is not written: every write
    // re-runs each grid listing the row and pushes its page to every client.
    // `progressUpdatedAt` alone is no reason to write — nothing reads it (the
    // stalled sweeper measures from `dispatchedAt`/`createdAt`).
    if (!progressChanged(generation, progress)) return;
    await ctx.db.patch(args.id, { ...progress, progressUpdatedAt: Date.now() });
  },
});

/**
 * Releases the Convex blobs backing a generation's references — but only once
 * every sibling of the same fan-out has finished with them.
 *
 * A batch shares one set of storage ids. The first job to finish used to delete
 * them, and a slower sibling then failed with "Reference image not found in
 * storage" — and, because that error carries no vendor verdict, was recorded as
 * billed work.
 */
async function releaseReferences(
  ctx: MutationCtx,
  generation: {
    _id: Id<"grokGenerations">;
    batchId?: string;
    referenceStorageId?: Id<"_storage">;
    referenceStorageIds?: Id<"_storage">[];
  },
): Promise<void> {
  if (generation.batchId) {
    const siblings = await ctx.db
      .query("grokGenerations")
      .withIndex("by_batch", (q) => q.eq("batchId", generation.batchId))
      .collect();
    const stillWorking = siblings.some(
      (row) =>
        row._id !== generation._id && (row.status === "pending" || row.status === "processing"),
    );
    if (stillWorking) return;
  }

  for (const storageId of generation.referenceStorageIds ?? []) {
    await ctx.storage.delete(storageId).catch(() => {});
  }
  if (generation.referenceStorageId) {
    await ctx.storage.delete(generation.referenceStorageId).catch(() => {});
  }
}

export const markCompleted = internalMutation({
  args: {
    id: v.id("grokGenerations"),
    b2Keys: v.array(v.string()),
    referenceB2Keys: v.optional(v.array(v.string())),
    /** Replaces the pre-flight estimate once the real output size is known. */
    costUsd: v.optional(v.number()),
    /** Actual credits reported by Higgsfield for the finished job. */
    creditsUsed: v.optional(v.number()),
    costEstimated: v.optional(v.boolean()),
    /** Grok: the quota xAI reported for the job (USD), when it reported one. */
    meteredUsd: v.optional(v.number()),
    /**
     * A completed row can still carry a note: a fan-out that produced fewer
     * images than requested records why here, and the grid shows the shortfall
     * instead of quietly presenting one image as the whole answer.
     */
    error: v.optional(v.string()),
    /** Self-hosted video: settle only while this lease still owns the row, so
     *  an action that lost it cannot overwrite the new owner's result. */
    leaseId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const generation = await ctx.db.get(args.id);
    // Dismissed from the grid while it ran. The output is already in B2 and is
    // left there for the bucket lifecycle, exactly as a normal delete leaves it.
    if (!generation) return;
    if (args.leaseId !== undefined && generation.atlasPollLeaseId !== args.leaseId) return;
    await releaseReferences(ctx, generation);

    await ctx.db.patch(args.id, {
      status: "completed",
      completedAt: Date.now(),
      b2Keys: args.b2Keys,
      referenceB2Keys: args.referenceB2Keys,
      // Absent clears a stale error from a retried run; present records a
      // partial shortfall on an otherwise completed row.
      error: args.error,
      referenceStorageId: undefined,
      referenceStorageIds: undefined,
      atlasPollLeaseId: undefined,
      atlasPollLeaseUntil: undefined,
      atlasWaitEndsAt: undefined,
      progressStage: undefined,
      progressMessage: undefined,
      progressCurrent: undefined,
      progressTotal: undefined,
      queuePosition: undefined,
      providerStatus: undefined,
      progressUpdatedAt: undefined,
      // Omitted when unmeasurable, so the estimate written at creation stands.
      ...(args.costUsd !== undefined ? { costUsd: args.costUsd } : {}),
      ...(args.creditsUsed !== undefined ? { creditsUsed: args.creditsUsed } : {}),
      ...(args.costEstimated !== undefined ? { costEstimated: args.costEstimated } : {}),
      ...(args.meteredUsd !== undefined ? { meteredUsd: args.meteredUsd } : {}),
    });

    // After the patch, never before: the row being finished still counts against
    // the limit until it is out of `processing`, and starting the next job while
    // it does would let the queue drift one over on every hand-off.
    if (generation.provider === "higgsfield") {
      await dispatchQueuedHiggsfield(ctx, generation.userId);
    }
  },
});

/** Records the queue id as soon as fal accepts the job, so an in-flight
 *  generation can be traced (or cancelled) from the fal dashboard. */
export const recordFalRequest = internalMutation({
  args: {
    id: v.id("grokGenerations"),
    falRequestId: v.string(),
    endpoint: v.string(),
  },
  handler: async (ctx, args) => {
    if (!(await stillExists(ctx, args.id))) return;
    await ctx.db.patch(args.id, {
      falRequestId: args.falRequestId,
      endpoint: args.endpoint,
    });
  },
});

/**
 * Persists everything a watchdog needs before the first long poll begins.
 * A platform-level action failure runs no catch block, so scheduler arguments
 * alone are not durable enough to recover a paid prediction.
 */
export const recordAtlasRequest = internalMutation({
  args: {
    id: v.id("grokGenerations"),
    requestId: v.string(),
    endpoint: v.string(),
    referenceB2Keys: v.array(v.string()),
    leaseId: v.string(),
    leaseUntil: v.number(),
    waitEndsAt: v.number(),
  },
  handler: async (ctx, args) => {
    if (!(await stillExists(ctx, args.id))) return;
    await ctx.db.patch(args.id, {
      falRequestId: args.requestId,
      endpoint: args.endpoint,
      referenceB2Keys: args.referenceB2Keys,
      atlasPollLeaseId: args.leaseId,
      atlasPollLeaseUntil: args.leaseUntil,
      atlasWaitEndsAt: args.waitEndsAt,
    });
  },
});

/** Claims or renews one Atlas poll lease without racing another action. */
export const claimAtlasPoll = internalMutation({
  args: {
    id: v.id("grokGenerations"),
    requestId: v.string(),
    leaseId: v.string(),
    leaseUntil: v.number(),
  },
  handler: async (ctx, args) => {
    const generation = await ctx.db.get(args.id);
    if (!generation || generation.falRequestId !== args.requestId) return false;
    if (!atlasCanClaimPoll(generation, args.leaseId, Date.now())) return false;
    await ctx.db.patch(args.id, {
      atlasPollLeaseId: args.leaseId,
      atlasPollLeaseUntil: args.leaseUntil,
    });
    return true;
  },
});

export type AtlasResumeArgs = {
  generationId: Id<"grokGenerations">;
  media: "image" | "video";
  requestId: string;
  referenceB2Keys: string[];
  waitEndsAt: number;
};

/** Atomically reserves and schedules the next owner of an Atlas prediction. */
export async function scheduleAtlasResume(
  ctx: MutationCtx,
  args: AtlasResumeArgs,
): Promise<boolean> {
  const generation = await ctx.db.get(args.generationId);
  if (
    !generation ||
    generation.status !== "processing" ||
    generation.provider !== "atlas" ||
    generation.falRequestId !== args.requestId
  ) {
    return false;
  }

  const leaseId = `${generation._id}:${Date.now()}:${Math.random()}`;
  await ctx.db.patch(generation._id, {
    atlasPollLeaseId: leaseId,
    atlasPollLeaseUntil: Date.now() + ATLAS_RESUME_START_GRACE_MS,
  });
  await ctx.scheduler.runAfter(0, internal.atlasProcessor.resume, { ...args, leaseId });
  return true;
}

export const enqueueAtlasResume = internalMutation({
  args: {
    generationId: v.id("grokGenerations"),
    media: v.union(v.literal("image"), v.literal("video")),
    requestId: v.string(),
    referenceB2Keys: v.array(v.string()),
    waitEndsAt: v.number(),
  },
  handler: async (ctx, args) => await scheduleAtlasResume(ctx, args),
});

/**
 * Re-arms Atlas predictions whose action vanished before it could schedule its
 * successor. Convex intentionally does not retry actions because their side
 * effects are unknown; polling by an existing prediction id is safe to retry.
 */
export const rescueAtlasPolling = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    const processing = await ctx.db
      .query("grokGenerations")
      .withIndex("by_provider_status_pollLease", (q) =>
        q.eq("provider", "atlas").eq("status", "processing").lte("atlasPollLeaseUntil", now),
      )
      .take(100);
    let rescued = 0;

    for (const generation of processing) {
      if (!atlasNeedsPollRescue(generation, now) || !generation.falRequestId) continue;
      const scheduled = await scheduleAtlasResume(ctx, {
        generationId: generation._id,
        media: generation.mediaType,
        requestId: generation.falRequestId,
        referenceB2Keys: generation.referenceB2Keys ?? [],
        waitEndsAt: atlasRecoveryDeadline(generation, ATLAS_TOTAL_WAIT_MS),
      });
      if (scheduled) rescued++;
    }

    return rescued;
  },
});

export const markFailed = internalMutation({
  args: {
    id: v.id("grokGenerations"),
    error: v.string(),
    /** FalError kind, when the failure came from fal. Drives both the UI's
     *  handling and whether the generation was actually billed. */
    errorKind: v.optional(v.string()),
    /**
     * Whether the vendor charged for this attempt, when the processor knows.
     *
     * Absent means "work it out from the error kind", which is what the three
     * older providers do. Atlas sets it explicitly, because its failures cannot
     * be classified by kind alone — see the comment on `unbilled` below.
     */
    billed: v.optional(v.boolean()),
    /** See markCompleted. */
    leaseId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const generation = await ctx.db.get(args.id);
    // Dismissed from the grid while it ran; there is nothing left to mark, and
    // the slot it held was already handed on by `remove`.
    if (!generation) return;
    if (args.leaseId !== undefined && generation.atlasPollLeaseId !== args.leaseId) return;

    // Only a job the vendor refused outright — bad key, empty balance, rejected
    // input, moderation — costs nothing. A timeout, a failed download or a
    // failed upload all happen *after* the model ran and was charged for, so
    // zeroing those would quietly understate what the account actually spent.
    // Grok is on a subscription, so nothing it does is billed per job.
    //
    // `falRequestId` is only written once the vendor accepted the job, which
    // makes it the reliable discriminator: a local failure — bad model, missing
    // reference, rejected settings — never reaches that point and carries no
    // error kind either, so it would otherwise be recorded as money spent.
    const reachedVendor = Boolean(generation.falRequestId);
    // `billed` is the processor speaking directly, and it wins when present.
    //
    // The heuristic below reads the error *kind* to decide whether money moved,
    // which is only sound for a failure raised before the job was accepted. A
    // rotated key producing a 401 on the fourth poll is kind "auth" — and the
    // job is running, and will be charged for. Atlas makes that concrete: it
    // has no cancel endpoint, and it reports in-band error codes on a 200
    // during polling, so a moderation verdict can arrive after execution.
    const unbilled = !billsPerJob(generation.provider)
      ? true
      : args.billed !== undefined
        ? !args.billed
        : !reachedVendor || isUnbilledFailure(args.errorKind);

    await releaseReferences(ctx, generation);

    await ctx.db.patch(args.id, {
      status: "failed",
      error: args.error,
      errorKind: args.errorKind,
      referenceStorageId: undefined,
      referenceStorageIds: undefined,
      atlasPollLeaseId: undefined,
      atlasPollLeaseUntil: undefined,
      atlasWaitEndsAt: undefined,
      progressStage: undefined,
      progressMessage: undefined,
      progressCurrent: undefined,
      progressTotal: undefined,
      queuePosition: undefined,
      providerStatus: undefined,
      progressUpdatedAt: undefined,
      // Clear both units when nothing was spent; otherwise keep the pre-flight
      // figure and leave it flagged as an estimate, because the real charge is
      // unknowable from here.
      ...(unbilled
        ? { costUsd: 0, creditsUsed: 0, costEstimated: false }
        : { costEstimated: true }),
    });

    // A failure frees a slot exactly as a success does — and this is the path a
    // whole queued batch takes when the account is out of credits, so skipping
    // it would leave the rest waiting on jobs that are never coming back.
    if (generation.provider === "higgsfield") {
      await dispatchQueuedHiggsfield(ctx, generation.userId);
    }
  },
});

/**
 * Fails generations whose action never got to report back — Convex kills an
 * isolate that outlives its ceiling, and a killed isolate runs no catch block,
 * so the row would otherwise sit in `processing` forever, rendering as a
 * permanent spinner and holding its estimated cost in the running total.
 */
export const failStalled = internalMutation({
  args: { olderThanMs: v.number() },
  handler: async (ctx, args) => {
    const cutoff = Date.now() - args.olderThanMs;
    // One indexed pass per status, sharing a single 100-row budget. Convex
    // applies `.filter()` after the read, so the unindexed version paged the
    // whole table on every run and `.take(100)` never short-circuited: the
    // healthy case matches nothing, which is exactly when it read the most.
    const stalled = [];
    // `processing` first, and that order is load-bearing now that jobs queue.
    // These are the rows holding a Higgsfield slot, so they are the ones whose
    // rescue lets the queue behind them move. Old `pending` rows are mostly
    // *waiting* for those slots and are skipped below — reading them first would
    // let a long queue spend the whole budget on rows it then discards, leaving
    // the stuck jobs that caused the queue unswept and the queue wedged for good.
    for (const status of ["processing", "pending"] as const) {
      if (stalled.length >= 100) break;
      const rows = await ctx.db
        .query("grokGenerations")
        .withIndex("by_status_createdAt", (q) => q.eq("status", status).lt("createdAt", cutoff))
        .take(100 - stalled.length);
      stalled.push(...rows);
    }

    // Waiting for a Higgsfield slot is not stalling — see `isStalled`, which
    // owns that distinction and is tested against it.
    const stallWindow = {
      now: Date.now(),
      olderThanMs: args.olderThanMs,
      queueCeilingMs: HIGGSFIELD_QUEUE_CEILING_MS,
    };
    const freed = new Set<string>();
    let swept = 0;

    for (const generation of stalled) {
      // A watchdog-owned Atlas action may be saving a large video after the
      // ordinary age cutoff. Its renewable lease outranks the blunt sweeper.
      // Same for a self-hosted H3 job: a 15 s clip behind two others in the
      // pod's queue is legitimately older than the sweep window while its
      // processor keeps renewing the lease. comfyVideo.ts owns its deadline.
      if (
        generation.provider === "atlas" &&
        (generation.atlasPollLeaseUntil ?? 0) > stallWindow.now
      ) {
        continue;
      }
      // A self-hosted H3 job is the rescue cron's until its own deadline: a lapsed
      // lease there means "re-arm within a minute", not "dead". A 15 s clip
      // behind two others in the pod's queue legitimately outlives this window.
      if (
        generation.provider === "comfy" &&
        Math.max(generation.atlasWaitEndsAt ?? 0, generation.atlasPollLeaseUntil ?? 0) >
          stallWindow.now
      ) {
        continue;
      }
      if (!isStalled(generation, stallWindow)) continue;

      if (generation.provider === "higgsfield") freed.add(generation.userId);
      swept++;

      // Via releaseReferences, not a direct delete: a fan-out shares one set of
      // reference blobs, and sweeping the first sibling used to destroy them
      // for the rest, which then failed with "Reference image not found".
      await releaseReferences(ctx, generation);
      // Same discriminator markFailed uses: `falRequestId` (the fal request id
      // or the Higgsfield job id) is only written once the vendor accepted the
      // job, so a row swept without one was never charged and must not keep the
      // pre-flight estimate startImage/startVideo wrote at creation. Leaving it
      // would make the row permanently undeletable, because removeAllFailed
      // skips anything carrying a cost — the sweeper would produce exactly the
      // rubbish it exists to clear. A row that did reach the vendor keeps its
      // figure flagged as an estimate: a timeout is not an unbilled failure
      // kind, the model may well have run and been charged for.
      const reachedVendor = Boolean(generation.falRequestId);
      const unbilled = !billsPerJob(generation.provider) || !reachedVendor;
      await ctx.db.patch(generation._id, {
        status: "failed",
        error: "Generation timed out — the worker stopped reporting.",
        errorKind: "timeout",
        referenceStorageId: undefined,
        referenceStorageIds: undefined,
        atlasPollLeaseId: undefined,
        atlasPollLeaseUntil: undefined,
        atlasWaitEndsAt: undefined,
        progressStage: undefined,
        progressMessage: undefined,
        progressCurrent: undefined,
        progressTotal: undefined,
        queuePosition: undefined,
        providerStatus: undefined,
        progressUpdatedAt: undefined,
        ...(unbilled
          ? { costUsd: 0, creditsUsed: 0, costEstimated: false }
          : { costEstimated: true }),
      });
    }

    // Whatever was holding those slots is gone; let the queue behind them move.
    for (const userId of freed) {
      await dispatchQueuedHiggsfield(ctx, userId);
    }

    return swept;
  },
});
