"use node";

/**
 * Runs Seedream (images) and Seedance 2.0 (video) through Higgsfield.
 *
 * Higgsfield publishes a CLI and an MCP server, not a REST contract, so the
 * generation itself happens in worker/ — a container that runs their CLI. This
 * file drives that worker and owns the same lifecycle as the fal and Grok
 * processors: pending → processing → completed/failed, outputs parked in B2.
 *
 * Credentials rotate. Every worker reply may carry a refreshed token, and it is
 * persisted immediately — losing one means a manual `higgsfield auth login`.
 */

import { internalAction, action, ActionCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import { v } from "convex/values";

import {
  fetchWithTimeout,
  loadReferenceImages,
  persistReferenceImages,
  publicMediaUrl,
  uploadMediaToB2,
  withTransientRetry,
} from "./mediaPipeline";
import {
  HIGGSFIELD_ACTION_BUDGET_MS,
  HIGGSFIELD_BALANCE_TTL_MS,
  HIGGSFIELD_COST_TTL_MS,
  HIGGSFIELD_DOWNLOAD_TIMEOUT_MS,
  HIGGSFIELD_IMAGE_DEADLINE_MS,
  HIGGSFIELD_MAX_DOWNLOAD_BYTES,
  HIGGSFIELD_MISSING_CREDENTIALS_ERROR,
  HIGGSFIELD_OUTPUT_PREFIX,
  HIGGSFIELD_POLL_INTERVAL_MS,
  HIGGSFIELD_POLL_REQUEST_TIMEOUT_MS,
  HIGGSFIELD_VIDEO_DEADLINE_MS,
  HIGGSFIELD_WORKER_TIMEOUT_MS,
  higgsfieldWorkspaceId,
  requireWorker,
} from "./higgsfieldConfig";
import {
  buildHiggsfieldJob,
  costSignature,
  creditsOf,
  findMediaUrls,
  findString,
  isModerationState,
  jobIdOf,
  jobStateOf,
  jobStatusesOf,
  type HiggsfieldJobRequest,
  type WorkerRequest,
  type WorkerResponse,
} from "../../shared/higgsfield-job";
import {
  getApiModel,
  isApiModelId,
  type ApiModelId,
  type MediaType,
} from "../../shared/api-models";
import { requireAllowedUser } from "./authz";

// ---------------------------------------------------------------------------
// Worker transport
// ---------------------------------------------------------------------------

/** Anything the worker refuses outright — no point retrying or waiting. */
class HiggsfieldError extends Error {
  readonly kind: string;
  constructor(message: string, kind: string) {
    super(message);
    this.kind = kind;
  }
}

async function callWorker(
  ctx: ActionCtx,
  route: string,
  body: WorkerRequest,
  timeoutMs: number = HIGGSFIELD_WORKER_TIMEOUT_MS,
): Promise<WorkerResponse> {
  const { url, secret } = requireWorker();
  // The account is one shared resource and its token rotates. A fan-out has
  // several actions polling at once, so the stored value is re-read here rather
  // than captured for the life of a job — otherwise a sibling's refresh leaves
  // everyone else presenting a token that is already dead.
  const current = await ctx.runQuery(internal.higgsfield.getCredentialsInternal, {});
  if (current?.credentials) body = { ...body, credentials: current.credentials };
  const response = await withTransientRetry(() =>
    fetchWithTimeout(
      `${url}${route}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-worker-secret": secret },
        body: JSON.stringify(body),
      },
      timeoutMs,
    ),
  );

  const payload = (await response.json().catch(() => ({}))) as WorkerResponse;

  // Persist a rotated token even when the call itself failed — the CLI may have
  // refreshed before hitting the error, and dropping it would strand the account.
  if (payload.credentials) {
    await ctx.runMutation(internal.higgsfield.storeCredentials, {
      credentials: payload.credentials,
    });
  }

  if (!response.ok) {
    const message = payload.error || `Higgsfield worker failed (HTTP ${response.status})`;
    throw new HiggsfieldError(
      message,
      response.status === 401 ? "auth" : response.status === 400 ? "validation" : "server",
    );
  }
  return payload;
}

/** Credentials come from the table, seeded once from the environment. */
async function loadCredentials(ctx: ActionCtx): Promise<string> {
  const row = await ctx.runQuery(internal.higgsfield.getCredentialsInternal, {});
  if (row?.credentials) return row.credentials;

  const seed = process.env.HIGGSFIELD_CREDENTIALS;
  if (!seed) throw new HiggsfieldError(HIGGSFIELD_MISSING_CREDENTIALS_ERROR, "auth");
  await ctx.runMutation(internal.higgsfield.storeCredentials, { credentials: seed });
  return seed;
}

function baseRequest(credentials: string): WorkerRequest {
  return { credentials, workspaceId: higgsfieldWorkspaceId() };
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function downloadBytes(url: string, deadline?: number): Promise<Uint8Array> {
  // The poll deadline covers waiting; the download has to fit in the same
  // budget or Convex kills the isolate mid-flight and no catch block runs.
  // A retried 120s fetch is ~6 minutes on its own, which alone overruns it.
  const remaining = deadline ? deadline - Date.now() : HIGGSFIELD_DOWNLOAD_TIMEOUT_MS;
  if (remaining <= 5_000) {
    throw new HiggsfieldError("Ran out of time saving Higgsfield output", "timeout");
  }
  const timeout = Math.min(HIGGSFIELD_DOWNLOAD_TIMEOUT_MS, remaining);
  const response = await withTransientRetry(() => fetchWithTimeout(url, {}, timeout));
  if (!response.ok) {
    throw new Error(`Failed to download Higgsfield output (HTTP ${response.status})`);
  }
  const limitMb = Math.round(HIGGSFIELD_MAX_DOWNLOAD_BYTES / 1024 / 1024);
  const declared = Number(response.headers.get("content-length") ?? 0);
  if (declared > HIGGSFIELD_MAX_DOWNLOAD_BYTES) {
    throw new Error(`Higgsfield output is larger than the ${limitMb}MB limit`);
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  // Content-Length is advisory and often absent on CDN links, so the real size
  // is checked too — an oversized clip would otherwise OOM the isolate.
  if (bytes.byteLength > HIGGSFIELD_MAX_DOWNLOAD_BYTES) {
    throw new Error(`Higgsfield output is larger than the ${limitMb}MB limit`);
  }
  return bytes;
}

function contentTypeFor(url: string, mediaType: MediaType): string {
  const extension = (url.split("?")[0].match(/\.([a-z0-9]{2,4})$/i) || [])[1]?.toLowerCase();
  if (extension === "png") return "image/png";
  if (extension === "webp") return "image/webp";
  if (extension === "mp4") return "video/mp4";
  if (extension === "mov") return "video/quicktime";
  if (extension === "jpg" || extension === "jpeg") return "image/jpeg";
  return mediaType === "video" ? "video/mp4" : "image/jpeg";
}

/**
 * References travel to the worker as public CDN links rather than bytes: the
 * worker runs as a Vercel function, whose request body is capped at 4.5MB.
 */
async function prepareReferences(
  ctx: ActionCtx,
  storageIds: Parameters<typeof loadReferenceImages>[1],
): Promise<{ urls: string[]; b2Keys: string[]; count: number }> {
  const references = await loadReferenceImages(ctx, storageIds);
  if (references.length === 0) return { urls: [], b2Keys: [], count: 0 };

  const b2Keys = await persistReferenceImages(references);
  const urls: string[] = [];
  for (const key of b2Keys) {
    const url = publicMediaUrl(key);
    if (!url) {
      throw new Error(
        "MEDIA_BASE_URL is not configured in the Convex environment — Higgsfield needs a public URL for reference images.",
      );
    }
    urls.push(url);
  }
  return { urls, b2Keys, count: references.length };
}

function requireHiggsfieldModel(apiModel: string | undefined): ApiModelId {
  if (!apiModel || !isApiModelId(apiModel)) {
    throw new Error(`Generation is not bound to a known API model (got ${apiModel ?? "none"})`);
  }
  if (getApiModel(apiModel).provider !== "higgsfield") {
    throw new Error(`${apiModel} is not a Higgsfield model — it must not be processed here`);
  }
  return apiModel;
}

/** Submit, then poll until the job settles. Each worker call is short, so the
 *  Convex action ceiling is never the binding constraint. */
async function runJob(
  ctx: ActionCtx,
  credentials: string,
  request: HiggsfieldJobRequest,
  referenceUrls: string[],
  deadlineMs: number,
  startedAt: number,
  onSubmitted: (jobId: string) => Promise<void>,
): Promise<unknown> {
  const submitted = await callWorker(ctx, "/generate", {
    ...baseRequest(credentials),
    model: request.jobType,
    params: request.params,
    referenceUrls,
    mediaFlags: request.mediaFlags,
  });

  const jobId = jobIdOf(submitted.job);
  if (!jobId) throw new Error("Higgsfield accepted the job but returned no id");
  await onSubmitted(jobId);

  const deadline = startedAt + deadlineMs;
  // The last thing they actually said. A status we do not recognise reads as
  // still-running, so without this the job polls out its deadline and reports a
  // timeout — which is how a prompt refused on content grounds spent four
  // minutes pretending to generate and then blamed the clock.
  let lastStatuses: string[] = [];

  for (;;) {
    await sleep(HIGGSFIELD_POLL_INTERVAL_MS);
    if (Date.now() > deadline) {
      throw new HiggsfieldError(
        lastStatuses.length > 0
          ? `Higgsfield generation timed out — last state reported: ${[...new Set(lastStatuses)].join(", ")}`
          : "Higgsfield generation timed out before reporting any state",
        "timeout",
      );
    }

    let status: WorkerResponse;
    try {
      status = await callWorker(
        ctx,
        "/status",
        { ...baseRequest(credentials), jobId },
        HIGGSFIELD_POLL_REQUEST_TIMEOUT_MS,
      );
    } catch (error) {
      // A dead session will not fix itself; anything else may be transient and
      // the job is still running on their side.
      if (error instanceof HiggsfieldError && error.kind === "auth") throw error;
      continue;
    }

    const statuses = jobStatusesOf(status.job);
    if (statuses.length > 0) lastStatuses = statuses;

    const state = jobStateOf(status.job);
    if (state === "succeeded") return status.job;
    if (state === "failed") {
      const detail = findString(status.job, ["error", "message", "detail", "failure_reason"]);
      // Moderation is a fatal kind, so saying so is not cosmetic: it zeroes the
      // pre-flight estimate on a job nobody was charged for, and gives the tile
      // its "Rejected by moderation" headline instead of a bare "Failed".
      if (isModerationState(statuses)) {
        throw new HiggsfieldError(
          detail ?? `Higgsfield refused the prompt (${statuses.join(", ")})`,
          "moderation",
        );
      }
      throw new HiggsfieldError(
        detail ?? `Higgsfield reported a failed job (${statuses.join(", ")})`,
        "server",
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Generation
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
    const refIds = generation.referenceStorageIds ?? [];

    try {
      const model = requireHiggsfieldModel(generation.apiModel);
      const credentials = await loadCredentials(ctx);
      const references = await prepareReferences(ctx, refIds);

      const request = buildHiggsfieldJob({
        model,
        mediaType: "image",
        prompt: generation.prompt,
        aspectRatio: generation.aspectRatio,
        sizeTier: generation.resolution,
        referenceCount: references.count,
      });

      const job = await runJob(
        ctx,
        credentials,
        request,
        references.urls,
        HIGGSFIELD_IMAGE_DEADLINE_MS,
        startedAt,
        async (jobId) => {
          await ctx.runMutation(internal.grokGenerations.recordFalRequest, {
            id: args.generationId,
            falRequestId: jobId,
            endpoint: request.jobType,
          });
        },
      );

      const urls = findMediaUrls(job, "image");
      if (urls.length === 0) throw new Error("Higgsfield returned no media");

      const b2Keys: string[] = [];
      for (const url of urls) {
        // The poll deadline covers waiting; downloading and uploading has to
        // fit in the same budget, or Convex kills the isolate mid-flight and
        // no catch block ever runs. Same deadline the video path passes.
        const bytes = await downloadBytes(url, startedAt + HIGGSFIELD_ACTION_BUDGET_MS);
        b2Keys.push(
          await uploadMediaToB2(bytes, contentTypeFor(url, "image"), HIGGSFIELD_OUTPUT_PREFIX),
        );
      }

      const credits = creditsOf(job);

      await ctx.runMutation(internal.grokGenerations.markCompleted, {
        id: args.generationId,
        b2Keys,
        referenceB2Keys: references.b2Keys.length > 0 ? references.b2Keys : undefined,
        creditsUsed: credits,
        costEstimated: credits === undefined ? undefined : false,
      });

      await refreshBalanceInternal(ctx, credentials);
    } catch (error) {
      await ctx.runMutation(internal.grokGenerations.markFailed, {
        id: args.generationId,
        error: error instanceof Error ? error.message : String(error),
        errorKind: error instanceof HiggsfieldError ? error.kind : undefined,
      });
    }
  },
});

export const processVideo = internalAction({
  args: { generationId: v.id("grokGenerations"), userId: v.string() },
  handler: async (ctx, args) => {
    const startedAt = Date.now();
    const generation = await ctx.runQuery(internal.grokGenerations.getByIdInternal, {
      id: args.generationId,
    });
    if (!generation || generation.status !== "pending") return;

    await ctx.runMutation(internal.grokGenerations.markProcessing, { id: args.generationId });
    const refIds = generation.referenceStorageIds ?? [];

    try {
      const model = requireHiggsfieldModel(generation.apiModel);
      const credentials = await loadCredentials(ctx);
      const references = await prepareReferences(ctx, refIds);

      const request = buildHiggsfieldJob({
        model,
        mediaType: "video",
        prompt: generation.prompt,
        // With exactly one reference the frame defines the shape, so no ratio.
        aspectRatio: references.count === 1 ? undefined : generation.aspectRatio,
        durationSeconds: generation.duration,
        resolution: generation.resolution,
        videoJobType: generation.videoJobType,
        mode: generation.videoMode,
        generateAudio: generation.generateAudio,
        referenceCount: references.count,
      });

      const job = await runJob(
        ctx,
        credentials,
        request,
        references.urls,
        HIGGSFIELD_VIDEO_DEADLINE_MS,
        startedAt,
        async (jobId) => {
          await ctx.runMutation(internal.grokGenerations.recordFalRequest, {
            id: args.generationId,
            falRequestId: jobId,
            endpoint: request.jobType,
          });
        },
      );

      const urls = findMediaUrls(job, "video");
      if (urls.length === 0) throw new Error("Higgsfield returned no media");

      const bytes = await downloadBytes(urls[0], startedAt + HIGGSFIELD_ACTION_BUDGET_MS);
      const b2Key = await uploadMediaToB2(
        bytes,
        contentTypeFor(urls[0], "video"),
        HIGGSFIELD_OUTPUT_PREFIX,
      );
      const credits = creditsOf(job);

      await ctx.runMutation(internal.grokGenerations.markCompleted, {
        id: args.generationId,
        b2Keys: [b2Key],
        referenceB2Keys: references.b2Keys.length > 0 ? references.b2Keys : undefined,
        creditsUsed: credits,
        costEstimated: credits === undefined ? undefined : false,
      });

      await refreshBalanceInternal(ctx, credentials);
    } catch (error) {
      await ctx.runMutation(internal.grokGenerations.markFailed, {
        id: args.generationId,
        error: error instanceof Error ? error.message : String(error),
        errorKind: error instanceof HiggsfieldError ? error.kind : undefined,
      });
    }
  },
});

// ---------------------------------------------------------------------------
// Credits: balance and quotes
// ---------------------------------------------------------------------------

async function refreshBalanceInternal(ctx: ActionCtx, credentials: string): Promise<void> {
  try {
    // A fan-out finishes N jobs at once; without this they all ask at the same
    // moment, which is both wasteful and the riskiest time to rotate a token.
    const cached = await ctx.runQuery(internal.higgsfield.getAccountInternal, {});
    if (cached && Date.now() - cached.updatedAt < HIGGSFIELD_BALANCE_TTL_MS) return;
    const response = await callWorker(ctx, "/balance", baseRequest(credentials));
    const credits = creditsOf(response.account);
    if (credits === undefined) return;
    await ctx.runMutation(internal.higgsfield.storeAccount, {
      credits,
      planType: findString(response.account, ["plan_type", "plan"]),
      email: findString(response.account, ["email"]),
    });
  } catch (error) {
    // A stale balance is a cosmetic problem; never fail a generation over it.
    console.error("[higgsfield] balance refresh failed:", error);
  }
}

/** Refreshes the plan balance, skipping the call when the cached value is fresh. */
export const refreshBalance = action({
  args: { force: v.optional(v.boolean()) },
  handler: async (ctx, args): Promise<void> => {
    await requireAllowedUser(ctx);

    if (!args.force) {
      const cached = await ctx.runQuery(internal.higgsfield.getAccountInternal, {});
      if (cached && Date.now() - cached.updatedAt < HIGGSFIELD_BALANCE_TTL_MS) return;
    }
    await refreshBalanceInternal(ctx, await loadCredentials(ctx));
  },
});

/**
 * Quotes a configuration in credits, straight from Higgsfield.
 *
 * They publish no rate card, so the vendor's own `generate cost` is the only
 * honest source. Results are cached by signature — the same settings always
 * cost the same, and the prompt does not enter into it.
 */
export const estimateCost = action({
  args: {
    model: v.string(),
    mediaType: v.union(v.literal("image"), v.literal("video")),
    aspectRatio: v.optional(v.string()),
    /** `quality` or `resolution` for images — the widest price gap on Pro. */
    sizeTier: v.optional(v.string()),
    /** Higgsfield's video models differ in price by 3x; the default is not it. */
    videoJobType: v.optional(v.string()),
    videoMode: v.optional(v.string()),
    /** Priced on Kling: 10 credits with sound at 5s, 7.5 without. */
    generateAudio: v.optional(v.boolean()),
    duration: v.optional(v.number()),
    resolution: v.optional(v.string()),
    referenceCount: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<{ signature: string; credits: number | null }> => {
    await requireAllowedUser(ctx);

    const model = requireHiggsfieldModel(args.model);
    const request = buildHiggsfieldJob({
      model,
      mediaType: args.mediaType,
      // Cost does not depend on the wording, and a placeholder keeps the
      // signature stable across edits.
      prompt: "cost probe",
      aspectRatio: args.aspectRatio,
      sizeTier: args.sizeTier,
      videoJobType: args.videoJobType,
      mode: args.videoMode,
      generateAudio: args.generateAudio,
      durationSeconds: args.duration,
      resolution: args.resolution,
      referenceCount: args.referenceCount ?? 0,
    });
    const signature = costSignature(request);

    const cached = await ctx.runQuery(internal.higgsfield.getCostInternal, { signature });
    if (cached && Date.now() - cached.updatedAt < HIGGSFIELD_COST_TTL_MS) {
      return { signature, credits: cached.credits };
    }

    try {
      const credentials = await loadCredentials(ctx);
      const response = await callWorker(ctx, "/cost", {
        ...baseRequest(credentials),
        model: request.jobType,
        params: request.params,
      });
      const credits = creditsOf(response.cost);
      if (credits === undefined) return { signature, credits: cached?.credits ?? null };
      await ctx.runMutation(internal.higgsfield.storeCost, { signature, credits });
      return { signature, credits };
    } catch (error) {
      console.error("[higgsfield] cost estimate failed:", error);
      // Fall back to whatever was last known rather than blanking the price.
      return { signature, credits: cached?.credits ?? null };
    }
  },
});
