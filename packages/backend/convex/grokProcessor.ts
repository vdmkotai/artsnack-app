"use node";

import { action, internalAction, type ActionCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import { v } from "convex/values";
import type { Id } from "./_generated/dataModel";
import { runGrokOperationsIndependently } from "../../shared/grok-batch";
import { parseRetryAfterMs, withRateLimitRetry } from "../../shared/rate-limit-retry";
import { getApiModel } from "../../shared/api-models";
import {
  buildGrokImageRequest,
  buildGrokVideoRequest,
  grokSourceResolution,
  usdFromTicks,
} from "../../shared/grok-imagine";
import { OUTPUT_PREFIXES, isGrokSourceVideoKey } from "../../shared/image-key";
import { isMp4, mp4DurationSeconds, mp4VideoDimensions } from "../../shared/mp4";
import {
  fetchWithTimeout,
  loadB2Object,
  loadReferenceImages,
  persistReferenceImages,
  persistSourceVideo,
  publicMediaUrl,
  uploadMediaToB2,
  withTransientRetry,
} from "./mediaPipeline";
import { GROK_API_BASE_URL } from "./grokConfig";
import { getValidAccessToken, grokApiHeaders, RECONNECT_ERROR } from "./grokToken";
import { requireAllowedUser } from "./authz";

const IMAGE_TIMEOUT_MS = 300_000;
const VIDEO_START_TIMEOUT_MS = 60_000;
const VIDEO_POLL_INTERVAL_MS = 5_000;
const VIDEO_POLL_REQUEST_TIMEOUT_MS = 30_000;
/** Stay under the 10-minute Convex action limit with room to upload. */
const VIDEO_GEN_DEADLINE_MS = 8.5 * 60_000;
const VIDEO_DOWNLOAD_TIMEOUT_MS = 120_000;
/** Everything the action does, end to end, has to fit under the ceiling — the
 *  poll deadline alone did not, because the download that follows it carried a
 *  fixed 2-minute timeout of its own. Convex kills an isolate that overruns, so
 *  no catch block runs and the row is stranded in `processing`. */
const VIDEO_ACTION_BUDGET_MS = 9.5 * 60_000;
/**
 * Largest source clip accepted for Edit or Extend. A 15 s 720p clip from Grok
 * is a few MB; this leaves room for a phone recording without letting an
 * upload pin a Convex action's memory.
 */
const MAX_SOURCE_VIDEO_BYTES = 100 * 1024 * 1024;

/** What xAI reports a job used against the quota, when it reports it. */
type GrokUsage = { usage?: { cost_in_usd_ticks?: number } };

// ---------------------------------------------------------------------------
// Image generation
// ---------------------------------------------------------------------------

type GrokImageResponse = { data?: Array<{ b64_json?: string }> } & GrokUsage;

async function publishProgress(
  ctx: ActionCtx,
  id: Id<"grokGenerations">,
  stage: string,
  message?: string,
  providerStatus?: string,
): Promise<void> {
  try {
    await ctx.runMutation(internal.grokGenerations.updateProgress, {
      id,
      stage,
      message,
      providerStatus,
    });
  } catch (error) {
    console.warn("[Grok] could not publish progress", error);
  }
}

/** A 429 from an image endpoint: xAI accepted nothing, so it may be retried. */
class GrokRateLimitError extends Error {
  readonly retryAfterMs: number | null;

  constructor(body: string, retryAfterMs: number | null) {
    super(`Grok rate limit reached (HTTP 429)${body ? `: ${body}` : ""}`);
    this.name = "GrokRateLimitError";
    this.retryAfterMs = retryAfterMs;
  }
}

export const processImage = internalAction({
  args: { generationId: v.id("grokGenerations"), userId: v.string() },
  handler: async (ctx, args) => {
    const generation = await ctx.runQuery(internal.grokGenerations.getByIdInternal, {
      id: args.generationId,
    });
    if (!generation || generation.status !== "pending") return;

    await ctx.runMutation(internal.grokGenerations.markProcessing, {
      id: args.generationId,
    });

    const refIds = generation.referenceStorageIds ?? [];

    try {
      const accessToken = await getValidAccessToken(ctx, args.userId);

      if (refIds.length > 0) {
        await publishProgress(ctx, args.generationId, "preparing-inputs");
      }
      const references = await loadReferenceImages(ctx, refIds);
      const refUrls = references.map((reference) => reference.dataUrl);

      // With reference images → /images/edits; plain prompt → /images/generations.
      // The body is built in packages/shared/grok-imagine.ts, where it is tested.
      const request = buildGrokImageRequest({
        quality: generation.quality,
        prompt: generation.prompt,
        // Only rows predating the size control lack one; the registry's default
        // keeps that fallback from drifting away from what the form offers.
        resolution: generation.resolution ?? getApiModel("grok").image.defaultSizeTier,
        count: generation.count ?? 1,
        aspectRatio: generation.aspectRatio,
        imageUrls: refUrls,
      });
      const endpoint = request.path;
      const payload = request.body;

      // The edit endpoint does not accept n>1, so request each edited output
      // concurrently. Plain generation remains one request using the n field.
      const requestCount = request.requests;
      await publishProgress(
        ctx,
        args.generationId,
        "generating",
        requestCount > 1
          ? `Waiting for ${requestCount} Grok image requests...`
          : "Waiting for Grok image response...",
        "processing",
      );
      // Ten concurrent edits can outrun the per-second limit, and a 429 means
      // xAI took nothing, so it is waited out rather than lost as "7 of 10".
      const requestBatch = await runGrokOperationsIndependently(
        Array.from({ length: requestCount }, () => async () => {
          const response = await withRateLimitRetry(
            async () => {
              const attempt = await withTransientRetry(() =>
                fetchWithTimeout(
                  `${GROK_API_BASE_URL}/${endpoint}`,
                  {
                    method: "POST",
                    headers: grokApiHeaders(accessToken),
                    body: JSON.stringify(payload),
                  },
                  IMAGE_TIMEOUT_MS,
                ),
              );
              if (attempt.status === 429) {
                const body = (await attempt.text().catch(() => "")).slice(0, 300);
                throw new GrokRateLimitError(
                  body,
                  parseRetryAfterMs(attempt.headers.get("retry-after")),
                );
              }
              return attempt;
            },
            {
              rateLimitWaitMs: (error) =>
                error instanceof GrokRateLimitError ? error.retryAfterMs : undefined,
            },
          );
          if (!response.ok) {
            const body = (await response.text().catch(() => "")).slice(0, 300);
            if (response.status === 401) throw new Error(RECONNECT_ERROR);
            throw new Error(`Grok image generation failed (HTTP ${response.status}): ${body}`);
          }

          const data = (await response.json()) as GrokImageResponse;
          const images = (data.data ?? []).filter((image) => image.b64_json);
          if (images.length === 0) throw new Error("Grok returned no image data");
          return { images, meteredUsd: usdFromTicks(data.usage?.cost_in_usd_ticks) };
        }),
      );

      if (
        requestBatch.failures.some(
          (error) => error instanceof Error && error.message === RECONNECT_ERROR,
        )
      ) {
        await ctx.runMutation(internal.grokAuth.clearTokens, { userId: args.userId });
      }

      const images = requestBatch.successes.flatMap((success) => success.images);
      // Summed only when every successful request reported its usage; a
      // partial sum would read as a measured figure and understate the quota.
      const reported = requestBatch.successes.map((success) => success.meteredUsd);
      const meteredUsd = reported.every((value) => value !== undefined)
        ? Math.round(reported.reduce((total: number, value) => total + (value ?? 0), 0) * 1e4) / 1e4
        : undefined;
      if (images.length === 0) {
        const error = requestBatch.failures[0];
        throw error instanceof Error
          ? error
          : new Error(String(error ?? "Grok returned no images"));
      }

      await publishProgress(
        ctx,
        args.generationId,
        "uploading-output",
        images.length === 1
          ? "Uploading image to media storage..."
          : `Uploading ${images.length} images...`,
      );
      const uploadBatch = await runGrokOperationsIndependently(
        images.map(
          (image) => async () =>
            await uploadMediaToB2(
              Buffer.from(image.b64_json!, "base64"),
              "image/jpeg",
              OUTPUT_PREFIXES.grok,
            ),
        ),
      );
      const b2Keys = uploadBatch.successes;
      if (b2Keys.length === 0) {
        const error = uploadBatch.failures[0];
        throw error instanceof Error ? error : new Error(String(error ?? "Failed to save images"));
      }

      // A fan-out that half-worked used to complete in silence: ask for four,
      // get one, and nothing anywhere said the other three were refused. The
      // shortfall is recorded on the row (the grid shows "1 of 4") and the
      // reasons go to the deployment log, because they are the only evidence
      // of a moderation refusal — Grok returns those as empty data, not errors.
      const requested = generation.count ?? 1;
      const failureMessages = [...requestBatch.failures, ...uploadBatch.failures].map((error) =>
        error instanceof Error ? error.message : String(error),
      );
      if (failureMessages.length > 0) {
        console.error(
          `[Grok] ${failureMessages.length} of ${requested} image request(s) produced nothing ` +
            `for ${args.generationId}:`,
          failureMessages,
        );
      }
      const shortfall =
        b2Keys.length < requested
          ? `${b2Keys.length} of ${requested} images arrived. ` +
            (failureMessages[0] ??
              "The vendor returned fewer images than requested — moderation refusals come back empty.")
          : undefined;

      let referenceB2Keys: string[] = [];
      if (references.length > 0) {
        await publishProgress(ctx, args.generationId, "finalizing", "Saving reference images...");
      }
      try {
        referenceB2Keys = await persistReferenceImages(references);
      } catch (error) {
        console.error("[Grok] Failed to persist references for recreation:", error);
      }

      await publishProgress(ctx, args.generationId, "finalizing", "Finalizing Grok result...");

      // Blobs are released by markCompleted, which checks the batch first: a
      // fan-out shares one set of references, and deleting them here killed the
      // siblings that had not started yet.
      await ctx.runMutation(internal.grokGenerations.markCompleted, {
        id: args.generationId,
        b2Keys,
        referenceB2Keys: referenceB2Keys.length > 0 ? referenceB2Keys : undefined,
        error: shortfall,
        meteredUsd,
      });
    } catch (error) {
      await ctx.runMutation(internal.grokGenerations.markFailed, {
        id: args.generationId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  },
});

// ---------------------------------------------------------------------------
// Video generation (async: start → poll → download)
// ---------------------------------------------------------------------------

type VideoStartResponse = { request_id?: string };
type VideoPollResponse = {
  status?: string;
  video?: { url?: string };
  error?: { code?: string; message?: string };
} & GrokUsage;

/**
 * The URL xAI fetches the source clip from. The public media URL where there
 * is one — it ends in `.mp4`, as xAI requires — and otherwise the clip itself
 * as a data URL, which the endpoint also accepts.
 */
async function loadSourceVideo(key: string): Promise<{ url: string; seconds: number }> {
  if (!isGrokSourceVideoKey(key)) throw new Error("The source video key is not an mp4 we serve");
  // Measured here, at the paid boundary, from the file itself: the length on
  // the row is the client's figure, and an out-of-range clip is refused by xAI
  // only after the request has been paid for.
  const bytes = await loadB2Object(key);
  if (bytes.length > MAX_SOURCE_VIDEO_BYTES) {
    throw new Error("The source video is too large for Grok to edit or extend");
  }
  if (!isMp4(bytes)) throw new Error("The source video is not an MP4");
  const seconds = mp4DurationSeconds(bytes);
  if (seconds === null) throw new Error("The source video does not say how long it is");
  const url =
    publicMediaUrl(key) ?? `data:video/mp4;base64,${Buffer.from(bytes).toString("base64")}`;
  return { url, seconds: Math.round(seconds * 100) / 100 };
}

export const processVideo = internalAction({
  args: { generationId: v.id("grokGenerations"), userId: v.string() },
  handler: async (ctx, args) => {
    const startedAt = Date.now();
    const generation = await ctx.runQuery(internal.grokGenerations.getByIdInternal, {
      id: args.generationId,
    });
    if (!generation || generation.status !== "pending") return;

    await ctx.runMutation(internal.grokGenerations.markProcessing, {
      id: args.generationId,
    });

    try {
      const accessToken = await getValidAccessToken(ctx, args.userId);

      const refIds = generation.referenceStorageIds ?? [];
      if (refIds.length > 0) {
        await publishProgress(ctx, args.generationId, "preparing-inputs");
      }
      const references = await loadReferenceImages(ctx, refIds);
      const refUrls = references.map((reference) => reference.dataUrl);

      // Generate (1.5 or Lite), Edit or Extend — the plan, the roles of the
      // images and the body all come from packages/shared/grok-imagine.ts,
      // which throws anything xAI documents as illegal before it is sent. A
      // row from before the model choice carries none of the new fields and
      // builds exactly the 1.5 request it always did.
      const editing = generation.grokVideoMode === "edit" || generation.grokVideoMode === "extend";
      if (editing && !generation.sourceVideoKey) {
        throw new Error("This edit has no source video");
      }
      const source =
        editing && generation.sourceVideoKey
          ? await loadSourceVideo(generation.sourceVideoKey)
          : null;
      const request = buildGrokVideoRequest({
        mode: generation.grokVideoMode,
        model: generation.grokVideoModel,
        referenceCount: refUrls.length,
        frameRoles: generation.grokFrameRoles,
        voiceCount: generation.referenceVoices?.length ?? 0,
        duration: editing ? undefined : (generation.duration ?? 6),
        extendDuration: generation.grokVideoMode === "extend" ? generation.duration : undefined,
        source: source ? { seconds: source.seconds } : null,
        prompt: generation.prompt,
        imageUrls: refUrls,
        voices: generation.referenceVoices,
        resolution: generation.resolution ?? "480p",
        aspectRatio: generation.aspectRatio,
        sourceVideoUrl: source?.url,
      });
      const payload = request.body;

      await publishProgress(
        ctx,
        args.generationId,
        "submitting",
        request.plan.mode === "edit"
          ? "Sending the clip to Grok to edit..."
          : request.plan.mode === "extend"
            ? "Sending the clip to Grok to extend..."
            : "Sending video to Grok...",
      );
      const startResp = await withTransientRetry(() =>
        fetchWithTimeout(
          `${GROK_API_BASE_URL}/${request.path}`,
          {
            method: "POST",
            headers: grokApiHeaders(accessToken),
            body: JSON.stringify(payload),
          },
          VIDEO_START_TIMEOUT_MS,
        ),
      );

      if (!startResp.ok) {
        const body = (await startResp.text().catch(() => "")).slice(0, 300);
        if (startResp.status === 401) {
          await ctx.runMutation(internal.grokAuth.clearTokens, { userId: args.userId });
          throw new Error(RECONNECT_ERROR);
        }
        throw new Error(`Grok video generation failed (HTTP ${startResp.status}): ${body}`);
      }

      const startData = (await startResp.json()) as VideoStartResponse;
      const requestId = startData.request_id;
      if (!requestId) throw new Error("Grok returned no video request id");
      await publishProgress(
        ctx,
        args.generationId,
        "generating",
        "Generating video on Grok...",
        "pending",
      );

      // Poll until done. Measured from the top of the action, so the token
      // refresh and the start POST count against the same ceiling the poll does.
      const deadline = startedAt + VIDEO_GEN_DEADLINE_MS;
      let videoUrl: string | undefined;
      let meteredUsd: number | undefined;
      let lastProviderStatus = "pending";
      for (;;) {
        await new Promise((resolve) => setTimeout(resolve, VIDEO_POLL_INTERVAL_MS));
        if (Date.now() > deadline) {
          throw new Error("Grok video generation timed out");
        }

        const pollResp = await withTransientRetry(() =>
          fetchWithTimeout(
            `${GROK_API_BASE_URL}/videos/${requestId}`,
            { headers: grokApiHeaders(accessToken) },
            VIDEO_POLL_REQUEST_TIMEOUT_MS,
          ),
        );
        if (!pollResp.ok && pollResp.status !== 202) {
          const body = (await pollResp.text().catch(() => "")).slice(0, 300);
          throw new Error(`Grok video poll failed (HTTP ${pollResp.status}): ${body}`);
        }

        const pollData = (await pollResp.json()) as VideoPollResponse;
        if (pollData.status === "done") {
          await publishProgress(
            ctx,
            args.generationId,
            "finalizing",
            "Collecting Grok video result...",
            "done",
          );
          videoUrl = pollData.video?.url;
          meteredUsd = usdFromTicks(pollData.usage?.cost_in_usd_ticks);
          break;
        }
        if (pollData.status === "failed" || pollData.status === "expired") {
          // xAI says why in `error` — an over-long source clip, a refused
          // prompt — and that is worth more on the tile than the bare status.
          const reason = pollData.error?.message;
          throw new Error(
            `Grok video generation ${pollData.status} on the server${reason ? `: ${reason}` : ""}`,
          );
        }
        const providerStatus = pollData.status ?? "pending";
        if (providerStatus !== lastProviderStatus) {
          lastProviderStatus = providerStatus;
          await publishProgress(
            ctx,
            args.generationId,
            "generating",
            "Generating video on Grok...",
            providerStatus,
          );
        }
        // any other status → still in progress
      }

      if (!videoUrl) throw new Error("Grok video completed without a download URL");

      // The download has to fit in what is left of the action budget, not in a
      // fixed two minutes on top of it.
      const remaining = startedAt + VIDEO_ACTION_BUDGET_MS - Date.now();
      if (remaining <= 5_000) {
        throw new Error("Ran out of time saving the Grok video");
      }
      await publishProgress(ctx, args.generationId, "downloading-output");
      const videoResp = await withTransientRetry(() =>
        fetchWithTimeout(videoUrl, {}, Math.min(VIDEO_DOWNLOAD_TIMEOUT_MS, remaining)),
      );
      if (!videoResp.ok) {
        throw new Error(`Failed to download Grok video (HTTP ${videoResp.status})`);
      }
      const bytes = new Uint8Array(await videoResp.arrayBuffer());

      await publishProgress(ctx, args.generationId, "uploading-output");
      const b2Key = await uploadMediaToB2(bytes, "video/mp4", OUTPUT_PREFIXES.grok);
      const referenceB2Keys = await persistReferenceImages(references);

      await publishProgress(ctx, args.generationId, "finalizing", "Finalizing Grok video...");

      // Blobs are released by markCompleted, which checks the batch first: a
      // fan-out shares one set of references, and deleting them here killed the
      // siblings that had not started yet.
      await ctx.runMutation(internal.grokGenerations.markCompleted, {
        id: args.generationId,
        b2Keys: [b2Key],
        referenceB2Keys: referenceB2Keys.length > 0 ? referenceB2Keys : undefined,
        meteredUsd,
      });
    } catch (error) {
      await ctx.runMutation(internal.grokGenerations.markFailed, {
        id: args.generationId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  },
});

// ---------------------------------------------------------------------------
// Source clips for Edit and Extend
// ---------------------------------------------------------------------------

/**
 * Turns an uploaded clip into a source Grok can edit or extend.
 *
 * The browser uploads the file to Convex storage (generateRefUploadUrl) and
 * hands the id here. The bytes are checked to be an MP4 — the only container
 * xAI takes — measured from the movie header, parked in B2 under a hash-named
 * `.mp4` key, and the storage copy is deleted whatever happens. The form keeps
 * the key, so a clip is uploaded once however many edits it goes through.
 */
/** What a source clip measured: its length and the resolution Grok returns for it. */
type SourceVideoFacts = {
  key: string;
  seconds: number | null;
  /** The source's own size, capped at 720p; null when the file does not say. */
  resolution: "480p" | "720p" | null;
};

function measureSourceVideo(key: string, bytes: Uint8Array): SourceVideoFacts {
  const seconds = mp4DurationSeconds(bytes);
  const size = mp4VideoDimensions(bytes);
  return {
    key,
    seconds: seconds === null ? null : Math.round(seconds * 100) / 100,
    resolution: size ? grokSourceResolution(size.width, size.height) : null,
  };
}

export const uploadSourceVideo = action({
  args: { storageId: v.id("_storage") },
  handler: async (ctx, args): Promise<SourceVideoFacts> => {
    await requireAllowedUser(ctx);
    const blob = await ctx.storage.get(args.storageId);
    if (!blob) throw new Error("The uploaded video was not found");
    // The storage copy is deleted only once it is known to be a video upload:
    // the id comes from the client, and the same storage holds the reference
    // images of jobs still waiting to run.
    const isVideoUpload = blob.type.startsWith("video/");
    try {
      if (blob.size > MAX_SOURCE_VIDEO_BYTES) {
        throw new Error(
          `That video is ${Math.round(blob.size / 1024 / 1024)} MB — the limit is ${MAX_SOURCE_VIDEO_BYTES / 1024 / 1024} MB`,
        );
      }
      const bytes = new Uint8Array(await blob.arrayBuffer());
      if (!isMp4(bytes)) throw new Error("Grok edits and extends MP4 video only");
      const facts = measureSourceVideo(await persistSourceVideo(bytes), bytes);
      await ctx.storage.delete(args.storageId).catch(() => undefined);
      return facts;
    } catch (error) {
      if (isVideoUpload) await ctx.storage.delete(args.storageId).catch(() => undefined);
      throw error;
    }
  },
});

/**
 * Measures one of the app's own clips for "Edit/Extend with Grok". The web
 * reads the length off a `<video>` element; the native app has no such thing
 * to hand, so it asks here, where the movie header is read from the file in
 * B2 — the same figure an upload gets.
 */
export const describeSourceVideo = action({
  args: { key: v.string() },
  handler: async (ctx, args): Promise<SourceVideoFacts> => {
    await requireAllowedUser(ctx);
    if (!isGrokSourceVideoKey(args.key)) {
      throw new Error("Grok edits and extends mp4 clips from your results only");
    }
    const bytes = await loadB2Object(args.key);
    if (bytes.length > MAX_SOURCE_VIDEO_BYTES) {
      throw new Error("That clip is too large for Grok to edit or extend");
    }
    if (!isMp4(bytes)) throw new Error("Grok edits and extends MP4 video only");
    return measureSourceVideo(args.key, bytes);
  },
});
