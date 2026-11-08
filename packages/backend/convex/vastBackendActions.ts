"use node";

import { createHash, randomBytes } from "node:crypto";
import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { action, internalAction, type ActionCtx } from "./_generated/server";
import { requireAllowedUser } from "./authz";
import {
  buildVastCreateRequest,
  buildVastOfferLookupSearch,
  buildVastOfferSearch,
  buildVastStartupScript,
  clampVastDiskGb,
  DEFAULT_MAX_HOURLY_USD,
  mapVastInstanceState,
  normalizeVastGpuTypes,
  normalizeVastOffers,
  parseVastInstanceLookup,
  shouldCleanupVastBackend,
  type VastOffer,
  type VastOfferFilters,
  type VastGpuType,
} from "../../shared/vast-backend";
import { comfyAuthHeadersForUrl } from "../../shared/comfyui-auth";
import {
  encodeSkipModels,
  MAX_SKIP_MODELS,
  SKIP_MODELS_ENV,
} from "../../shared/pod-model-selection";
import { probeComfyuiSystemStats } from "./comfyuiTarget";
import { noCacheFetch } from "../../shared/no-cdn-cache";

const VAST_ORIGIN = "https://console.vast.ai";
const VAST_API = `${VAST_ORIGIN}/api/v0`;

function configured(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new ConvexError(`${name} is not configured on this Convex deployment`);
  return value;
}

/**
 * The ComfyUI image every Vast machine boots — what .github/workflows/vast-image.yml
 * pushes to GHCR, pinned by digest (`ghcr.io/<owner>/artsnack-comfyui-vast@sha256:…`).
 * There is no default: a guessed image would rent a GPU that never comes up.
 */
function vastImage(): string {
  return configured("VAST_IMAGE");
}

class VastApiError extends ConvexError<string> {
  constructor(
    message: string,
    readonly status?: number,
    readonly uncertain = false,
  ) {
    super(message);
  }
}

async function vastRequest(
  path: string,
  init: RequestInit = {},
  options: { requireSuccess?: boolean } = {},
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(`${path.startsWith("/api/") ? VAST_ORIGIN : VAST_API}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${configured("VAST_API_KEY")}`,
        "Content-Type": "application/json",
        ...init.headers,
      },
      signal: AbortSignal.timeout(30_000),
    });
  } catch (error) {
    throw new VastApiError(
      `Vast.ai is unreachable (${error instanceof Error ? error.message : String(error)})`,
      undefined,
      true,
    );
  }

  const body = await response.json().catch(() => null);
  if (!response.ok) {
    const detail =
      body && typeof body === "object"
        ? String(
            (body as Record<string, unknown>).msg ??
              (body as Record<string, unknown>).error ??
              response.statusText,
          )
        : response.statusText;
    throw new VastApiError(
      `Vast.ai request failed (${response.status}): ${detail}`,
      response.status,
      response.status >= 500,
    );
  }
  if (
    options.requireSuccess &&
    body &&
    typeof body === "object" &&
    (body as Record<string, unknown>).success === false
  ) {
    const detail = String(
      (body as Record<string, unknown>).msg ??
        (body as Record<string, unknown>).error ??
        "Vast.ai rejected the operation",
    );
    throw new VastApiError(detail, response.status, false);
  }
  return body;
}

async function searchOffers(filters: VastOfferFilters): Promise<VastOffer[]> {
  const body = await vastRequest("/bundles/", {
    method: "POST",
    body: JSON.stringify(buildVastOfferSearch(filters)),
  });
  const offers =
    body && typeof body === "object" ? (body as Record<string, unknown>).offers : undefined;
  return normalizeVastOffers(offers);
}

async function findOffer(offerId: number, diskGb: number): Promise<VastOffer | undefined> {
  const body = await vastRequest("/bundles/", {
    method: "POST",
    body: JSON.stringify(buildVastOfferLookupSearch(offerId, diskGb)),
  });
  const rows = body && typeof body === "object" ? (body as Record<string, unknown>).offers : [];
  return normalizeVastOffers(rows).find((candidate) => candidate.id === offerId);
}

const sortValidator = v.union(
  v.literal("price"),
  v.literal("value"),
  v.literal("disk"),
  v.literal("download"),
);

export const offers = action({
  args: {
    gpuName: v.optional(v.string()),
    numGpus: v.number(),
    diskGb: v.number(),
    minDiskBandwidth: v.optional(v.number()),
    minDownloadMbps: v.optional(v.number()),
    minReliability: v.optional(v.number()),
    maxHourlyUsd: v.optional(v.number()),
    sort: sortValidator,
  },
  handler: async (ctx, args): Promise<VastOffer[]> => {
    await requireAllowedUser(ctx);
    return searchOffers(args);
  },
});

function gpuNamesFromResponse(body: unknown): string[] {
  const names =
    body && typeof body === "object" ? (body as Record<string, unknown>).gpu_names : undefined;
  return Array.isArray(names)
    ? names.filter((name): name is string => typeof name === "string").sort()
    : [];
}

async function availableGpuNames(): Promise<string[]> {
  return gpuNamesFromResponse(await vastRequest("/gpu_names/unique/"));
}

/** Compatibility action for frontends deployed before the rich GPU catalog. */
export const gpuNames = action({
  args: {},
  handler: async (ctx): Promise<string[]> => {
    await requireAllowedUser(ctx);
    return availableGpuNames();
  },
});

export const gpuTypes = action({
  args: {},
  handler: async (ctx): Promise<VastGpuType[]> => {
    await requireAllowedUser(ctx);
    const [names, typeBody] = await Promise.all([
      availableGpuNames(),
      // The names endpoint keeps the picker usable if Vast changes or briefly
      // removes the richer metadata endpoint used by its own marketplace UI.
      vastRequest("/gpu_types/").catch(() => null),
    ]);
    const typeByName = new Map(normalizeVastGpuTypes(typeBody).map((gpu) => [gpu.name, gpu]));
    return names.map(
      (name): VastGpuType =>
        typeByName.get(name) ?? {
          name,
          gpuRamMb: 0,
          computeCapability: 0,
          cudaCores: 0,
          architecture: "",
          category: "",
        },
    );
  },
});

export const accountCredit = action({
  args: {},
  handler: async (ctx): Promise<number | null> => {
    await requireAllowedUser(ctx);
    const body = await vastRequest("/users/current/");
    if (!body || typeof body !== "object") return null;
    const credit = Number((body as Record<string, unknown>).credit);
    return Number.isFinite(credit) ? credit : null;
  },
});

function hardHourlyCap(): number {
  const configuredCap = Number(process.env.VAST_MAX_HOURLY_USD);
  return Number.isFinite(configuredCap) && configuredCap > 0
    ? configuredCap
    : DEFAULT_MAX_HOURLY_USD;
}

function deploymentConvexSiteUrl(): string {
  const value = process.env.CONVEX_SITE_URL?.trim().replace(/\/+$/, "");
  if (!value) {
    throw new ConvexError("Convex did not provide its system CONVEX_SITE_URL");
  }
  const url = new URL(value);
  if (url.protocol !== "https:" || !url.hostname.endsWith(".convex.site")) {
    throw new ConvexError("CONVEX_SITE_URL must be an https://*.convex.site URL");
  }
  return value;
}

function validateLaunchEnvironment(): string {
  vastImage();
  configured("POD_URL_SECRET");
  configured("CF_TUNNEL_TOKEN");
  deploymentConvexSiteUrl();
  const publicUrl = configured("VAST_BACKEND_PUBLIC_URL").replace(/\/+$/, "");
  const url = new URL(publicUrl);
  if (url.protocol !== "https:") {
    throw new ConvexError("VAST_BACKEND_PUBLIC_URL must be an https URL");
  }
  return publicUrl;
}

function backendEnvironment(
  backendId: Id<"vastBackends">,
  progressToken: string,
  skipModels: string | undefined,
): Record<string, string> {
  return {
    POD_URL_SECRET: configured("POD_URL_SECRET"),
    CF_TUNNEL_TOKEN: configured("CF_TUNNEL_TOKEN"),
    ARTSNACK_BACKEND_ID: backendId,
    ARTSNACK_PROGRESS_TOKEN: progressToken,
    ARTSNACK_PROVIDER: "vast",
    CONVEX_SITE_URL: deploymentConvexSiteUrl(),
    COMFYUI_PUBLIC_URL: configured("VAST_BACKEND_PUBLIC_URL").replace(/\/+$/, ""),
    COMFYUI_PORT: "8288",
    MODELS_DIR: "/workspace/comfy-models",
    FORCE_COMFYUI_RESTART: "1",
    // The models unchecked in the launch dialog; see the RunPod action.
    ...(skipModels ? { [SKIP_MODELS_ENV]: skipModels } : {}),
  };
}

export const launch = action({
  args: {
    offerId: v.number(),
    diskGb: v.number(),
    displayedHourlyUsd: v.number(),
    /** `dir|filename` of each model the launch dialog left unchecked.
     *  Absent = the whole manifest. */
    skipModels: v.optional(v.array(v.string())),
  },
  handler: async (ctx, args): Promise<{ instanceId: number }> => {
    await requireAllowedUser(ctx);
    if ((args.skipModels?.length ?? 0) > MAX_SKIP_MODELS) {
      throw new ConvexError("Too many models in the selection.");
    }
    const diskGb = clampVastDiskGb(args.diskGb);
    const cap = hardHourlyCap();
    const offer = await findOffer(args.offerId, diskGb);
    if (!offer) throw new ConvexError("That offer is no longer available. Refresh the list.");
    if (!offer.compatible)
      throw new ConvexError(offer.incompatibilityReason ?? "CUDA is incompatible");
    if (offer.hourlyUsd > cap) {
      throw new ConvexError(
        `This offer is $${offer.hourlyUsd.toFixed(3)}/hr; the server safety cap is $${cap.toFixed(2)}/hr.`,
      );
    }
    if (offer.hourlyUsd > args.displayedHourlyUsd * 1.1 + 0.01) {
      throw new ConvexError(
        `Price changed from $${args.displayedHourlyUsd.toFixed(3)} to $${offer.hourlyUsd.toFixed(3)}/hr. Refresh and confirm again.`,
      );
    }

    // Validate everything needed to build the paid instance before taking the
    // global launch lock. A missing secret is a configuration error, not an
    // uncertain Vast reservation that needs reconciliation.
    const publicUrl = validateLaunchEnvironment();
    const launchLabel = `artsnack-comfyui-${Date.now()}-${randomBytes(4).toString("hex")}`;
    const progressToken = randomBytes(32).toString("hex");
    const progressTokenHash = createHash("sha256").update(progressToken).digest("hex");
    const backendId = await ctx.runMutation(internal.vastBackendStore.reserve, {
      launchLabel,
      progressTokenHash,
      gpuName: offer.gpuName,
      numGpus: offer.numGpus,
      diskGb,
      diskBandwidthMbps: offer.diskBandwidthMbps,
      diskName: offer.diskName,
      location: offer.location,
      reliability: offer.reliability,
      hourlyUsd: offer.hourlyUsd,
      storageHourlyUsd: offer.storageHourlyUsd,
      publicUrl,
    });

    let instanceId: number | undefined;
    try {
      const response = await vastRequest(
        `/asks/${offer.id}/`,
        {
          method: "PUT",
          body: JSON.stringify(
            buildVastCreateRequest({
              image: vastImage(),
              diskGb,
              env: backendEnvironment(
                backendId,
                progressToken,
                encodeSkipModels(args.skipModels ?? []),
              ),
              startupScriptBase64: Buffer.from(buildVastStartupScript(), "utf8").toString("base64"),
              label: launchLabel,
            }),
          ),
        },
        { requireSuccess: true },
      );
      const rawId =
        response && typeof response === "object"
          ? (response as Record<string, unknown>).new_contract
          : undefined;
      instanceId = Number(rawId);
      if (!Number.isInteger(instanceId) || instanceId <= 0) {
        instanceId = undefined;
        throw new VastApiError(
          "Vast.ai may have reserved the offer but returned no instance id",
          undefined,
          true,
        );
      }
      await ctx.runMutation(internal.vastBackendStore.attachInstance, {
        id: backendId,
        instanceId,
      });
      return { instanceId };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (instanceId) {
        try {
          await vastRequest(
            `/instances/${instanceId}/`,
            { method: "DELETE" },
            { requireSuccess: true },
          );
          await ctx.runMutation(internal.vastBackendStore.setProviderState, {
            id: backendId,
            state: "destroyed",
            providerStatus: "compensated",
            message: "Launch did not finish; the paid instance was destroyed automatically.",
            error: message,
          });
        } catch (cleanupError) {
          await ctx.runMutation(internal.vastBackendStore.recordCleanupRequired, {
            id: backendId,
            instanceId,
            message: `Launch failed and cleanup is uncertain: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`,
          });
        }
      } else if (error instanceof VastApiError && !error.uncertain) {
        await ctx.runMutation(internal.vastBackendStore.failReservation, {
          id: backendId,
          message,
        });
      } else {
        await ctx.runMutation(internal.vastBackendStore.markLaunchUncertain, {
          id: backendId,
          message:
            "Vast.ai did not confirm whether the instance was created; reconciling by launch label…",
        });
      }
      throw error;
    }
  },
});

async function activeBackend(ctx: ActionCtx, id: Id<"vastBackends">) {
  const row = await ctx.runQuery(internal.vastBackendStore.activeById, { id });
  if (!row?.active || !row.instanceId) throw new ConvexError("No active Vast.ai instance found");
  return row;
}

async function stableBackendIsReady(
  publicUrl: string,
  backendId: Id<"vastBackends">,
): Promise<boolean> {
  const headers = comfyAuthHeadersForUrl(process.env, publicUrl);
  if (!(await probeComfyuiSystemStats(publicUrl, headers))) return false;
  const podSecret = process.env.POD_URL_SECRET;
  if (!podSecret) return false;
  try {
    const response = await noCacheFetch(`${publicUrl}/artsnack/status`, {
      headers: { ...headers, "x-artsnack-secret": podSecret },
      signal: AbortSignal.timeout(8_000),
    });
    if (!response.ok || !response.headers.get("content-type")?.includes("application/json")) {
      return false;
    }
    const body = (await response.json()) as { backendId?: unknown };
    return body.backendId === String(backendId);
  } catch {
    return false;
  }
}

function instanceCandidates(body: unknown): unknown[] | null {
  if (Array.isArray(body)) return body;
  if (
    body &&
    typeof body === "object" &&
    Array.isArray((body as Record<string, unknown>).instances)
  ) {
    return (body as Record<string, unknown>).instances as unknown[];
  }
  return null;
}

function instanceWithLabel(body: unknown, label: string): Record<string, unknown> | undefined {
  return instanceCandidates(body)?.find(
    (candidate) =>
      candidate &&
      typeof candidate === "object" &&
      (candidate as Record<string, unknown>).label === label,
  ) as Record<string, unknown> | undefined;
}

async function instancesWithLabel(label: string): Promise<unknown> {
  const params = new URLSearchParams({
    limit: "25",
    select_filters: JSON.stringify({ label: { eq: label } }),
    order_by: JSON.stringify([{ col: "id", dir: "asc" }]),
  });
  return vastRequest(`/api/v1/instances/?${params}`);
}

export const reconcileLaunch = internalAction({
  args: { id: v.id("vastBackends"), attempt: v.number() },
  handler: async (ctx, args): Promise<void> => {
    const row = await ctx.runQuery(internal.vastBackendStore.activeById, { id: args.id });
    if (!row || row.instanceId) return;
    try {
      const body = await instancesWithLabel(row.launchLabel);
      const found = instanceWithLabel(body, row.launchLabel);
      const instanceId = Number(found?.id);
      if (Number.isInteger(instanceId) && instanceId > 0) {
        await ctx.runMutation(internal.vastBackendStore.attachInstance, {
          id: args.id,
          instanceId,
        });
        return;
      }
      if (args.attempt >= 8) {
        await ctx.runMutation(internal.vastBackendStore.markLaunchUncertain, {
          id: args.id,
          message:
            "No matching instance is visible yet. The launch remains locked until Vast.ai confirms its outcome.",
        });
      }
    } catch (error) {
      if (args.attempt >= 8) {
        await ctx.runMutation(internal.vastBackendStore.markLaunchUncertain, {
          id: args.id,
          message: `Could not reconcile the launch automatically. Check Vast.ai before renting again: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
    }
    await ctx.runMutation(internal.vastBackendStore.scheduleLaunchReconcile, {
      id: args.id,
      attempt: args.attempt,
    });
  },
});

export const refresh = action({
  args: { id: v.id("vastBackends") },
  handler: async (ctx, args): Promise<void> => {
    await requireAllowedUser(ctx);
    const row = await ctx.runQuery(internal.vastBackendStore.activeById, { id: args.id });
    if (!row?.active) throw new ConvexError("No active Vast.ai backend found");
    if (!row.instanceId) return;
    let body: unknown;
    try {
      body = await vastRequest(`/instances/${row.instanceId}/?owner=me`);
    } catch (error) {
      if (error instanceof VastApiError && error.status === 404) {
        await ctx.runMutation(internal.vastBackendStore.setProviderState, {
          id: args.id,
          state: "destroyed",
          providerStatus: "not_found",
          message: "The Vast.ai instance no longer exists.",
        });
        return;
      }
      throw error;
    }
    const lookup = parseVastInstanceLookup(body);
    if (lookup.kind === "not_found") {
      await ctx.runMutation(internal.vastBackendStore.setProviderState, {
        id: args.id,
        state: "destroyed",
        providerStatus: "not_found",
        message: "The Vast.ai instance no longer exists.",
      });
      return;
    }
    if (lookup.kind === "invalid") {
      throw new ConvexError(
        "Vast.ai returned an invalid instance status; keeping the current state",
      );
    }
    const instance = lookup.instance;
    const providerState = mapVastInstanceState(instance);
    const providerStatus = String(
      instance?.actual_status ?? instance?.intended_status ?? "unknown",
    );

    if (providerState === "destroyed") {
      await ctx.runMutation(internal.vastBackendStore.setProviderState, {
        id: args.id,
        state: "destroyed",
        providerStatus,
        message: "The Vast.ai instance no longer exists.",
      });
    } else if (providerState === "stopped") {
      await ctx.runMutation(internal.vastBackendStore.setProviderState, {
        id: args.id,
        state: "stopped",
        providerStatus,
        message: "GPU stopped. Local disk is preserved and still billed.",
      });
    } else if (providerState === "offline" || providerState === "error") {
      await ctx.runMutation(internal.vastBackendStore.setProviderState, {
        id: args.id,
        state: providerState,
        providerStatus,
        message: `Vast.ai reports ${providerStatus}.`,
      });
    } else if (
      providerState === "running" &&
      (await stableBackendIsReady(row.publicUrl, row._id))
    ) {
      await ctx.runMutation(internal.vastBackendStore.setReadyIfRevision, {
        id: args.id,
        expectedRevision: row.lifecycleRevision,
        message: "Backend is online and ready for generations.",
      });
    } else if (row.state === "reserving" || row.state === "loading") {
      await ctx.runMutation(internal.vastBackendStore.setProviderState, {
        id: args.id,
        state: "loading",
        providerStatus,
      });
    }
  },
});

export const clearUncertainLaunch = action({
  args: { id: v.id("vastBackends") },
  handler: async (ctx, args): Promise<{ foundInstance: boolean }> => {
    await requireAllowedUser(ctx);
    const row = await ctx.runQuery(internal.vastBackendStore.activeById, { id: args.id });
    if (!row?.active) return { foundInstance: false };
    if (row.instanceId) throw new ConvexError("The launch already has an instance id");
    const body = await instancesWithLabel(row.launchLabel);
    if (instanceCandidates(body) === null) {
      throw new ConvexError("Vast.ai returned an invalid instance list; the launch lock was kept");
    }
    const found = instanceWithLabel(body, row.launchLabel);
    const instanceId = Number(found?.id);
    if (Number.isInteger(instanceId) && instanceId > 0) {
      await ctx.runMutation(internal.vastBackendStore.attachInstance, { id: args.id, instanceId });
      return { foundInstance: true };
    }
    await ctx.runMutation(internal.vastBackendStore.failReservation, {
      id: args.id,
      message: "Vast.ai confirmed that no matching instance exists; the launch lock was released.",
    });
    return { foundInstance: false };
  },
});

async function setInstanceState(
  ctx: ActionCtx,
  id: Id<"vastBackends">,
  desired: "running" | "stopped",
) {
  const row = await activeBackend(ctx, id);
  if (row.state === "destroying") {
    throw new ConvexError("Automatic cleanup is already destroying this instance");
  }
  await vastRequest(
    `/instances/${row.instanceId}/`,
    {
      method: "PUT",
      body: JSON.stringify({ state: desired }),
    },
    { requireSuccess: true },
  );
  if (desired === "running") {
    await ctx.runMutation(internal.vastBackendStore.beginStart, { id });
  } else {
    await ctx.runMutation(internal.vastBackendStore.setProviderState, {
      id,
      state: "stopped",
      providerStatus: desired,
      message: "GPU stopped. Local disk remains allocated and billed until destroy.",
    });
  }
}

export const start = action({
  args: { id: v.id("vastBackends") },
  handler: async (ctx, args): Promise<void> => {
    await requireAllowedUser(ctx);
    await setInstanceState(ctx, args.id, "running");
  },
});

export const stop = action({
  args: { id: v.id("vastBackends") },
  handler: async (ctx, args): Promise<void> => {
    await requireAllowedUser(ctx);
    await setInstanceState(ctx, args.id, "stopped");
  },
});

export const destroy = action({
  args: { id: v.id("vastBackends") },
  handler: async (ctx, args): Promise<void> => {
    await requireAllowedUser(ctx);
    const row = await activeBackend(ctx, args.id);
    try {
      await vastRequest(
        `/instances/${row.instanceId}/`,
        { method: "DELETE" },
        { requireSuccess: true },
      );
    } catch (error) {
      if (!(error instanceof VastApiError && error.status === 404)) throw error;
    }
    await ctx.runMutation(internal.vastBackendStore.setProviderState, {
      id: args.id,
      state: "destroyed",
      providerStatus: "destroyed",
      message: "Instance destroyed. Its local disk was permanently deleted and billing stopped.",
    });
  },
});

/**
 * A failed or stalled cold boot must not burn GPU credit unattended. Every
 * non-ready progress update schedules a watchdog for that exact lifecycle
 * revision. Cleanup atomically claims that revision before calling Vast, so a
 * concurrent readiness probe cannot race a DELETE and revive the row.
 */
export const cleanupProvisioning = internalAction({
  args: {
    id: v.id("vastBackends"),
    expectedRevision: v.number(),
    attempt: v.number(),
  },
  handler: async (ctx, args): Promise<void> => {
    const row = await ctx.runQuery(internal.vastBackendStore.activeById, { id: args.id });
    if (!row) return;
    const now = Date.now();
    const retryingClaim =
      args.attempt > 0 &&
      row.state === "destroying" &&
      row.lifecycleRevision === args.expectedRevision;
    if (
      !retryingClaim &&
      !shouldCleanupVastBackend(row, {
        lifecycleRevision: args.expectedRevision,
        now,
      })
    ) {
      return;
    }
    if (!row.instanceId) return;
    if (row.stage === "tunnel" && (await stableBackendIsReady(row.publicUrl, row._id))) {
      await ctx.runMutation(internal.vastBackendStore.setReadyIfRevision, {
        id: args.id,
        expectedRevision: args.expectedRevision,
        message: row.message.includes("warnings")
          ? row.message
          : "Backend is online and ready for generations.",
      });
      return;
    }
    const claim = await ctx.runMutation(internal.vastBackendStore.claimCleanup, {
      id: args.id,
      expectedRevision: args.expectedRevision,
      now,
    });
    if (!claim) return;
    const failed = row.state === "error" || row.stage === "error" || Boolean(row.error);
    try {
      try {
        await vastRequest(
          `/instances/${claim.instanceId}/`,
          { method: "DELETE" },
          { requireSuccess: true },
        );
      } catch (error) {
        if (!(error instanceof VastApiError && error.status === 404)) throw error;
      }
      await ctx.runMutation(internal.vastBackendStore.finishCleanup, {
        id: args.id,
        expectedRevision: claim.lifecycleRevision,
        message: failed
          ? "Provisioning failed, so the instance was automatically destroyed to stop billing."
          : `Provisioning stopped making progress at ${row.stage}, so the instance was automatically destroyed to stop billing.`,
      });
    } catch (error) {
      await ctx.runMutation(internal.vastBackendStore.scheduleCleanupRetry, {
        id: args.id,
        expectedRevision: claim.lifecycleRevision,
        attempt: args.attempt,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  },
});

export const verifyTunnel = internalAction({
  args: {
    id: v.id("vastBackends"),
    expectedRevision: v.number(),
    attempt: v.number(),
  },
  handler: async (ctx, args): Promise<void> => {
    const row = await ctx.runQuery(internal.vastBackendStore.activeById, { id: args.id });
    if (
      !row ||
      row.lifecycleRevision !== args.expectedRevision ||
      row.stage !== "tunnel" ||
      ["ready", "stopped", "destroyed"].includes(row.state)
    ) {
      return;
    }
    if (await stableBackendIsReady(row.publicUrl, row._id)) {
      await ctx.runMutation(internal.vastBackendStore.setReadyIfRevision, {
        id: args.id,
        expectedRevision: args.expectedRevision,
        message: row.message.includes("warnings")
          ? row.message
          : "Backend is online and ready for generations.",
      });
      return;
    }
    await ctx.runMutation(internal.vastBackendStore.scheduleTunnelRetry, {
      id: args.id,
      expectedRevision: args.expectedRevision,
      attempt: args.attempt,
    });
  },
});
