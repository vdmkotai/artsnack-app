"use node";

import { ConvexError, v } from "convex/values";
import type { Id } from "./_generated/dataModel";
import { action, type ActionCtx } from "./_generated/server";
import { requireAllowedUser } from "./authz";
import { resolveComfyuiTarget, resolveVideoTarget } from "./comfyuiTarget";
import { noCacheFetch } from "../../shared/no-cdn-cache";
import { type PodProfile, type PodDownloadsStatus } from "../../shared/pod-model-downloads";

/**
 * What a pod is downloading, read from the artsnack-downloader custom node
 * running inside ComfyUI on the pod (installed by infra/provision.sh). The pod
 * endpoint is public through the RunPod proxy, so every request carries
 * POD_URL_SECRET and the pod checks it.
 */

function podSecret(): string {
  const secret = process.env.POD_URL_SECRET;
  if (!secret) throw new ConvexError("POD_URL_SECRET is not configured on this deployment");
  return secret;
}

/** noCacheFetch because the RunPod proxy's CDN caches plain GETs for minutes —
 *  a cached /artsnack/status would freeze the panel's progress at a stale
 *  snapshot, the exact bug shared/no-cdn-cache.ts exists to prevent. */
async function podRequest(
  ctx: ActionCtx,
  path: string,
  init: RequestInit,
  profile: PodProfile,
  /** Video only: which pod, when several run; absent = the oldest ready one. */
  backendId?: Id<"runpodBackends">,
): Promise<unknown> {
  let target;
  try {
    target =
      profile === "video"
        ? await resolveVideoTarget(ctx, backendId)
        : await resolveComfyuiTarget(ctx);
  } catch (error) {
    // Target resolution throws a plain Error, which prod Convex redacts to "Server
    // Error" — rewrap so the panel can show the actual reason.
    throw new ConvexError(error instanceof Error ? error.message : "No pod configured");
  }
  let response: Response;
  try {
    response = await noCacheFetch(`${target.url}${path}`, {
      ...init,
      headers: {
        ...target.headers,
        ...init.headers,
        "x-artsnack-secret": podSecret(),
      },
      signal: AbortSignal.timeout(25_000),
    });
  } catch (error) {
    throw new ConvexError(
      `Pod unreachable at ${target.url} (${error instanceof Error ? error.message : String(error)})`,
    );
  }
  if (response.status === 404) {
    // With no ready pod, the image target falls back to the env's pod URL —
    // usually a pod long gone, which RunPod's proxy answers 404 for.
    if (target.provider === "legacy") {
      throw new ConvexError("No image pod is running — rent one, then try again");
    }
    // The route registers when ComfyUI imports the custom node, so a 404 is a
    // pod provisioned before the downloader existed — not a transient failure.
    throw new ConvexError("This pod has no downloader — it predates the current provision.sh");
  }
  if (response.status === 503) {
    // The node answers 503 only when its own env has no secret — ComfyUI was
    // started from an SSH shell, which does not inherit the container env.
    throw new ConvexError(
      "The pod's ComfyUI is running without POD_URL_SECRET (it was likely restarted from an SSH shell). Restart the pod, or run `bash /provision.sh` on it.",
    );
  }
  if (response.status === 401) {
    throw new ConvexError(
      "The pod rejected the secret — POD_URL_SECRET differs between this Convex deployment and the RunPod template",
    );
  }
  if (!response.ok) {
    // The node's 400/507 bodies are the actionable part ("not enough disk:
    // 3.2 GB free"); a bare status code would hide exactly what the user needs.
    let detail = "";
    try {
      detail = String(((await response.json()) as { error?: unknown }).error ?? "");
    } catch {
      // Not JSON — fall through to the status code.
    }
    throw new ConvexError(detail || `Pod answered ${response.status}`);
  }
  return response.json();
}

/** Live download state straight from the pod, for the pod status panel's poll. */
export const status = action({
  args: {
    profile: v.optional(v.union(v.literal("image"), v.literal("video"))),
    /** Video: one pod's downloads, when several run. */
    backendId: v.optional(v.id("runpodBackends")),
  },
  handler: async (ctx, args): Promise<PodDownloadsStatus> => {
    await requireAllowedUser(ctx);
    return (await podRequest(
      ctx,
      "/artsnack/status",
      { method: "GET" },
      args.profile ?? "image",
      args.backendId,
    )) as PodDownloadsStatus;
  },
});
