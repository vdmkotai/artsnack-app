/**
 * Hand-off of a generated image into the API tab as a reference.
 *
 * Used from the gallery, history and favourites pages, which navigate to
 * /generate and expect the picture to be waiting there. sessionStorage rather
 * than a query param because the payload is a URL and the tab may not mount
 * until after the navigation settles.
 */

export type HandoffMode = "image" | "video";

export interface QueuedReferences {
  urls: string[];
  mode?: HandoffMode;
}

export interface ReferenceBatchPlan<T> {
  next: T[];
  dropped: T[];
}

/**
 * Makes room for an intentional batch without reassigning surviving slots.
 * Existing references keep their order from the front; newest ones give way,
 * then incoming references are appended in the user's selection order.
 */
export function planReferenceBatch<T>(
  current: T[],
  incoming: T[],
  capacity: number,
): ReferenceBatchPlan<T> {
  const accepted = incoming.slice(0, Math.max(0, capacity));
  const keepCount = Math.max(0, capacity - accepted.length);
  const kept = current.slice(0, keepCount);
  return {
    next: [...kept, ...accepted],
    dropped: current.slice(keepCount),
  };
}

/** Kept at its original name so a hand-off queued before a deploy still lands. */
const PENDING_REFERENCE_KEY = "grok_pending_reference";

export function queueApiReference(url: string, mode?: HandoffMode) {
  sessionStorage.setItem(PENDING_REFERENCE_KEY, JSON.stringify({ url, mode }));
}

/** Queues an ordered batch selected in search for one trip to the composer. */
export function queueApiReferences(urls: string[], mode?: HandoffMode) {
  sessionStorage.setItem(PENDING_REFERENCE_KEY, JSON.stringify({ urls, mode }));
}

/** Accepts both the original single-reference payload and the new batch shape. */
export function parseQueuedReferences(raw: string | null): QueuedReferences | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as {
      url?: unknown;
      urls?: unknown;
      mode?: unknown;
    };
    const urls = Array.isArray(parsed.urls)
      ? parsed.urls.filter((url): url is string => typeof url === "string" && url.length > 0)
      : typeof parsed.url === "string" && parsed.url.length > 0
        ? [parsed.url]
        : [];
    if (urls.length === 0) return null;
    const mode = parsed.mode === "image" || parsed.mode === "video" ? parsed.mode : undefined;
    return { urls, mode };
  } catch {
    return null;
  }
}

/** Reads and clears every pending reference, preserving selection order. */
export function takeQueuedReferences(): QueuedReferences | null {
  const raw = sessionStorage.getItem(PENDING_REFERENCE_KEY);
  if (!raw) return null;
  sessionStorage.removeItem(PENDING_REFERENCE_KEY);
  return parseQueuedReferences(raw);
}

/** Reads and clears the pending hand-off, if any. */
export function takeQueuedReference(): { url: string; mode?: HandoffMode } | null {
  const queued = takeQueuedReferences();
  return queued ? { url: queued.urls[0], mode: queued.mode } : null;
}

/**
 * Reproducing an API generation's settings from another page.
 *
 * Only the id travels: the settings themselves live on the row, and passing an
 * id means the tab restores from current data rather than from whatever the
 * gallery happened to have loaded. A query param (not sessionStorage) so the
 * link survives a reload and a shared URL.
 */
const REPRODUCE_PARAM = "reproduceApi";

/**
 * Typed as a template literal rather than `string` so it satisfies `typedRoutes`
 * without importing `Route` from `next` — that type only exists once a build has
 * written `.next/types`, so importing it would make `bun run typecheck` fail on
 * a fresh clone. `/generate` is a static route and `?…` is a valid search
 * suffix, which is exactly the shape Next accepts.
 */
export function apiReproduceHref(generationId: string): `/generate?${string}` {
  return `/generate?tab=api&${REPRODUCE_PARAM}=${encodeURIComponent(generationId)}`;
}

export function readApiReproduceId(search: URLSearchParams): string | null {
  return search.get(REPRODUCE_PARAM);
}

export type GenerateTab = "models" | "video" | "api";

/** Where an image sent from the API tab lands in the Self-hosted video form. */
export type VideoHandoffRole = "first" | "last" | "reference";

const VIDEO_REPRODUCE_PARAM = "reproduceVideo";

/** Reproduce a self-hosted H3 clip: the Self-hosted video tab reads the row
 *  back by id, the same shape as `apiReproduceHref`. */
export function videoReproduceHref(generationId: string): `/generate?${string}` {
  return `/generate?tab=video&${VIDEO_REPRODUCE_PARAM}=${encodeURIComponent(generationId)}`;
}

export function readVideoReproduceId(search: Pick<URLSearchParams, "get">): string | null {
  return search.get(VIDEO_REPRODUCE_PARAM);
}

/**
 * Selects the composer named by a handoff before consulting remembered UI state.
 *
 * A self-hosted reproduce carries `reproduce=true`; a Hosted API reproduce
 * carries `reproduceApi`. Both are stronger evidence than `tab`, which may have
 * survived from an earlier visit through `history.replaceState`.
 */
export function resolveGenerateTab(search: Pick<URLSearchParams, "get">): GenerateTab {
  if (search.get(VIDEO_REPRODUCE_PARAM) !== null) return "video";
  if (search.get(REPRODUCE_PARAM) !== null) return "api";
  if (search.get("reproduce") === "true") return "models";

  const tab = search.get("tab");
  if (tab === "video") return "video";
  return tab === "api" || tab === "grok" ? "api" : "models";
}

const ENHANCE_REPRODUCE_PARAM = "reproduce";

/**
 * Reproduce an enhancement, from a page that is not the Enhance page.
 *
 * The Enhance page's own grid restores settings in place — it already holds the
 * row. This is for Favourites, which has only the favourite, so the id travels
 * in the URL and the destination reads the row back. Same shape and same reason
 * as `apiReproduceHref`.
 */
export function enhanceReproduceHref(enhancementId: string): `/enhance?${string}` {
  return `/enhance?${ENHANCE_REPRODUCE_PARAM}=${encodeURIComponent(enhancementId)}`;
}

export function readEnhanceReproduceId(search: URLSearchParams): string | null {
  return search.get(ENHANCE_REPRODUCE_PARAM);
}
