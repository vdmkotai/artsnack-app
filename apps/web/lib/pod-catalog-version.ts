/**
 * A version stamp for the pod's model catalogue, bumped when a download lands.
 *
 * `/api/models` and `/api/loras` are cached twice for 60s — in the route's own
 * memory and, via `Cache-Control: max-age`, in the browser — which is right for
 * a list that only changes when a file arrives on the pod, and wrong for the one
 * moment it does: a LoRA that had just landed on the pod stayed missing from the
 * dropdown for up to two minutes, and reloading the page did not help, because a
 * reload revalidates the document and replays the page's own `fetch()`es from
 * the browser cache.
 *
 * So the change is announced instead of waited out. Whatever lands a model on
 * the pod stamps a version here (`markPodCatalogChanged`); catalogue fetches
 * carry it as `?v=`, which is a different URL
 * to the browser cache and a "your memo is stale" to the route (see
 * `catalogVersion` in catalog-cache.ts). It lives in localStorage so it reaches
 * a page opened later and other tabs — the generator is usually not the tab the
 * download was started from.
 */

const STORAGE_KEY = "artsnack:pod-catalog-version";
const EVENT = "artsnack:pod-catalog-changed";

function read(): string | null {
  try {
    return window.localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

/** Call when a model file has landed on the pod. */
export function markPodCatalogChanged(): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, String(Date.now()));
  } catch {
    // Storage unavailable (private mode quota): this tab still hears the event.
  }
  window.dispatchEvent(new Event(EVENT));
}

/** A catalogue route, stamped with the current version when there is one. */
export function podCatalogUrl(path: string): string {
  const version = typeof window === "undefined" ? null : read();
  return version ? `${path}?v=${encodeURIComponent(version)}` : path;
}

/**
 * Runs `onChange` when the catalogue changes — in this tab (the event) or in
 * another one (`storage` fires only in the tabs that did not write).
 * Returns the unsubscribe.
 */
export function onPodCatalogChange(onChange: () => void): () => void {
  const onStorage = (event: StorageEvent) => {
    if (event.key === STORAGE_KEY) onChange();
  };
  window.addEventListener(EVENT, onChange);
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener(EVENT, onChange);
    window.removeEventListener("storage", onStorage);
  };
}
