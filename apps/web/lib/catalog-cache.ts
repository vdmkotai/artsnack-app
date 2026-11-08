/**
 * Cache headers for the pod catalogue routes (models, loras, unets, video-*).
 *
 * These routes all memoise the pod's answer for a short TTL, and all of them
 * deliberately refuse to memoise an *empty* list: a pod that is still booting
 * answers /object_info without the node's choices filled in, and pinning that
 * would leave the dropdowns empty for the whole TTL after the pod is ready.
 *
 * The HTTP header has to follow the same rule. Sending `max-age=60` on an empty
 * response defeats the in-memory guard sitting right next to it — the server
 * would happily re-ask the pod, but the browser would replay its own cached
 * empty list instead of ever making that request.
 */

const TTL_SECONDS = 60;

/** Response headers for a catalogue payload, cached only when it has content. */
export function catalogCacheHeaders(isComplete: boolean): Record<string, string> {
  return {
    "Cache-Control": isComplete ? `private, max-age=${TTL_SECONDS}` : "no-store",
  };
}

/**
 * The catalogue version a request was stamped with — `?v=`, set by the client
 * once a download lands on the pod (see pod-catalog-version.ts). Null when the
 * page has never seen a download.
 */
export function catalogVersion(request: Request): string | null {
  return new URL(request.url).searchParams.get("v");
}

/**
 * Whether a route's memo may answer this request: inside the TTL, and taken
 * under the version the request carries. A version the memo has not seen means
 * a file arrived since it was taken, so the pod is asked again. Compared for
 * equality rather than as timestamps — the stamp comes from the browser's clock,
 * and a skewed one must not be able to make a stale memo look newer.
 */
export function memoIsFresh(
  memo: { at: number; version: string | null } | null | undefined,
  version: string | null,
  ttlMs: number,
): boolean {
  if (!memo || Date.now() - memo.at >= ttlMs) return false;
  return version === null || memo.version === version;
}
