"use node";

/**
 * Runs Atlas Cloud jobs — 300 models across image and video — through their
 * prediction API.
 *
 * Mirrors falProcessor's lifecycle (pending → processing → completed/failed,
 * outputs parked in B2) but is model-agnostic: it never names a model or a
 * parameter. The request body comes from the generated catalogue via
 * buildAtlasRequest, which is what makes one processor enough for the whole
 * catalogue instead of one branch per family.
 *
 * The Atlas prediction id is stored in `falRequestId`. That field is misnamed
 * now, but it is the discriminator every billing path already keys on — see
 * markFailed and sweepStalled in grokGenerations.ts, which use "was an id
 * written?" to decide whether a failure was charged for. Introducing a parallel
 * `atlasRequestId` would mean teaching each of those about a second field, and
 * a missed one silently zeroes a real charge.
 */

import { internalAction, type ActionCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import { v } from "convex/values";
import type { Id } from "./_generated/dataModel";

import {
  loadReferenceImages,
  persistReferenceImages,
  publicMediaUrl,
  uploadMediaUrlToB2,
} from "./mediaPipeline";
import {
  ATLAS_DOWNLOAD_TIMEOUT_MS,
  ATLAS_MAX_DOWNLOAD_BYTES,
  ATLAS_MAX_INLINE_REFERENCE_BYTES,
  ATLAS_OUTPUT_PREFIX,
  ATLAS_POLL_BACKOFF_MS,
  ATLAS_POLL_INTERVAL_MS,
  ATLAS_POLL_REQUEST_TIMEOUT_MS,
  ATLAS_POLL_WINDOW_MS,
  ATLAS_SUBMIT_TIMEOUT_MS,
  ATLAS_TOTAL_WAIT_MS,
  requireAtlasKey,
} from "./atlasConfig";
import {
  AtlasError,
  atlasPoll,
  atlasSubmit,
  isAtlasFailed,
  isAtlasSettled,
  isFatalAtlasError,
  type AtlasPrediction,
} from "../../shared/atlas-queue";
import { buildAtlasRequest } from "../../shared/atlas-payload";
import { getAtlasModel, isAtlasModelId, type AtlasParamValue } from "../../shared/atlas-models";
import { runGrokOperationsIndependently } from "../../shared/grok-batch";
import { withRateLimitRetry } from "../../shared/rate-limit-retry";
import {
  ATLAS_OUTPUT_SAVE_LEASE_MS,
  ATLAS_POLL_LEASE_MS,
  tryAtlasHandoff,
} from "../../shared/atlas-lifecycle";
import { atlasOutputObjectKey } from "../../shared/atlas-output";
import { randomUUID } from "node:crypto";

/**
 * A prediction Atlas ran and then reported as failed.
 *
 * Separate from AtlasError because it is the only thing that distinguishes
 * "the job died on their side and was refunded" from "the job is alive and
 * being charged for while we gave up on it" — and those two must not record
 * the same cost.
 */
class AtlasVendorFailure extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AtlasVendorFailure";
  }
}

/** A settled, paid prediction whose bytes have not safely reached B2 yet. */
class AtlasOutputSaveError extends Error {
  constructor(error: unknown) {
    super(error instanceof Error ? error.message : String(error ?? "Atlas output save failed"));
    this.name = "AtlasOutputSaveError";
  }
}

type GenerationRecord = {
  apiModel?: string;
  provider?: string;
  atlasParams?: Record<string, AtlasParamValue>;
};

/** An unregistered model on a queued record is a bug upstream, not a retryable state. */
function requireAtlasModel(generation: GenerationRecord): string {
  const id = generation.apiModel;
  if (!id || !isAtlasModelId(id)) {
    throw new Error(`Generation is not bound to a known Atlas model (got ${id ?? "none"})`);
  }
  return id;
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Submit, then poll until the prediction settles.
 *
 * The loop deliberately swallows rate limits, 5xx and aborted requests: the job
 * is running and being billed on Atlas's side, so abandoning it over one bad
 * response would throw away work the account has already paid for. Only a
 * verdict that it will never run — bad key, no balance, rejected input,
 * moderation — exits early.
 *
 * Unlike the fal path there is no cancel on the way out of a timeout, because
 * Atlas publishes no endpoint for it. The deadline is a report, not a refund.
 */
type PollOutcome =
  | { settled: true; outputs: string[]; priceUsd?: number }
  /** The window closed with the job still running; the caller hands it on. */
  | { settled: false };

/**
 * Polls one prediction until it settles or this action's window closes.
 *
 * Swallows rate limits, 5xx and aborted requests: the job is running and being
 * billed, so abandoning it over one bad response would throw away work already
 * paid for. Only a verdict that it will never run exits early.
 */
async function pollUntilSettled(options: {
  pollPath: string;
  requestId: string;
  apiKey: string;
  /** When this action stops polling and hands the id to the next one. */
  windowEndsAt: number;
  /** When the whole chain gives up, measured from the first submission. */
  waitEndsAt: number;
  onStatus?: (prediction: AtlasPrediction) => Promise<void>;
}): Promise<PollOutcome> {
  let interval = ATLAS_POLL_INTERVAL_MS;
  for (;;) {
    await sleep(interval);
    const now = Date.now();

    if (now > options.waitEndsAt) {
      throw new AtlasError(
        `Atlas did not finish within ${Math.round(ATLAS_TOTAL_WAIT_MS / 60_000)} minutes. ` +
          "Atlas has no cancel endpoint, so the job may still complete and be charged for — " +
          "check the console before retrying.",
        "timeout",
      );
    }
    // Out of this action's budget but not out of the chain's: stop here and let
    // a fresh action carry on with the same id. Polling costs nothing and is
    // idempotent, so nothing is re-submitted and nothing is charged twice.
    if (now > options.windowEndsAt) return { settled: false };

    let prediction;
    try {
      prediction = await atlasPoll(
        options.pollPath,
        options.requestId,
        options.apiKey,
        ATLAS_POLL_REQUEST_TIMEOUT_MS,
      );
    } catch (error) {
      if (isFatalAtlasError(error)) throw error;
      interval = ATLAS_POLL_BACKOFF_MS;
      continue;
    }
    await options.onStatus?.(prediction);

    if (isAtlasFailed(prediction.status)) {
      // The vendor itself declaring the prediction dead. Their refund policy is
      // explicit — "the reserved amount is automatically released", "you only
      // pay for successful results" — so this is the one post-submit failure
      // that genuinely costs nothing.
      throw new AtlasVendorFailure(prediction.error ?? `Atlas reported ${prediction.status}`);
    }
    if (isAtlasSettled(prediction.status)) {
      if (prediction.outputs.length === 0) {
        throw new AtlasError("Atlas completed the job without returning any output", "server");
      }
      return { settled: true, outputs: prediction.outputs, priceUsd: prediction.priceUsd };
    }
  }
}

function atlasProgressReporter(ctx: ActionCtx, generationId: Id<"grokGenerations">) {
  let previous = "";
  return async (prediction: AtlasPrediction): Promise<void> => {
    const status = prediction.status.toLowerCase();
    const stage = isAtlasSettled(status)
      ? "finalizing"
      : status === "queued" || status === "created"
        ? "provider-queued"
        : "generating";
    const message =
      stage === "finalizing"
        ? "Collecting Atlas result..."
        : stage === "provider-queued"
          ? "Waiting in Atlas Cloud queue..."
          : "Running on Atlas Cloud...";
    const signature = `${stage}|${status}`;
    if (signature === previous) return;
    previous = signature;
    try {
      await ctx.runMutation(internal.grokGenerations.updateProgress, {
        id: generationId,
        stage,
        message,
        providerStatus: prediction.status,
      });
    } catch (error) {
      console.warn("[atlas] could not publish progress", error);
    }
  };
}

async function publishProgress(
  ctx: ActionCtx,
  id: Id<"grokGenerations">,
  stage: string,
  message?: string,
): Promise<void> {
  try {
    await ctx.runMutation(internal.grokGenerations.updateProgress, { id, stage, message });
  } catch (error) {
    console.warn("[atlas] could not publish progress", error);
  }
}

async function submitAtlasJob(options: {
  submitPath: string;
  body: Record<string, unknown>;
  apiKey: string;
}): Promise<string> {
  // Never retried on a dropped socket: one lost after Atlas received this would
  // queue — and charge for — a second job. A timeout here is genuinely
  // ambiguous, so it is reported as such rather than as a clean "nothing
  // happened". A 429 is the exception: Atlas refused the job outright, and a
  // ten-wide fan-out submitting in the same second is exactly what meets one.
  try {
    return await withRateLimitRetry(
      () => atlasSubmit(options.submitPath, options.body, options.apiKey, ATLAS_SUBMIT_TIMEOUT_MS),
      {
        rateLimitWaitMs: (error) =>
          error instanceof AtlasError && error.kind === "rate_limit" ? null : undefined,
      },
    );
  } catch (error) {
    if (error instanceof AtlasError) throw error;
    throw new AtlasError(
      "Atlas did not answer the submission in time. The job may still have been queued and " +
        "charged for — check the Atlas console before retrying.",
      "timeout",
    );
  }
}

/**
 * Guesses a content type from the URL, because Atlas returns bare links with no
 * metadata. Only used to label the B2 object; the proxy re-derives what it will
 * serve from its own allowlist.
 */
function contentTypeFor(url: string, media: "image" | "video"): string {
  const path = url.split("?")[0].toLowerCase();
  if (path.endsWith(".webm")) return "video/webm";
  if (path.endsWith(".mov")) return "video/quicktime";
  if (path.endsWith(".mp4")) return "video/mp4";
  if (path.endsWith(".webp")) return "image/webp";
  if (path.endsWith(".jpg") || path.endsWith(".jpeg")) return "image/jpeg";
  if (path.endsWith(".png")) return "image/png";
  return media === "video" ? "video/mp4" : "image/png";
}

/**
 * References have to be reachable by Atlas's servers, so they go to B2 first
 * and travel as CDN URLs. Without MEDIA_BASE_URL they are inlined as data URIs,
 * which works for a couple of small images and collapses for nine large ones.
 */
async function prepareReferences(
  ctx: Parameters<typeof loadReferenceImages>[0],
  storageIds: Parameters<typeof loadReferenceImages>[1],
  onProgress?: (message: string) => Promise<void>,
): Promise<{ urls: string[]; b2Keys: string[] }> {
  if (storageIds.length > 0) await onProgress?.("Loading reference images...");
  const references = await loadReferenceImages(ctx, storageIds);
  if (references.length === 0) return { urls: [], b2Keys: [] };

  await onProgress?.("Uploading reference images to media storage...");
  const b2Keys = await persistReferenceImages(references);
  const urls: string[] = [];
  let inlinedBytes = 0;

  for (const [index, reference] of references.entries()) {
    const key = b2Keys[index];
    const publicUrl = key ? publicMediaUrl(key) : null;
    if (publicUrl) {
      urls.push(publicUrl);
      continue;
    }
    inlinedBytes += reference.dataUrl.length;
    if (inlinedBytes > ATLAS_MAX_INLINE_REFERENCE_BYTES) {
      throw new Error(
        "MEDIA_BASE_URL is not configured in the Convex environment, so reference images have to " +
          "be inlined — and these are too large for one request. Set it to the public media host " +
          "(bunx convex env set MEDIA_BASE_URL …).",
      );
    }
    console.warn(
      "[atlas] MEDIA_BASE_URL is not set — inlining a reference image as a data URI, which bloats the request.",
    );
    urls.push(reference.dataUrl);
  }

  return { urls, b2Keys };
}

function errorKindOf(error: unknown): string | undefined {
  return error instanceof AtlasError ? error.kind : undefined;
}

/**
 * The whole lifecycle, shared by both media types.
 *
 * Images and video differ only in the deadline and in how many outputs are
 * expected, and neither difference is worth two copies of the error handling —
 * this is the file where a divergence between them would go unnoticed longest.
 */
async function process(
  ctx: ActionCtx,
  args: { generationId: Id<"grokGenerations">; userId: string },
  media: "image" | "video",
): Promise<void> {
  const startedAt = Date.now();
  const generationId = args.generationId;
  const generation = await ctx.runQuery(internal.grokGenerations.getByIdInternal, {
    id: generationId,
  });
  if (!generation || generation.status !== "pending") return;

  await ctx.runMutation(internal.grokGenerations.markProcessing, { id: generationId });
  const reportStatus = atlasProgressReporter(ctx, generationId);

  const refIds = generation.referenceStorageIds ?? [];
  // Everything before the POST is free; everything after it may not be. Atlas
  // publishes no cancel endpoint, so once this flips there is no way to make a
  // running job stop costing money, and no failure after it may be recorded as
  // free unless the vendor says it refunded.
  let submitted = false;
  let requestId: string | undefined;
  let referenceB2Keys: string[] = [];
  let leaseId: string | undefined;
  let waitEndsAt = startedAt + ATLAS_TOTAL_WAIT_MS;

  try {
    const apiKey = requireAtlasKey();
    const modelId = requireAtlasModel(generation);
    const model = getAtlasModel(modelId);
    if (model.media !== media) {
      throw new Error(`${modelId} is a ${model.media} model — it must not run as ${media}`);
    }

    const references = await prepareReferences(ctx, refIds, (message) =>
      publishProgress(ctx, generationId, "preparing-inputs", message),
    );

    const request = buildAtlasRequest({
      model: modelId,
      params: generation.atlasParams ?? {},
      referenceUrls: references.urls,
    });

    referenceB2Keys = references.b2Keys;
    await publishProgress(ctx, generationId, "submitting");
    requestId = await submitAtlasJob({
      submitPath: request.submitPath,
      body: request.body,
      apiKey,
    });
    submitted = true;
    const recordedAt = Date.now();
    waitEndsAt = recordedAt + ATLAS_TOTAL_WAIT_MS;
    leaseId = randomUUID();
    await ctx.runMutation(internal.grokGenerations.recordAtlasRequest, {
      id: generationId,
      requestId,
      endpoint: `${modelId} → ${request.submitPath}`,
      referenceB2Keys,
      leaseId,
      leaseUntil: recordedAt + ATLAS_POLL_LEASE_MS,
      waitEndsAt,
    });
    await publishProgress(ctx, generationId, "provider-queued", "Waiting for Atlas Cloud...");

    const outcome = await pollUntilSettled({
      pollPath: request.pollPath,
      requestId,
      apiKey,
      windowEndsAt: startedAt + ATLAS_POLL_WINDOW_MS,
      waitEndsAt,
      onStatus: reportStatus,
    });

    if (!outcome.settled) {
      // Still running when this action's budget ran out. Hand the id on rather
      // than giving up on work that is already being charged for; the row stays
      // `processing` and the next action carries on polling it.
      await enqueueAtlasResume(ctx, {
        generationId,
        media,
        requestId,
        referenceB2Keys,
        waitEndsAt,
      });
      return;
    }

    const ownsSave = await ctx.runMutation(internal.grokGenerations.claimAtlasPoll, {
      id: generationId,
      requestId,
      leaseId,
      leaseUntil: Date.now() + ATLAS_OUTPUT_SAVE_LEASE_MS,
    });
    if (!ownsSave) return;

    await saveOutputs(
      ctx,
      generationId,
      media,
      requestId,
      outcome.outputs,
      referenceB2Keys,
      outcome.priceUsd,
    );
  } catch (error) {
    if (error instanceof AtlasOutputSaveError && requestId) {
      console.error(`[atlas] output save interrupted; scheduling recovery: ${error.message}`);
      await enqueueAtlasResume(ctx, {
        generationId,
        media,
        requestId,
        referenceB2Keys,
        waitEndsAt,
      });
      return;
    }
    // A vendor-declared failure is refunded; everything else after the POST is
    // assumed charged. Note that the error *kind* is useless for this — a key
    // rotated mid-flight surfaces as "auth" on the fourth poll while the job
    // runs on and bills — which is why the answer is computed here, where the
    // phase is actually known, rather than inferred downstream.
    const vendorRefunded = error instanceof AtlasVendorFailure;
    await ctx.runMutation(internal.grokGenerations.markFailed, {
      id: generationId,
      error: error instanceof Error ? error.message : String(error),
      errorKind: errorKindOf(error),
      billed: submitted && !vendorRefunded,
    });
  }
}

/**
 * Downloads what Atlas produced, parks it in B2, and closes the row.
 *
 * Shared by the submitting action and every continuation, because they differ
 * only in how they arrived at the outputs — and a divergence in *this* half
 * would lose a paid result rather than merely delay it.
 */
async function saveOutputs(
  ctx: ActionCtx,
  generationId: Id<"grokGenerations">,
  media: "image" | "video",
  requestId: string,
  outputs: string[],
  referenceB2Keys: string[],
  priceUsd?: number,
): Promise<void> {
  await publishProgress(
    ctx,
    generationId,
    "downloading-output",
    outputs.length === 1
      ? "Downloading Atlas result..."
      : `Downloading ${outputs.length} Atlas results...`,
  );
  // Seedance can return the last frame as a second output alongside the clip.
  // Everything Atlas hands back is saved: the account was charged for the whole
  // reply, and dropping the extra would lose a frame the user asked for with
  // `return_last_frame`.
  //
  // The batch is already paid for, so one failed upload must not discard the
  // outputs that did make it — same policy as the fal and Grok paths.
  const uploads = await runGrokOperationsIndependently(
    outputs.map((url, index) => async () => {
      await publishProgress(
        ctx,
        generationId,
        "uploading-output",
        outputs.length === 1
          ? "Uploading Atlas result to media storage..."
          : `Uploading Atlas result ${index + 1} of ${outputs.length}...`,
      );
      const contentType = contentTypeFor(url, media);
      const objectKey = atlasOutputObjectKey(ATLAS_OUTPUT_PREFIX, requestId, index, contentType);
      return await uploadMediaUrlToB2(url, contentType, ATLAS_OUTPUT_PREFIX, {
        objectKey,
        maxBytes: ATLAS_MAX_DOWNLOAD_BYTES,
        inactivityTimeoutMs: ATLAS_DOWNLOAD_TIMEOUT_MS,
      });
    }),
  );
  if (uploads.successes.length === 0) {
    const failure = uploads.failures[0];
    throw new AtlasOutputSaveError(failure);
  }
  if (uploads.failures.length > 0) {
    console.error(`[atlas] ${uploads.failures.length} of ${outputs.length} outputs failed to save`);
  }

  await publishProgress(ctx, generationId, "finalizing", "Finalizing Atlas result...");

  // Blobs are released by markCompleted, which checks the batch first: a
  // fan-out shares one set of references, and deleting them here killed the
  // siblings that had not started yet.
  try {
    await ctx.runMutation(internal.grokGenerations.markCompleted, {
      id: generationId,
      b2Keys: uploads.successes,
      referenceB2Keys: referenceB2Keys.length > 0 ? referenceB2Keys : undefined,
      // The settled prediction carries what Atlas actually charged, and that
      // number outranks the pre-flight guess: token-billed models (Seedance)
      // charge by pixels × frames, and a 720p clip really costs ~2.25× the
      // published per-second rate. Absent a reported price, the estimate stands.
      ...(priceUsd !== undefined ? { costUsd: priceUsd, costEstimated: false } : {}),
    });
  } catch (error) {
    // The deterministic object keys make this whole phase safe to replay. A
    // transient Convex write must not turn an already-uploaded paid result into
    // a terminal failure.
    throw new AtlasOutputSaveError(error);
  }
}

/**
 * Best-effort handoff. If Convex cannot enqueue right now, the current lease
 * simply expires and the cron performs the same idempotent handoff later.
 */
async function enqueueAtlasResume(
  ctx: ActionCtx,
  args: {
    generationId: Id<"grokGenerations">;
    media: "image" | "video";
    requestId: string;
    referenceB2Keys: string[];
    waitEndsAt: number;
  },
): Promise<void> {
  await tryAtlasHandoff(
    async () => await ctx.runMutation(internal.grokGenerations.enqueueAtlasResume, args),
    (error) => {
      console.error(
        `[atlas] resume handoff failed; watchdog will retry: ${error instanceof Error ? error.message : String(error)}`,
      );
    },
  );
}

/**
 * Carries on polling a prediction another action started.
 *
 * Deliberately has no submit path at all. Everything it can do is free and
 * idempotent — polling, downloading, uploading — so a duplicate run costs
 * nothing beyond bandwidth, where a second POST would queue and bill a second
 * generation.
 *
 * `waitEndsAt` travels with it rather than being recomputed, so the chain's
 * total budget is measured from the first submission no matter how many
 * continuations it takes.
 */
export const resume = internalAction({
  args: {
    generationId: v.id("grokGenerations"),
    media: v.union(v.literal("image"), v.literal("video")),
    requestId: v.string(),
    referenceB2Keys: v.array(v.string()),
    waitEndsAt: v.number(),
    leaseId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const startedAt = Date.now();
    const generation = await ctx.runQuery(internal.grokGenerations.getByIdInternal, {
      id: args.generationId,
    });
    // Deleted, or already settled by something else — there is nothing to
    // resume, and the job on Atlas's side is beyond our reach either way.
    if (!generation || generation.status !== "processing") return;
    const leaseId = args.leaseId ?? randomUUID();
    const claimed = await ctx.runMutation(internal.grokGenerations.claimAtlasPoll, {
      id: args.generationId,
      requestId: args.requestId,
      leaseId,
      leaseUntil: startedAt + ATLAS_POLL_LEASE_MS,
    });
    if (!claimed) return;
    const referenceB2Keys = generation.referenceB2Keys ?? args.referenceB2Keys;
    const reportStatus = atlasProgressReporter(ctx, args.generationId);

    try {
      const apiKey = requireAtlasKey();
      const model = getAtlasModel(requireAtlasModel(generation));

      const outcome = await pollUntilSettled({
        pollPath: model.pollPath,
        requestId: args.requestId,
        apiKey,
        windowEndsAt: startedAt + ATLAS_POLL_WINDOW_MS,
        waitEndsAt: args.waitEndsAt,
        onStatus: reportStatus,
      });

      if (!outcome.settled) {
        await enqueueAtlasResume(ctx, {
          generationId: args.generationId,
          media: args.media,
          requestId: args.requestId,
          referenceB2Keys,
          waitEndsAt: args.waitEndsAt,
        });
        return;
      }

      const ownsSave = await ctx.runMutation(internal.grokGenerations.claimAtlasPoll, {
        id: args.generationId,
        requestId: args.requestId,
        leaseId,
        leaseUntil: Date.now() + ATLAS_OUTPUT_SAVE_LEASE_MS,
      });
      if (!ownsSave) return;

      await saveOutputs(
        ctx,
        args.generationId,
        args.media,
        args.requestId,
        outcome.outputs,
        referenceB2Keys,
        outcome.priceUsd,
      );
    } catch (error) {
      if (error instanceof AtlasOutputSaveError) {
        console.error(`[atlas] output save interrupted; scheduling recovery: ${error.message}`);
        await enqueueAtlasResume(ctx, {
          generationId: args.generationId,
          media: args.media,
          requestId: args.requestId,
          referenceB2Keys,
          waitEndsAt: args.waitEndsAt,
        });
        return;
      }
      // Always past the submission here, so only the vendor declaring the
      // prediction dead makes this unbilled.
      const vendorRefunded = error instanceof AtlasVendorFailure;
      await ctx.runMutation(internal.grokGenerations.markFailed, {
        id: args.generationId,
        error: error instanceof Error ? error.message : String(error),
        errorKind: errorKindOf(error),
        billed: !vendorRefunded,
      });
    }
  },
});

export const processImage = internalAction({
  args: { generationId: v.id("grokGenerations"), userId: v.string() },
  handler: async (ctx, args) => {
    await process(ctx, args, "image");
  },
});

export const processVideo = internalAction({
  args: { generationId: v.id("grokGenerations"), userId: v.string() },
  handler: async (ctx, args) => {
    await process(ctx, args, "video");
  },
});
