"use node";

import { createHash, randomBytes } from "node:crypto";
import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { action, internalAction, type ActionCtx } from "./_generated/server";
import { requireAllowedUser } from "./authz";
import {
  buildRunpodCreateRequest,
  buildRunpodNewerCudaDeployInput,
  clampRunpodContainerDiskGb,
  clampRunpodVolumeDiskGb,
  DEFAULT_RUNPOD_MAX_HOURLY_USD,
  isRunpodCleanupRetry,
  isRunpodNoCapacity,
  mapRunpodPodState,
  normalizeRunpodGpuTypes,
  parseRunpodJsonText,
  runpodInstanceUrls,
  runpodPublicUrl,
  shouldCleanupRunpodBackend,
  type RunpodCloudType,
  type RunpodGpuType,
  type RunpodTemplateProfile,
} from "../../shared/runpod-backend";
import {
  encodeSkipModels,
  MAX_SKIP_MODELS,
  SKIP_MODELS_ENV,
} from "../../shared/pod-model-selection";
import { probeComfyuiSystemStats } from "./comfyuiTarget";
import { purposeValidator, type RunpodPurpose } from "./runpodBackendStore";

const RUNPOD_REST_API = "https://rest.runpod.io/v1";
const RUNPOD_GRAPHQL_API = "https://api.runpod.io/graphql";

function configured(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new ConvexError(`${name} is not configured on this Convex deployment`);
  return value;
}

class RunpodApiError extends ConvexError<string> {
  constructor(
    message: string,
    readonly status?: number,
    readonly uncertain = false,
  ) {
    super(message);
  }
}

async function runpodRest(path: string, init: RequestInit = {}): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(`${RUNPOD_REST_API}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${configured("RUNPOD_API_KEY")}`,
        "Content-Type": "application/json",
        ...init.headers,
      },
      signal: AbortSignal.timeout(30_000),
    });
  } catch (error) {
    throw new RunpodApiError(
      `RunPod is unreachable (${error instanceof Error ? error.message : String(error)})`,
      undefined,
      true,
    );
  }
  const body = await response
    .text()
    .then(parseRunpodJsonText)
    .catch(() => null);
  if (!response.ok) {
    const row = body && typeof body === "object" ? (body as Record<string, unknown>) : null;
    const detail = String(row?.error ?? row?.message ?? response.statusText);
    throw new RunpodApiError(
      `RunPod request failed (${response.status}): ${detail}`,
      response.status,
      response.status >= 500 && !isRunpodNoCapacity(detail),
    );
  }
  return body;
}

async function deleteRunpodPod(podId: string): Promise<void> {
  try {
    await runpodRest(`/pods/${encodeURIComponent(podId)}`, { method: "DELETE" });
  } catch (error) {
    // Deletion is idempotent from ArtSnack's perspective. A pod that is already
    // absent cannot bill, so a RunPod 404 is the desired terminal result.
    if (error instanceof RunpodApiError && error.status === 404) return;
    throw error;
  }
}

async function runpodGraphql(query: string, variables?: Record<string, unknown>): Promise<unknown> {
  const endpoint = new URL(RUNPOD_GRAPHQL_API);
  endpoint.searchParams.set("api_key", configured("RUNPOD_API_KEY"));
  let response: Response;
  try {
    response = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (error) {
    throw new RunpodApiError(
      `RunPod marketplace is unreachable (${error instanceof Error ? error.message : String(error)})`,
      undefined,
      true,
    );
  }
  const body = await response.json().catch(() => null);
  const errors =
    body && typeof body === "object" ? (body as Record<string, unknown>).errors : undefined;
  if (!response.ok || (Array.isArray(errors) && errors.length > 0)) {
    const first = Array.isArray(errors)
      ? (errors[0] as { message?: unknown } | undefined)
      : undefined;
    const detail = typeof first?.message === "string" ? `: ${first.message}` : "";
    throw new RunpodApiError(`RunPod marketplace request failed (${response.status})${detail}`);
  }
  return body;
}

async function fetchGpuTypes(): Promise<RunpodGpuType[]> {
  return normalizeRunpodGpuTypes(
    await runpodGraphql(`query ArtSnackGpuTypes {
      gpuTypes {
        id
        displayName
        memoryInGb
        cudaCores
        secureCloud
        communityCloud
        secure1: lowestPrice(input: { gpuCount: 1, secureCloud: true }) { uninterruptablePrice stockStatus availableGpuCounts }
        secure2: lowestPrice(input: { gpuCount: 2, secureCloud: true }) { uninterruptablePrice stockStatus availableGpuCounts }
        secure3: lowestPrice(input: { gpuCount: 3, secureCloud: true }) { uninterruptablePrice stockStatus availableGpuCounts }
        secure4: lowestPrice(input: { gpuCount: 4, secureCloud: true }) { uninterruptablePrice stockStatus availableGpuCounts }
        secure8: lowestPrice(input: { gpuCount: 8, secureCloud: true }) { uninterruptablePrice stockStatus availableGpuCounts }
        community1: lowestPrice(input: { gpuCount: 1, secureCloud: false }) { uninterruptablePrice stockStatus availableGpuCounts }
        community2: lowestPrice(input: { gpuCount: 2, secureCloud: false }) { uninterruptablePrice stockStatus availableGpuCounts }
        community3: lowestPrice(input: { gpuCount: 3, secureCloud: false }) { uninterruptablePrice stockStatus availableGpuCounts }
        community4: lowestPrice(input: { gpuCount: 4, secureCloud: false }) { uninterruptablePrice stockStatus availableGpuCounts }
        community8: lowestPrice(input: { gpuCount: 8, secureCloud: false }) { uninterruptablePrice stockStatus availableGpuCounts }
      }
    }`),
  );
}

export const gpuTypes = action({
  args: {},
  handler: async (ctx): Promise<RunpodGpuType[]> => {
    await requireAllowedUser(ctx);
    return fetchGpuTypes();
  },
});

export const accountBalance = action({
  args: {},
  handler: async (ctx): Promise<number | null> => {
    await requireAllowedUser(ctx);
    const body = await runpodGraphql("query ArtSnackBalance { myself { clientBalance } }");
    const data = body && typeof body === "object" ? (body as Record<string, unknown>).data : null;
    const myself =
      data && typeof data === "object" ? (data as Record<string, unknown>).myself : null;
    const balance =
      myself && typeof myself === "object"
        ? Number((myself as Record<string, unknown>).clientBalance)
        : Number.NaN;
    return Number.isFinite(balance) ? balance : null;
  },
});

function hardHourlyCap(): number {
  const value = Number(process.env.RUNPOD_MAX_HOURLY_USD);
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_RUNPOD_MAX_HOURLY_USD;
}

function templateId(profile: RunpodTemplateProfile): string {
  return configured(
    profile === "cuda13.0" ? "RUNPOD_TEMPLATE_CUDA_13_0_ID" : "RUNPOD_TEMPLATE_CUDA_12_8_ID",
  );
}

function convexSiteUrl(): string {
  const value = configured("CONVEX_SITE_URL").replace(/\/+$/, "");
  const url = new URL(value);
  if (url.protocol !== "https:" || !url.hostname.endsWith(".convex.site")) {
    throw new ConvexError("CONVEX_SITE_URL must be an https://*.convex.site URL");
  }
  return value;
}

function backendEnvironment(
  backendId: Id<"runpodBackends">,
  progressToken: string,
  purpose: RunpodPurpose,
  skipModels: string | undefined,
): Record<string, string> {
  return {
    // provision.sh's switch between the SDXL manifest and the MiniMax H3 set.
    ARTSNACK_PROFILE: purpose,
    POD_URL_SECRET: configured("POD_URL_SECRET"),
    ARTSNACK_BACKEND_ID: backendId,
    ARTSNACK_PROGRESS_TOKEN: progressToken,
    ARTSNACK_PROVIDER: "runpod-managed",
    CONVEX_SITE_URL: convexSiteUrl(),
    MODELS_DIR: "/comfy-models",
    FORCE_COMFYUI_RESTART: "1",
    // Optional. Lifts Hugging Face's per-IP limit on anonymous downloads,
    // which the video pod's H3 base set (~65 GB from HF) can hit.
    ...(process.env.HF_TOKEN?.trim() ? { HF_TOKEN: process.env.HF_TOKEN.trim() } : {}),
    // The models unchecked in the launch dialog. A Stop/Start keeps the env,
    // so the pod re-downloads the same selection after its disk is wiped.
    ...(skipModels ? { [SKIP_MODELS_ENV]: skipModels } : {}),
  };
}

function priceFor(gpu: RunpodGpuType, cloudType: RunpodCloudType, gpuCount: number): number | null {
  const cloud = cloudType === "SECURE" ? gpu.secure : gpu.community;
  return (
    cloud.totalHourlyUsdByGpuCount.find((price) => price.gpuCount === gpuCount)?.hourlyUsd ??
    (cloud.hourlyUsd === null ? null : cloud.hourlyUsd * gpuCount)
  );
}

function countsFor(gpu: RunpodGpuType, cloudType: RunpodCloudType): number[] {
  return cloudType === "SECURE" ? gpu.secure.availableGpuCounts : gpu.community.availableGpuCounts;
}

function podRecord(body: unknown): Record<string, unknown> | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const row = body as Record<string, unknown>;
  if (row.pod && typeof row.pod === "object" && !Array.isArray(row.pod)) {
    return row.pod as Record<string, unknown>;
  }
  return row;
}

function podIdFrom(body: unknown): string | undefined {
  const id = podRecord(body)?.id;
  return typeof id === "string" && id.trim() ? id.trim() : undefined;
}

function podHourlyUsd(body: unknown): number | null {
  const row = podRecord(body);
  const value = Number(row?.adjustedCostPerHr ?? row?.costPerHr);
  return Number.isFinite(value) && value >= 0 ? value : null;
}

export const launch = action({
  args: {
    gpuTypeId: v.string(),
    gpuName: v.string(),
    gpuCount: v.number(),
    cloudType: v.union(v.literal("SECURE"), v.literal("COMMUNITY")),
    templateProfile: v.union(v.literal("cuda12.8"), v.literal("cuda13.0")),
    containerDiskGb: v.number(),
    volumeDiskGb: v.number(),
    minDiskBandwidthMBps: v.number(),
    minDownloadMbps: v.number(),
    displayedHourlyUsd: v.number(),
    maxHourlyUsd: v.number(),
    /** Absent = image, so the iOS app and older web builds launch what they
     *  always launched. */
    purpose: v.optional(purposeValidator),
    /** `dir|filename` of each model the launch dialog left unchecked.
     *  Absent = the whole manifest. */
    skipModels: v.optional(v.array(v.string())),
  },
  handler: async (ctx, args): Promise<{ podId: string }> => {
    await requireAllowedUser(ctx);
    const purpose = args.purpose ?? "image";
    // H3's int8 kernels want torch cu130, which only the CUDA 13.0 template's
    // image carries — a video pod on the 12.8 template boots and then fails
    // every generation, so the choice is not offered.
    const templateProfile: RunpodTemplateProfile =
      purpose === "video" ? "cuda13.0" : args.templateProfile;
    const containerDiskGb = clampRunpodContainerDiskGb(args.containerDiskGb);
    const volumeDiskGb = clampRunpodVolumeDiskGb(args.volumeDiskGb);
    const gpu = (await fetchGpuTypes()).find((candidate) => candidate.id === args.gpuTypeId);
    if (!gpu) throw new ConvexError("That GPU type is no longer available. Refresh the list.");
    const normalizedGpuCount = Math.max(1, Math.round(args.gpuCount));
    const hourlyUsd = priceFor(gpu, args.cloudType, normalizedGpuCount);
    if (hourlyUsd === null) {
      throw new ConvexError(`No ${args.cloudType.toLowerCase()} RunPod capacity is available.`);
    }
    const availableCounts = countsFor(gpu, args.cloudType);
    if (availableCounts.length > 0 && !availableCounts.includes(Math.round(args.gpuCount))) {
      throw new ConvexError("That GPU count is no longer in stock. Refresh the list.");
    }
    const requestedCap =
      Number.isFinite(args.maxHourlyUsd) && args.maxHourlyUsd > 0
        ? args.maxHourlyUsd
        : hardHourlyCap();
    const cap = Math.min(hardHourlyCap(), requestedCap);
    if (hourlyUsd > cap) {
      throw new ConvexError(
        `This selection starts at $${hourlyUsd.toFixed(2)}/hr; the server safety cap is $${cap.toFixed(2)}/hr.`,
      );
    }
    if (hourlyUsd > args.displayedHourlyUsd * 1.1 + 0.01) {
      throw new ConvexError("RunPod pricing changed by more than 10%. Refresh and confirm again.");
    }

    if ((args.skipModels?.length ?? 0) > MAX_SKIP_MODELS) {
      throw new ConvexError("Too many models in the selection.");
    }
    const skipModels = encodeSkipModels(args.skipModels ?? []);

    const selectedTemplateId = templateId(templateProfile);
    configured("POD_URL_SECRET");
    convexSiteUrl();

    const launchName = `artsnack-${purpose === "video" ? "h3video" : "comfyui"}-${Date.now()}-${randomBytes(4).toString("hex")}`;
    const progressToken = randomBytes(32).toString("hex");
    const progressTokenHash = createHash("sha256").update(progressToken).digest("hex");
    const backendId = await ctx.runMutation(internal.runpodBackendStore.reserve, {
      launchName,
      progressTokenHash,
      gpuTypeId: gpu.id,
      gpuName: gpu.displayName,
      numGpus: normalizedGpuCount,
      cloudType: args.cloudType,
      templateProfile,
      templateId: selectedTemplateId,
      purpose,
      containerDiskGb,
      volumeDiskGb,
      hourlyUsd,
      maxHourlyUsd: cap,
    });

    let createdPodId: string | undefined;
    try {
      const request = {
        name: launchName,
        templateId: selectedTemplateId,
        gpuTypeId: gpu.id,
        gpuCount: args.gpuCount,
        cloudType: args.cloudType,
        templateProfile,
        containerDiskGb,
        volumeDiskGb,
        minDiskBandwidthMBps: args.minDiskBandwidthMBps,
        minDownloadMbps: args.minDownloadMbps,
        env: backendEnvironment(backendId, progressToken, purpose, skipModels),
        comfyPerGpu: purpose === "video",
      };
      let body: unknown;
      try {
        body = await runpodRest("/pods", {
          method: "POST",
          body: JSON.stringify(buildRunpodCreateRequest(request)),
        });
      } catch (error) {
        // REST can only ask for CUDA "13.0" exactly; hosts on a newer driver
        // run the 13.0 image just as well and are reachable only via GraphQL.
        if (
          templateProfile !== "cuda13.0" ||
          !(error instanceof RunpodApiError) ||
          !isRunpodNoCapacity(error.message)
        ) {
          throw error;
        }
        try {
          body = podRecord(
            (
              (await runpodGraphql(
                `mutation ArtSnackDeploy($input: PodFindAndDeployOnDemandInput!) {
                  podFindAndDeployOnDemand(input: $input) { id costPerHr adjustedCostPerHr }
                }`,
                { input: buildRunpodNewerCudaDeployInput(request) },
              )) as { data?: { podFindAndDeployOnDemand?: unknown } }
            ).data?.podFindAndDeployOnDemand,
          );
        } catch (deployError) {
          // Only "no capacity" proves nothing was rented. Any other GraphQL
          // error may have come after the pod was placed, so the launch stays
          // locked and the reconciler looks for it by name.
          if (deployError instanceof RunpodApiError && isRunpodNoCapacity(deployError.message)) {
            throw deployError;
          }
          throw new RunpodApiError(
            deployError instanceof Error ? deployError.message : String(deployError),
            undefined,
            true,
          );
        }
      }
      createdPodId = podIdFrom(body);
      if (!createdPodId) {
        throw new RunpodApiError(
          "RunPod may have created the pod but returned no pod id",
          undefined,
          true,
        );
      }
      const actualHourlyUsd = podHourlyUsd(body);
      if (actualHourlyUsd !== null && actualHourlyUsd > cap) {
        throw new RunpodApiError(
          `RunPod placed the pod at $${actualHourlyUsd.toFixed(2)}/hr, above the $${cap.toFixed(2)}/hr cap.`,
        );
      }
      await ctx.runMutation(internal.runpodBackendStore.attachPod, {
        id: backendId,
        podId: createdPodId,
        publicUrl: runpodPublicUrl(createdPodId),
        hourlyUsd: actualHourlyUsd ?? undefined,
      });
      return { podId: createdPodId };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (createdPodId) {
        try {
          await deleteRunpodPod(createdPodId);
          await ctx.runMutation(internal.runpodBackendStore.setProviderState, {
            id: backendId,
            state: "destroyed",
            providerStatus: "TERMINATED",
            message: "Launch did not finish; the paid pod was destroyed automatically.",
            error: message,
          });
        } catch (cleanupError) {
          await ctx.runMutation(internal.runpodBackendStore.setProviderState, {
            id: backendId,
            state: "error",
            providerStatus: "cleanup_required",
            message: "Launch failed and automatic cleanup must be retried.",
            error: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
          });
        }
      } else if (error instanceof RunpodApiError && !error.uncertain) {
        await ctx.runMutation(internal.runpodBackendStore.failReservation, {
          id: backendId,
          message,
        });
      } else {
        await ctx.runMutation(internal.runpodBackendStore.markLaunchUncertain, {
          id: backendId,
          message: "RunPod did not confirm whether the pod was created; reconciling by name…",
        });
      }
      throw error;
    }
  },
});

async function activeBackend(ctx: ActionCtx, id: Id<"runpodBackends">) {
  const row = await ctx.runQuery(internal.runpodBackendStore.activeById, { id });
  if (!row?.active || !row.podId) throw new ConvexError("No active managed RunPod pod found");
  return { ...row, podId: row.podId };
}

export const refresh = action({
  args: { id: v.id("runpodBackends") },
  handler: async (ctx, args) => {
    await requireAllowedUser(ctx);
    const row = await activeBackend(ctx, args.id);
    let body: unknown;
    try {
      body = await runpodRest(`/pods/${encodeURIComponent(row.podId)}`);
    } catch (error) {
      if (!(error instanceof RunpodApiError) || error.status !== 404) throw error;
      await ctx.runMutation(internal.runpodBackendStore.setProviderState, {
        id: args.id,
        state: "destroyed",
        providerStatus: "TERMINATED",
        message: "The RunPod pod no longer exists; billing has stopped.",
      });
      return { state: "destroyed" as const, providerStatus: "TERMINATED" };
    }
    const mapped = mapRunpodPodState(body);
    const providerStatus = String(podRecord(body)?.desiredStatus ?? podRecord(body)?.status ?? "");
    if (mapped === "running" && row.state === "stopped") {
      await ctx.runMutation(internal.runpodBackendStore.beginStart, { id: args.id });
    }
    if (mapped === "stopped" || mapped === "destroyed" || mapped === "error") {
      await ctx.runMutation(internal.runpodBackendStore.setProviderState, {
        id: args.id,
        state: mapped,
        providerStatus,
        message:
          mapped === "stopped"
            ? "RunPod is stopped. Container-disk contents were erased."
            : mapped === "destroyed"
              ? "RunPod was destroyed; billing has stopped."
              : "RunPod reported an error.",
      });
    }
    return { state: mapped, providerStatus };
  },
});

export const start = action({
  args: { id: v.id("runpodBackends") },
  handler: async (ctx, args) => {
    await requireAllowedUser(ctx);
    const row = await activeBackend(ctx, args.id);
    const begun = await ctx.runMutation(internal.runpodBackendStore.beginStart, { id: args.id });
    if (!begun) throw new ConvexError("The RunPod backend can no longer be started");
    try {
      await runpodRest(`/pods/${encodeURIComponent(row.podId)}/start`, { method: "POST" });
    } catch (error) {
      await ctx.runMutation(internal.runpodBackendStore.restoreStoppedIfRevision, {
        id: args.id,
        expectedRevision: begun.lifecycleRevision,
        message: "RunPod did not start. The pod remains stopped.",
      });
      throw error;
    }
  },
});

export const stop = action({
  args: { id: v.id("runpodBackends") },
  handler: async (ctx, args) => {
    await requireAllowedUser(ctx);
    const row = await activeBackend(ctx, args.id);
    await runpodRest(`/pods/${encodeURIComponent(row.podId)}/stop`, { method: "POST" });
    await ctx.runMutation(internal.runpodBackendStore.setProviderState, {
      id: args.id,
      state: "stopped",
      providerStatus: "EXITED",
      message: "RunPod is stopped. The disposable container disk has been erased.",
    });
  },
});

export const destroy = action({
  args: { id: v.id("runpodBackends") },
  handler: async (ctx, args) => {
    await requireAllowedUser(ctx);
    const row = await activeBackend(ctx, args.id);
    await ctx.runMutation(internal.runpodBackendStore.setProviderState, {
      id: args.id,
      state: "destroying",
      providerStatus: "TERMINATING",
      message: "Destroying the RunPod pod and stopping all billing…",
    });
    await deleteRunpodPod(row.podId);
    await ctx.runMutation(internal.runpodBackendStore.setProviderState, {
      id: args.id,
      state: "destroyed",
      providerStatus: "TERMINATED",
      message: "RunPod was destroyed; all compute and storage billing has stopped.",
    });
  },
});

function podList(body: unknown): Record<string, unknown>[] {
  const rows = Array.isArray(body)
    ? body
    : body && typeof body === "object" && Array.isArray((body as Record<string, unknown>).pods)
      ? ((body as Record<string, unknown>).pods as unknown[])
      : [];
  return rows.filter((row): row is Record<string, unknown> =>
    Boolean(row && typeof row === "object" && !Array.isArray(row)),
  );
}

export const reconcileLaunch = internalAction({
  args: { id: v.id("runpodBackends"), attempt: v.number() },
  handler: async (ctx, args) => {
    const row = await ctx.runQuery(internal.runpodBackendStore.activeById, { id: args.id });
    if (!row?.active || row.podId) return;
    try {
      const match = podList(await runpodRest("/pods")).find(
        (candidate) => candidate.name === row.launchName,
      );
      const podId = podIdFrom(match);
      if (podId) {
        const actualHourlyUsd = podHourlyUsd(match);
        await ctx.runMutation(internal.runpodBackendStore.attachPod, {
          id: args.id,
          podId,
          publicUrl: runpodPublicUrl(podId),
          hourlyUsd: actualHourlyUsd ?? undefined,
        });
        if (actualHourlyUsd !== null && actualHourlyUsd > row.maxHourlyUsd) {
          try {
            await deleteRunpodPod(podId);
            await ctx.runMutation(internal.runpodBackendStore.setProviderState, {
              id: args.id,
              state: "destroyed",
              providerStatus: "TERMINATED",
              message: `RunPod placed the recovered pod at $${actualHourlyUsd.toFixed(2)}/hr, above the $${row.maxHourlyUsd.toFixed(2)}/hr cap. It was destroyed automatically.`,
            });
          } catch (error) {
            await ctx.runMutation(internal.runpodBackendStore.setProviderState, {
              id: args.id,
              state: "error",
              providerStatus: "cleanup_required",
              message: "The recovered pod exceeded the price cap. Automatic cleanup is retrying.",
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }
        return;
      }
      if (args.attempt >= 5) {
        await ctx.runMutation(internal.runpodBackendStore.failReservation, {
          id: args.id,
          message: "RunPod did not create a matching pod. The launch lock was released.",
        });
        return;
      }
    } catch {
      // A read failure is uncertain; keep the lock and retry instead of risking
      // a duplicate paid pod from a second launch click.
    }
    await ctx.runMutation(internal.runpodBackendStore.scheduleLaunchReconcile, {
      id: args.id,
      attempt: args.attempt,
    });
  },
});

export const verifyReady = internalAction({
  args: {
    id: v.id("runpodBackends"),
    expectedRevision: v.number(),
    attempt: v.number(),
  },
  handler: async (ctx, args) => {
    const row = await ctx.runQuery(internal.runpodBackendStore.activeById, { id: args.id });
    if (
      !row?.active ||
      row.lifecycleRevision !== args.expectedRevision ||
      row.stage !== "verifying"
    ) {
      return;
    }
    if (await probeComfyuiSystemStats(row.publicUrl, {})) {
      // A multi-GPU video pod: record which per-GPU ComfyUIs answer, so jobs
      // are only ever sent to one that is actually up.
      let instanceUrls: string[] | undefined;
      if (row.purpose === "video" && row.numGpus > 1 && row.podId) {
        const candidates = runpodInstanceUrls(row.podId, row.numGpus);
        const up = await Promise.all(
          candidates.map((url, index) =>
            index === 0 ? Promise.resolve(true) : probeComfyuiSystemStats(url, {}),
          ),
        );
        instanceUrls = candidates.filter((_, index) => up[index]);
      }
      await ctx.runMutation(internal.runpodBackendStore.setReadyIfRevision, {
        id: args.id,
        expectedRevision: args.expectedRevision,
        instanceUrls,
      });
      return;
    }
    await ctx.runMutation(internal.runpodBackendStore.scheduleReadyRetry, {
      id: args.id,
      expectedRevision: args.expectedRevision,
      attempt: args.attempt,
    });
  },
});

export const cleanupProvisioning = internalAction({
  args: {
    id: v.id("runpodBackends"),
    expectedRevision: v.number(),
    attempt: v.number(),
  },
  handler: async (ctx, args) => {
    const snapshot = await ctx.runQuery(internal.runpodBackendStore.activeById, { id: args.id });
    const now = Date.now();
    const retryingClaim = isRunpodCleanupRetry(snapshot, {
      lifecycleRevision: args.expectedRevision,
      attempt: args.attempt,
    });
    if (
      !retryingClaim &&
      !shouldCleanupRunpodBackend(snapshot, {
        lifecycleRevision: args.expectedRevision,
        now,
      })
    ) {
      return;
    }
    const claim = await ctx.runMutation(internal.runpodBackendStore.claimCleanup, {
      id: args.id,
      expectedRevision: args.expectedRevision,
      now,
    });
    if (!claim) return;
    try {
      await deleteRunpodPod(claim.podId);
      await ctx.runMutation(internal.runpodBackendStore.finishCleanup, {
        id: args.id,
        expectedRevision: claim.lifecycleRevision,
        message: "Provisioning timed out; the paid RunPod pod was destroyed automatically.",
      });
    } catch (error) {
      await ctx.runMutation(internal.runpodBackendStore.scheduleCleanupRetry, {
        id: args.id,
        expectedRevision: claim.lifecycleRevision,
        attempt: args.attempt,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  },
});
