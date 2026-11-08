"use client";

import { useEffect, useState, type RefObject } from "react";

/**
 * Tailwind's `lg`. Crossing it is what turns the composer columns'
 * `lg:overflow-y-auto` on and off, so it is also what changes which element a
 * tile scrolls inside.
 */
export const SPLIT_LAYOUT_QUERY = "(min-width: 64rem)";

/**
 * The element `node` actually scrolls inside, or null for the viewport.
 *
 * An IntersectionObserver rooted at the viewport still sees an element inside an
 * `overflow-y-auto` column — but clipped by that column, which throws its
 * `rootMargin` away: nothing below the column's visible edge counts as near,
 * however close. Observing with this as the root puts the margin back.
 *
 * Stops before `body`, so a page whose document scrolls keeps the viewport.
 * `scrollHeight > clientHeight` is deliberately not part of the test: a column
 * holding one short page is not overflowing yet, but it is still the element
 * that will scroll once more arrives.
 */
export function findScrollParent(node: HTMLElement): HTMLElement | null {
  for (let element = node.parentElement; element && element !== document.body;) {
    const { overflowY } = getComputedStyle(element);
    if (overflowY === "auto" || overflowY === "scroll") return element;
    element = element.parentElement;
  }
  return null;
}

let splitLayout: MediaQueryList | null = null;

/** One MediaQueryList for every caller, created on first use (never on the server). */
export function splitLayoutQuery(): MediaQueryList {
  splitLayout ??= window.matchMedia(SPLIT_LAYOUT_QUERY);
  return splitLayout;
}

/**
 * Whether `ref`'s element is within `rootMargin` of the visible part of whatever
 * it scrolls inside.
 *
 * Every composer keeps its results in an `lg:overflow-y-auto` column, so tiles
 * that watched the viewport only ever started loading once they were already on
 * screen there — while below `lg`, where the window scrolls, the same margin
 * worked. Browser zoom is what moves a window across `lg`, which made "does the
 * next row preload" depend on the zoom level.
 *
 * The breakpoint is listened to, not rendered from: crossing it re-roots the
 * observer without re-rendering every tile. `enabled: false` disconnects both,
 * for a tile that has latched what it needed.
 */
export function useNearScrollRoot(
  ref: RefObject<HTMLElement | null>,
  rootMargin: string,
  enabled = true,
): boolean {
  const [near, setNear] = useState(false);

  useEffect(() => {
    const element = ref.current;
    if (!element || !enabled) return;
    let observer: IntersectionObserver | null = null;
    const observe = () => {
      observer?.disconnect();
      observer = new IntersectionObserver(([entry]) => setNear(entry.isIntersecting), {
        root: findScrollParent(element),
        rootMargin,
      });
      observer.observe(element);
    };
    observe();
    const query = splitLayoutQuery();
    query.addEventListener("change", observe);
    return () => {
      query.removeEventListener("change", observe);
      observer?.disconnect();
    };
  }, [ref, rootMargin, enabled]);

  return near;
}
