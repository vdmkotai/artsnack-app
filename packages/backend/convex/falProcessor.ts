"use node";

/**
 * Runs Seedream (images) and Seedance 2.0 (video) jobs through fal's queue.
 *
 * Mirrors grokProcessor's lifecycle — pending → processing → completed/failed,
 * outputs parked in B2 — but talks to a different vendor with a different auth
 * model. Grok generations never reach this file.
 *
 * The important difference from the Grok path is that every request here costs
 * money, which changes what "handle the error" means: a job we stop waiting for
 * has to be cancelled, a job that already ran must not be recorded as free, and
 * a submission must never be retried blind.
 */

import { internalAction, type ActionCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import { v } from "convex/values";
import type { Id } from "./_generated/dataModel";

import {
  fetchWithTimeout,
  loadReferenceImages,
  persistReferenceImages,
  publicMediaUrl,
  uploadMediaToB2,
  withTransientRetry,
} from "./mediaPipeline";
import {
  FAL_CANCEL_TIMEOUT_MS,
  FAL_DOWNLOAD_TIMEOUT_MS,
  FAL_IMAGE_DEADLINE_MS,
  FAL_MAX_DOWNLOAD_BYTES,
  FAL_MAX_INLINE_REFERENCE_BYTES,
  FAL_OUTPUT_PREFIX,
  FAL_POLL_INTERVAL_MS,
  FAL_POLL_REQUEST_TIMEOUT_MS,
  FAL_SUBMIT_TIMEOUT_MS,
  FAL_VIDEO_DEADLINE_MS,
  requireFalKey,
} from "./falConfig";
import {
  FalError,
  falCancel,
  falResult,
  falStatus,
  falSubmit,
  isFatalFalError,
  isQueueFailed,
  isQueueSettled,
  type FalQueueStatus,
  type FalImageResult,
  type FalVideoResult,
} from "../../shared/fal-queue";
import { buildSeedanceRequest, buildSeedreamRequest } from "../../shared/fal-payload";
import {
  getApiModel,
  isApiModelId,
  type ApiModelId,
  type VideoTier,
} from "../../shared/api-models";
import { imageCostFromDimensions } from "../../shared/api-pricing";
import { runGrokOperationsIndependently } from "../../shared/grok-batch";
import { sanitizeProgressMessage } from "../../shared/generation-progress";

type GenerationRecord = {
  apiModel?: string;
  provider?: string;
  prompt: string;
  aspectRatio?: string;
  count?: number;
  resolution?: string;
  duration?: number;
  videoTier?: string;
  generateAudio?: boolean;
  bitrateMode?: string;
};

/** An unregistered model on a queued record is a bug upstream, not a retryable state. */
function requireFalModel(generation: GenerationRecord): ApiModelId {
  const id = generation.apiModel;
  if (!id || !isApiModelId(id)) {
    throw new Error(`Generation is not bound to a known API model (got ${id ?? "none"})`);
  }
  if (getApiModel(id).provider !== "fal") {
    throw new Error(`${id} is not a fal model — it must not be processed here`);
  }
  return id;
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Submit, poll until the queue settles, then read the payload.
 *
 * The poll loop deliberately swallows rate limits, 5xx and aborted requests:
 * the job is running and being billed on fal's side, so giving up on a single
 * bad response would abandon work the account has already paid for. Only a
 * verdict that the job will never run — bad key, no balance, rejected input,
 * moderation — exits early. The deadline is the sole other way out, and it
 * cancels the job on the way.
 */
async function runFalJob<T>(options: {
  endpoint: string;
  payload: Record<string, unknown>;
  apiKey: string;
  /** Action start, so submit time counts against the Convex action ceiling. */
  startedAt: number;
  deadlineMs: number;
  onSubmitted?: (requestId: string) => Promise<void>;
  onStatus?: (status: FalQueueStatus) => Promise<void>;
}): Promise<T> {
  // Never retried: a socket dropped after fal received the request would queue
  // — and charge for — a second job.
  const submission = await falSubmit(
    options.endpoint,
    options.payload,
    options.apiKey,
    FAL_SUBMIT_TIMEOUT_MS,
  );
  await options.onSubmitted?.(submission.requestId);
  await options.onStatus?.({
    status: "IN_QUEUE",
    queuePosition: submission.queuePosition,
    logs: [],
  });

  const deadline = options.startedAt + options.deadlineMs;
  for (;;) {
    await sleep(FAL_POLL_INTERVAL_MS);
    if (Date.now() > deadline) {
      if (submission.cancelUrl) {
        await falCancel(submission.cancelUrl, options.apiKey, FAL_CANCEL_TIMEOUT_MS);
      }
      throw new FalError("fal generation timed out", "timeout");
    }

    let status;
    try {
      status = await falStatus(submission.statusUrl, options.apiKey, FAL_POLL_REQUEST_TIMEOUT_MS);
    } catch (error) {
      if (isFatalFalError(error)) throw error;
      continue;
    }
    await options.onStatus?.(status);

    if (isQueueFailed(status.status)) {
      throw new FalError(status.error ?? `fal reported ${status.status}`, "server");
    }
    if (isQueueSettled(status.status)) break;
  }

  return await withTransientRetry(() =>
    falResult<T>(submission.responseUrl, options.apiKey, FAL_POLL_REQUEST_TIMEOUT_MS),
  );
}

function falProgressReporter(ctx: ActionCtx, generationId: Id<"grokGenerations">) {
  let previous = "";
  return async (status: FalQueueStatus): Promise<void> => {
    const latest = sanitizeProgressMessage(status.logs.at(-1)?.message);
    const stage =
      status.status === "IN_QUEUE"
        ? "provider-queued"
        : status.status === "COMPLETED" || status.status === "OK"
          ? "finalizing"
          : "generating";
    const message =
      latest ??
      (stage === "finalizing"
        ? "Collecting provider result..."
        : stage === "generating"
          ? "Running on fal.ai..."
          : undefined);
    const signature = `${stage}|${status.status}|${status.queuePosition ?? ""}|${message ?? ""}`;
    if (signature === previous) return;
    previous = signature;
    try {
      await ctx.runMutation(internal.grokGenerations.updateProgress, {
        id: generationId,
        stage,
        message,
        queuePosition: status.queuePosition,
        providerStatus: status.status,
      });
    } catch (error) {
      console.warn("[fal] could not publish progress", error);
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
    console.warn("[fal] could not publish progress", error);
  }
}

async function downloadBytes(url: string): Promise<Uint8Array> {
  const response = await withTransientRetry(() =>
    fetchWithTimeout(url, {}, FAL_DOWNLOAD_TIMEOUT_MS),
  );
  if (!response.ok) {
    throw new Error(`Failed to download fal output (HTTP ${response.status})`);
  }
  // Buffering happens inside the action isolate, so an outsized clip would take
  // the whole run down with an opaque OOM instead of a readable message.
  const declared = Number(response.headers.get("content-length") ?? 0);
  if (declared > FAL_MAX_DOWNLOAD_BYTES) {
    throw new Error(
      `fal output is ${Math.round(declared / 1024 / 1024)}MB, above the ${Math.round(
        FAL_MAX_DOWNLOAD_BYTES / 1024 / 1024,
      )}MB limit`,
    );
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  // Content-Length is advisory and often absent on CDN links, so the real size
  // is checked too — an oversized clip would otherwise OOM the isolate.
  if (bytes.byteLength > FAL_MAX_DOWNLOAD_BYTES) {
    throw new Error(
      `fal output is ${Math.round(bytes.byteLength / 1024 / 1024)}MB, above the ${Math.round(
        FAL_MAX_DOWNLOAD_BYTES / 1024 / 1024,
      )}MB limit`,
    );
  }
  return bytes;
}

/**
 * References have to be reachable by fal's servers, so they go to B2 first and
 * travel as CDN URLs. Without MEDIA_BASE_URL they are inlined as data URIs,
 * which works for a couple of small images and collapses for ten large ones.
 */
async function prepareReferences(
  ctx: Parameters<typeof loadReferenceImages>[0],
  storageIds: Parameters<typeof loadReferenceImages>[1],
  onProgress?: (message: string) => Promise<void>,
): Promise<{ urls: string[]; b2Keys: string[]; count: number }> {
  if (storageIds.length > 0) await onProgress?.("Loading reference images...");
  const references = await loadReferenceImages(ctx, storageIds);
  if (references.length === 0) return { urls: [], b2Keys: [], count: 0 };

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
    if (inlinedBytes > FAL_MAX_INLINE_REFERENCE_BYTES) {
      throw new Error(
        "MEDIA_BASE_URL is not configured in the Convex environment, so reference images have to " +
          "be inlined — and these are too large for one request. Set it to the public media host " +
          "(bunx convex env set MEDIA_BASE_URL …).",
      );
    }
    console.warn(
      "[fal] MEDIA_BASE_URL is not set — inlining a reference image as a data URI, which bloats the request.",
    );
    urls.push(reference.dataUrl);
  }

  return { urls, b2Keys, count: references.length };
}

function errorKindOf(error: unknown): string | undefined {
  return error instanceof FalError ? error.kind : undefined;
}

// ---------------------------------------------------------------------------
// Images — Seedream
// ---------------------------------------------------------------------------

export const processImage = internalAction({
  args: { generationId: v.id("grokGenerations"), userId: v.string() },
  handler: async (ctx, args) => {
    const startedAt = Date.now();
    const generation = await ctx.runQuery(internal.grokGenerations.getByIdInternal, {
      id: args.generationId,
    });
    if (!generation || generation.status !== "pending") return;

    await ctx.runMutation(internal.grokGenerations.markProcessing, { id: args.generationId });
    const reportStatus = falProgressReporter(ctx, args.generationId);

    const refIds = generation.referenceStorageIds ?? [];

    try {
      const apiKey = requireFalKey();
      const model = requireFalModel(generation);
      const caps = getApiModel(model).image;
      if (caps.kind !== "seedream") throw new Error(`${model} has no image endpoint`);

      const references = await prepareReferences(ctx, refIds, (message) =>
        publishProgress(ctx, args.generationId, "preparing-inputs", message),
      );

      const { endpoint, payload } = buildSeedreamRequest({
        model,
        prompt: generation.prompt,
        // Resolved to a concrete ratio at submit time, where the reference
        // dimensions are known; the fallback only matters for older records.
        aspectRatio: generation.aspectRatio ?? "1:1",
        sizeTier: generation.resolution ?? caps.defaultSizeTier,
        count: generation.count ?? 1,
        referenceUrls: references.urls,
      });

      await publishProgress(ctx, args.generationId, "submitting");
      const result = await runFalJob<FalImageResult>({
        endpoint,
        payload,
        apiKey,
        startedAt,
        deadlineMs: FAL_IMAGE_DEADLINE_MS,
        onSubmitted: async (requestId) => {
          await ctx.runMutation(internal.grokGenerations.recordFalRequest, {
            id: args.generationId,
            falRequestId: requestId,
            endpoint,
          });
        },
        onStatus: reportStatus,
      });

      const images = (result.images ?? []).filter((image) => image.url);
      if (images.length === 0) throw new Error("fal returned no images");

      await publishProgress(
        ctx,
        args.generationId,
        "downloading-output",
        images.length === 1
          ? "Downloading fal.ai result..."
          : `Downloading ${images.length} fal.ai results...`,
      );

      // The batch has already been paid for, so one failed upload must not
      // discard the images that did make it — same policy as the Grok path.
      const uploads = await runGrokOperationsIndependently(
        images.map((image, index) => async () => {
          const bytes = await downloadBytes(image.url);
          await publishProgress(
            ctx,
            args.generationId,
            "uploading-output",
            images.length === 1
              ? "Uploading result to media storage..."
              : `Uploading result ${index + 1} of ${images.length}...`,
          );
          const b2Key = await uploadMediaToB2(
            bytes,
            image.content_type ?? "image/png",
            FAL_OUTPUT_PREFIX,
          );
          return { b2Key, width: image.width, height: image.height };
        }),
      );
      if (uploads.successes.length === 0) {
        const failure = uploads.failures[0];
        throw failure instanceof Error ? failure : new Error(String(failure ?? "Upload failed"));
      }
      if (uploads.failures.length > 0) {
        console.error(
          `[fal] ${uploads.failures.length} of ${images.length} outputs failed to save`,
        );
      }

      // Pro's price bracket depends on the pixels it actually returned, so the
      // pre-flight estimate is replaced by the real figure when fal reports
      // dimensions for everything it produced. Otherwise the estimate stands.
      //
      // Priced over what fal generated, not over what reached B2: fal charges
      // for every image in the batch, so pricing the survivors of a failed
      // upload would quietly understate the bill.
      const saved = uploads.successes;
      const measured = images.every((image) => image.width && image.height);
      const costUsd = measured
        ? imageCostFromDimensions(
            model,
            images.map((image) => ({ width: image.width!, height: image.height! })),
            references.count,
          )
        : undefined;

      await publishProgress(ctx, args.generationId, "finalizing", "Finalizing fal.ai result...");

      // Blobs are released by markCompleted, which checks the batch first: a
      // fan-out shares one set of references, and deleting them here killed the
      // siblings that had not started yet.
      await ctx.runMutation(internal.grokGenerations.markCompleted, {
        id: args.generationId,
        b2Keys: saved.map((upload) => upload.b2Key),
        referenceB2Keys: references.b2Keys.length > 0 ? references.b2Keys : undefined,
        costUsd,
        costEstimated: measured ? false : undefined,
      });
    } catch (error) {
      await ctx.runMutation(internal.grokGenerations.markFailed, {
        id: args.generationId,
        error: error instanceof Error ? error.message : String(error),
        errorKind: errorKindOf(error),
      });
    }
  },
});

// ---------------------------------------------------------------------------
// Video — Seedance 2.0
// ---------------------------------------------------------------------------

export const processVideo = internalAction({
  args: { generationId: v.id("grokGenerations"), userId: v.string() },
  handler: async (ctx, args) => {
    const startedAt = Date.now();
    const generation = await ctx.runQuery(internal.grokGenerations.getByIdInternal, {
      id: args.generationId,
    });
    if (!generation || generation.status !== "pending") return;

    await ctx.runMutation(internal.grokGenerations.markProcessing, { id: args.generationId });
    const reportStatus = falProgressReporter(ctx, args.generationId);

    const refIds = generation.referenceStorageIds ?? [];

    try {
      const apiKey = requireFalKey();
      const model = requireFalModel(generation);
      const caps = getApiModel(model).video;
      if (caps.kind !== "seedance") throw new Error(`${model} has no video endpoint`);

      const references = await prepareReferences(ctx, refIds, (message) =>
        publishProgress(ctx, args.generationId, "preparing-inputs", message),
      );
      const tier = (generation.videoTier as VideoTier | undefined) ?? caps.defaultTier;

      const { endpoint, payload } = buildSeedanceRequest({
        model,
        prompt: generation.prompt,
        aspectRatio: generation.aspectRatio ?? "auto",
        durationSeconds: generation.duration ?? caps.defaultDuration,
        resolution: generation.resolution ?? caps.defaultResolution,
        tier,
        generateAudio: generation.generateAudio ?? true,
        bitrateMode: generation.bitrateMode === "high" ? "high" : "standard",
        referenceUrls: references.urls,
      });

      await publishProgress(ctx, args.generationId, "submitting");
      const result = await runFalJob<FalVideoResult>({
        endpoint,
        payload,
        apiKey,
        startedAt,
        deadlineMs: FAL_VIDEO_DEADLINE_MS,
        onSubmitted: async (requestId) => {
          await ctx.runMutation(internal.grokGenerations.recordFalRequest, {
            id: args.generationId,
            falRequestId: requestId,
            endpoint,
          });
        },
        onStatus: reportStatus,
      });

      const videoUrl = result.video?.url;
      if (!videoUrl) throw new Error("fal completed the video without a download URL");

      await publishProgress(ctx, args.generationId, "downloading-output");
      const bytes = await downloadBytes(videoUrl);
      await publishProgress(ctx, args.generationId, "uploading-output");
      const b2Key = await uploadMediaToB2(
        bytes,
        result.video?.content_type ?? "video/mp4",
        FAL_OUTPUT_PREFIX,
      );

      await publishProgress(ctx, args.generationId, "finalizing", "Finalizing fal.ai video...");

      // Blobs are released by markCompleted, which checks the batch first: a
      // fan-out shares one set of references, and deleting them here killed the
      // siblings that had not started yet.
      await ctx.runMutation(internal.grokGenerations.markCompleted, {
        id: args.generationId,
        b2Keys: [b2Key],
        referenceB2Keys: references.b2Keys.length > 0 ? references.b2Keys : undefined,
        // No dimensions come back for video, so the pre-flight figure stands.
      });
    } catch (error) {
      await ctx.runMutation(internal.grokGenerations.markFailed, {
        id: args.generationId,
        error: error instanceof Error ? error.message : String(error),
        errorKind: errorKindOf(error),
      });
    }
  },
});
