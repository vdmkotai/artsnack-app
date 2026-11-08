/**
 * The page side of the local media cache — the worker itself, and why it
 * exists, is public/media-cache-sw.js.
 *
 * The worker only handles URLs on the media CDN, so with no
 * NEXT_PUBLIC_MEDIA_URL there is nothing for it to do and it is not registered.
 */
const MEDIA_BASE = process.env.NEXT_PUBLIC_MEDIA_URL;
const WORKER_PATH = "/media-cache-sw.js";

/**
 * Opt-in: the cache runs only with `NEXT_PUBLIC_MEDIA_CACHE=on` (inlined at
 * build time — set it in Vercel and redeploy). Otherwise every page that loads
 * unregisters the worker, and the worker script itself retires any older
 * registration (public/media-cache-sw.js explains why it is off: its only way
 * to read media, Vercel's `/media` proxy, streams at ~70 KB/s). Do not turn it
 * on again before the worker can fetch the media CDN directly with CORS.
 */
export const mediaCacheEnabled = process.env.NEXT_PUBLIC_MEDIA_CACHE === "on";

export type MediaCacheStats = { bytes: number; count: number; limit: number };

const supported = () => typeof navigator !== "undefined" && "serviceWorker" in navigator;

const isMediaCacheWorker = (registration: ServiceWorkerRegistration) =>
  [registration.active, registration.waiting, registration.installing].some((worker) =>
    worker?.scriptURL.includes(WORKER_PATH),
  );

/**
 * Withdraws the worker and what it stored. The files go too: with no worker
 * left, Settings has no way to clear them, and they could be gigabytes.
 */
async function unregisterMediaCache(): Promise<void> {
  try {
    const registrations = await navigator.serviceWorker.getRegistrations();
    await Promise.all(
      registrations.filter(isMediaCacheWorker).map((registration) => registration.unregister()),
    );
    const names = await caches.keys();
    await Promise.all(
      names.filter((name) => name.startsWith("artsnack-media-")).map((name) => caches.delete(name)),
    );
    indexedDB.deleteDatabase("artsnack-media-cache");
  } catch (error) {
    console.warn("[media-cache] unregistration failed", error);
  }
}

export function registerMediaCache(): void {
  if (!supported()) return;
  if (!mediaCacheEnabled) {
    void unregisterMediaCache();
    return;
  }
  if (!MEDIA_BASE) return;
  const url = `${WORKER_PATH}?media=${encodeURIComponent(MEDIA_BASE)}&enabled=1`;
  navigator.serviceWorker.register(url, { scope: "/" }).catch((error: unknown) => {
    console.warn("[media-cache] registration failed", error);
  });
  // Without this the browser may clear the cache under storage pressure. Chrome
  // grants it silently to sites it considers engaged; a refusal changes nothing.
  void navigator.storage?.persist?.().catch(() => false);
}

/**
 * Asks the worker to download these media URLs in the background, two at a
 * time, newest request first, skipping anything already cached. A no-op until
 * the worker controls the page — the first visit after it installs.
 */
export function prefetchMedia(urls: readonly (string | null | undefined)[]): void {
  if (!mediaCacheEnabled || !supported()) return;
  const list = urls.filter((url): url is string => Boolean(url));
  if (list.length === 0) return;
  navigator.serviceWorker.controller?.postMessage({ type: "prefetch", urls: list });
}

/**
 * The URLs a newest-first list gained at its head, and nothing else: a run of
 * never-seen URLs at the front, followed by the previous list itself, in
 * order, for as far as the two overlap. That is what a generation finishing
 * looks like. A filter change, a search, or a different folder replaces the
 * list instead — its head is also new, but what follows it is not the old
 * list — and returns nothing, so switching views never downloads a page of
 * originals.
 */
export function freshAtHead(
  previous: readonly string[],
  next: readonly string[],
  seen: ReadonlySet<string>,
): string[] {
  if (previous.length === 0) return [];
  let count = 0;
  while (count < next.length && !seen.has(next[count])) count++;
  if (count === 0 || next[count] !== previous[0]) return [];
  const overlap = Math.min(previous.length, next.length - count);
  for (let index = 1; index < overlap; index++) {
    if (next[count + index] !== previous[index]) return [];
  }
  return next.slice(0, count);
}

function ask<T>(type: string): Promise<T | null> {
  const worker = supported() ? navigator.serviceWorker.controller : null;
  if (!worker) return Promise.resolve(null);
  return new Promise((resolve) => {
    const channel = new MessageChannel();
    const timer = setTimeout(() => resolve(null), 5_000);
    channel.port1.onmessage = (event: MessageEvent<T>) => {
      clearTimeout(timer);
      resolve(event.data);
    };
    worker.postMessage({ type }, [channel.port2]);
  });
}

/** Size of the cache, or null when the worker is not running this page. */
export const mediaCacheStats = () => ask<MediaCacheStats>("stats");

export const clearMediaCache = () => ask<{ ok: true }>("clear");
