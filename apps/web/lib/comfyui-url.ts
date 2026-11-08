import { ConvexHttpClient } from "convex/browser";
import { api } from "@/convex/_generated/api";

/**
 * Resolve the current ComfyUI base URL at request time.
 *
 * Source of truth is a Convex action backed by the Convex env var that the RunPod
 * pod sets when it boots — so deploying a new pod is picked up with NO Vercel
 * rebuild. Falls back to build-time env if Convex is unreachable, so this is never
 * worse than reading process.env directly. Always strips a trailing slash so
 * callers can safely build `${url}/object_info` etc.
 *
 * Result is cached for a short TTL so frequent callers (e.g. the backend-health
 * poll) don't hit Convex on every request. A new pod is still picked up within
 * the TTL — fine, since its models take ~2 min to download anyway. Only
 * successful Convex resolutions are cached; fallbacks are not, so a transient
 * Convex hiccup is retried on the next call.
 *
 * The lookup has its own deadline: callers put their timeouts on the pod request
 * that follows, so a Convex call that hangs would otherwise hang the route with
 * it (the health check's 5 s starts only after this returns). And concurrent
 * cold misses share one lookup instead of each sending their own.
 */
let cache: { url: string; at: number } | null = null;
let pending: Promise<string> | null = null;
const TTL_MS = 15_000;
const LOOKUP_TIMEOUT_MS = 3_000;

/** fetch with a deadline, for ConvexHttpClient — which takes no signal of its own. */
const fetchWithDeadline: typeof fetch = (input, init) => {
  const deadline = AbortSignal.timeout(LOOKUP_TIMEOUT_MS);
  const signal = init?.signal ? AbortSignal.any([init.signal, deadline]) : deadline;
  return fetch(input, { ...init, signal });
};

export function getComfyuiUrl(): Promise<string> {
  if (cache && Date.now() - cache.at < TTL_MS) return Promise.resolve(cache.url);
  pending ??= resolveComfyuiUrl().finally(() => {
    pending = null;
  });
  return pending;
}

async function resolveComfyuiUrl(): Promise<string> {
  const fallback =
    process.env.NEXT_PUBLIC_COMFYUI_URL || process.env.COMFYUI_API_URL || "http://127.0.0.1:8188";

  let resolved = "";
  const convexUrl = process.env.NEXT_PUBLIC_CONVEX_URL;
  if (convexUrl) {
    try {
      const client = new ConvexHttpClient(convexUrl, { fetch: fetchWithDeadline });
      // The action is gated on a shared secret, not on a Clerk identity: this
      // client never calls setAuth. A missing/wrong secret comes back as "" and
      // falls through to the build-time env below, same as an unreachable Convex.
      resolved =
        (await client.action(api.config.comfyuiUrl, {
          secret: process.env.POD_URL_SECRET ?? "",
        })) || "";
      if (!resolved) {
        // POD_URL_SECRET missing or mismatched between Vercel and Convex: the
        // action answers "" rather than throwing, so without this line the app
        // would serve the stale build-time pod URL forever, silently.
        console.warn("[ComfyUI URL] Convex returned no URL; using build-time fallback");
      }
    } catch (error) {
      // Any failure degrades to the fallback — including the argument-validation
      // error a prod Convex deployment that predates this arg would raise, since
      // pushing to main deploys the frontend only and `bunx convex deploy` is a
      // separate step — and a lookup that ran past LOOKUP_TIMEOUT_MS. Logged
      // because the fallback is otherwise indistinguishable from a healthy
      // resolution.
      console.warn("[ComfyUI URL] Convex lookup failed; using build-time fallback:", error);
      resolved = "";
    }
  }

  const url = (resolved || fallback).trim().replace(/\/+$/, "");
  if (resolved) cache = { url, at: Date.now() }; // cache only real Convex results
  return url;
}
