/**
 * RunPod's *.proxy.runpod.net Cloudflare CDN caches all GET responses
 * (including /history, /system_stats, /queue, /view). That breaks ComfyUI
 * polling because /history/{promptId} returns a stale snapshot for ~minutes
 * after the actual completion, causing Convex actions to hit the 5-minute
 * timeout even though the pod has long finished generating.
 *
 * Always use `noCacheFetch` (or compose `addCacheBust` + `withNoCacheHeaders`)
 * for GET requests against any backend URL that may sit behind that proxy.
 */

const NO_CDN_CACHE_HEADERS: Record<string, string> = {
  "Cache-Control": "no-cache, no-store, max-age=0",
  Pragma: "no-cache",
};

export function addCacheBust(url: string): string {
  const separator = url.includes("?") ? "&" : "?";
  const nonce = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  return `${url}${separator}_cb=${nonce}`;
}

export function withNoCacheHeaders(headers?: HeadersInit): HeadersInit {
  if (!headers) {
    return { ...NO_CDN_CACHE_HEADERS };
  }
  if (headers instanceof Headers) {
    const merged = new Headers(headers);
    for (const [key, value] of Object.entries(NO_CDN_CACHE_HEADERS)) {
      merged.set(key, value);
    }
    return merged;
  }
  if (Array.isArray(headers)) {
    return [...headers, ...Object.entries(NO_CDN_CACHE_HEADERS)];
  }
  return { ...headers, ...NO_CDN_CACHE_HEADERS };
}

/**
 * Default deadline for the small JSON GETs this wrapper was written for
 * (`/object_info` and friends). A pod that accepts the connection and never
 * answers — mid-reboot, models still downloading — otherwise pins the function
 * for its whole billed maxDuration.
 *
 * Two kinds of caller must pass their own signal instead: ones that pull real
 * payloads (ComfyUI `/view` returns whole MP4s), and ones that poll `/history`,
 * because ComfyUI blocks its asyncio loop while it loads a multi-GB checkpoint
 * and a request that outlives that block is normal on the first job after a cold
 * pod start (see lib/backends/comfyui.ts).
 */
const DEFAULT_TIMEOUT_MS = 15_000;

export async function noCacheFetch(url: string, init: RequestInit = {}): Promise<Response> {
  return fetch(addCacheBust(url), {
    ...init,
    cache: "no-store",
    headers: withNoCacheHeaders(init.headers),
    signal: init.signal ?? AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
  });
}
