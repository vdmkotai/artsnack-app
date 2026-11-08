import type { ActionCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { noCacheFetch } from "../../shared/no-cdn-cache";
import { comfyAuthHeadersForUrl } from "../../shared/comfyui-auth";

export type ComfyuiTarget = {
  url: string;
  headers: Record<string, string>;
  provider: "vast" | "managed-runpod" | "legacy" | "runpod";
};

export async function resolveComfyuiTarget(
  ctx: ActionCtx,
  backendType = "comfyui",
): Promise<ComfyuiTarget> {
  if (backendType === "vast") {
    const row = await ctx.runQuery(internal.vastBackendStore.activeReady, {});
    if (!row) throw new Error("The selected Vast.ai backend is not ready");
    return {
      url: row.publicUrl,
      headers: comfyAuthHeadersForUrl(process.env, row.publicUrl),
      provider: "vast",
    };
  }

  if (backendType === "managed-runpod") {
    const row = await ctx.runQuery(internal.runpodBackendStore.activeReady, {});
    if (!row) throw new Error("The selected managed RunPod backend is not ready");
    return {
      url: row.publicUrl,
      headers: comfyAuthHeadersForUrl(process.env, row.publicUrl, false),
      provider: "managed-runpod",
    };
  }

  if (backendType === "runpod") {
    const url = process.env.RUNPOD_URL?.trim().replace(/\/+$/, "");
    if (!url) throw new Error("RUNPOD_URL not configured in Convex env");
    return {
      url,
      headers: comfyAuthHeadersForUrl(process.env, url, false),
      provider: "runpod",
    };
  }

  if (backendType === "legacy") {
    const url = (process.env.COMFYUI_API_URL ?? process.env.NEXT_PUBLIC_COMFYUI_URL)
      ?.trim()
      .replace(/\/+$/, "");
    if (!url) throw new Error("No legacy self-hosted backend is configured");
    return {
      url,
      headers: comfyAuthHeadersForUrl(process.env, url),
      provider: "legacy",
    };
  }

  const [selection, activeVast, activeRunpod] = await Promise.all([
    ctx.runQuery(internal.selfHostedSelection.internalCurrent, {}),
    ctx.runQuery(internal.vastBackendStore.activeReady, {}),
    ctx.runQuery(internal.runpodBackendStore.activeReady, {}),
  ]);
  if (selection?.provider === "vast" && activeVast) {
    return {
      url: activeVast.publicUrl,
      headers: comfyAuthHeadersForUrl(process.env, activeVast.publicUrl),
      provider: "vast",
    };
  }
  if (selection?.provider === "runpod" && activeRunpod) {
    return {
      url: activeRunpod.publicUrl,
      headers: comfyAuthHeadersForUrl(process.env, activeRunpod.publicUrl, false),
      provider: "managed-runpod",
    };
  }

  // A selected provider can disappear independently. Fall back to another
  // ready backend so destroying one does not strand the other.
  if (activeVast) {
    return {
      url: activeVast.publicUrl,
      headers: comfyAuthHeadersForUrl(process.env, activeVast.publicUrl),
      provider: "vast",
    };
  }
  if (activeRunpod) {
    return {
      url: activeRunpod.publicUrl,
      headers: comfyAuthHeadersForUrl(process.env, activeRunpod.publicUrl, false),
      provider: "managed-runpod",
    };
  }

  const url = (process.env.COMFYUI_API_URL ?? process.env.NEXT_PUBLIC_COMFYUI_URL)
    ?.trim()
    .replace(/\/+$/, "");
  if (!url) throw new Error("No ready self-hosted backend is configured");
  return {
    url,
    headers: comfyAuthHeadersForUrl(process.env, url),
    provider: "legacy",
  };
}

export type VideoPodTarget = ComfyuiTarget & {
  backendId: Id<"runpodBackends">;
  /** One ComfyUI per GPU on a multi-GPU video pod, GPU 0 first. */
  instanceUrls: string[];
  gpuName: string;
};

function videoTargetOf(row: {
  _id: Id<"runpodBackends">;
  publicUrl: string;
  instanceUrls?: string[];
  gpuName: string;
}): VideoPodTarget {
  const base = row.publicUrl.replace(/\/+$/, "");
  return {
    url: base,
    headers: comfyAuthHeadersForUrl(process.env, row.publicUrl, false),
    provider: "managed-runpod",
    backendId: row._id,
    instanceUrls: row.instanceUrls?.length
      ? row.instanceUrls.map((url) => url.replace(/\/+$/, ""))
      : [base],
    gpuName: row.gpuName,
  };
}

/**
 * Every ready video pod — never a fallback to the image pod, and never the
 * legacy env URL: an H3 or LTX graph sent to an SDXL pod fails on every loader,
 * and a video job is too expensive to discover that by trying.
 */
export async function resolveVideoPods(ctx: ActionCtx): Promise<VideoPodTarget[]> {
  const rows = await ctx.runQuery(internal.runpodBackendStore.readyVideoPods, {});
  return rows.map(videoTargetOf);
}

/** One video pod: the given one, or the oldest ready one. */
export async function resolveVideoTarget(
  ctx: ActionCtx,
  backendId?: Id<"runpodBackends">,
): Promise<VideoPodTarget> {
  const pods = await resolveVideoPods(ctx);
  const pod = backendId ? pods.find((candidate) => candidate.backendId === backendId) : pods[0];
  if (!pod) {
    throw new Error(
      backendId
        ? "That video pod is not running"
        : "The video pod is not running — start it in the Self-hosted video tab",
    );
  }
  return pod;
}

export async function probeComfyuiSystemStats(
  url: string,
  headers: Record<string, string>,
): Promise<boolean> {
  try {
    const response = await noCacheFetch(`${url.replace(/\/+$/, "")}/system_stats`, {
      headers,
      signal: AbortSignal.timeout(8_000),
    });
    if (!response.ok || !response.headers.get("content-type")?.includes("application/json")) {
      return false;
    }
    const body = (await response.json()) as unknown;
    if (!body || typeof body !== "object" || Array.isArray(body)) return false;
    const record = body as Record<string, unknown>;
    return (
      (record.system !== null && typeof record.system === "object") || Array.isArray(record.devices)
    );
  } catch {
    return false;
  }
}
