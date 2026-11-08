import { useCallback, useSyncExternalStore } from "react";

/**
 * SSR-safe media query hook
 * Returns undefined during SSR and initial hydration to prevent mismatch
 * After hydration, returns the actual media query result
 *
 * Only reach for this when the breakpoint decides *which component tree* to
 * render (a popover vs. a drawer). Anything that only changes sizing belongs in
 * the stylesheet — a `md:` variant is right at first paint, this is not.
 */
export function useMediaQuery(query: string): boolean | undefined {
  const subscribe = useCallback(
    (onStoreChange: () => void) => {
      const media = window.matchMedia(query);
      media.addEventListener("change", onStoreChange);
      return () => media.removeEventListener("change", onStoreChange);
    },
    [query],
  );

  return useSyncExternalStore(
    subscribe,
    () => window.matchMedia(query).matches,
    () => undefined,
  );
}
