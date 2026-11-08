"use client";

import { useCallback, useEffect, useLayoutEffect, useRef } from "react";

import { findScrollParent, splitLayoutQuery } from "@/hooks/use-scroll-root";

/**
 * A sentinel that pages when it scrolls into view, and keeps paging.
 *
 * It replaces the same eight lines written twice, both of which were wrong in a
 * way that reads as "infinite scroll is flaky" rather than as a bug:
 *
 * 1. **The observer was never attached on a cold load.** The old effect ran
 *    `if (!sentinel.current) return` with `[loadMore]` as its dependency, and
 *    `loadMore` is deliberately identity-stable. But the sentinel only renders in
 *    the results branch, so on a first visit the effect ran once against a null
 *    ref and never again — the grid loaded, the sentinel appeared, and nothing
 *    observed it. Paging worked only when a restored snapshot put tiles on screen
 *    before the first effect, i.e. on the second visit to a tab. A callback ref
 *    fixes this by construction: attachment is driven by the node existing, not by
 *    a dependency array guessing when it will.
 *
 * 2. **One intersection was one page.** IntersectionObserver reports *changes*, so
 *    a sentinel that is still on screen after a page lands never fires again — on
 *    a tall window the first page rarely fills the viewport, and the user has to
 *    scroll away and back. Re-observing after each load re-delivers the current
 *    state, which is the documented way to ask "are you still visible?".
 *
 * The re-observe is what makes the stall guard necessary. If a page comes back
 * with nothing the caller can show — the search path drops documents with no media
 * url, a "Videos" filter over a history of stills — the list does not grow, the
 * sentinel is still near, and re-observing asks for another page immediately.
 * `revision` is how the caller says "the list changed"; when it does not change
 * across `MAX_IDLE_PAGES` consecutive automatic pages, *prefetching* pauses.
 *
 * Only prefetching. The guard used to stop everything once the content could
 * scroll at all, and "could scroll" was a matter of tile size — of zoom. A
 * filtered grid a little taller than its column paused with the sentinel in plain
 * view, and nothing could restart it: the scroll that was supposed to clear the
 * guard did clear it, but a sentinel already inside the margin produces no new
 * intersection, so no page was ever asked for. At a smaller zoom the same grid was
 * underfilled and paged on. A second observer with no margin now tracks whether
 * the sentinel is really on screen, and while it is, the three-page guard does
 * not apply: the reader is looking at the end of the list, which is exactly when
 * more of it is wanted. A feed that ends pages on until it does
 * (`maxIdlePagesOnScreen: Infinity`); an external one gets a longer leash rather
 * than none, since it may never end. Either pause is lifted by a scroll.
 *
 * 3. **The root was always the viewport.** True on pages where the window
 *    scrolls, and false in both composers, where the results live in an
 *    `lg:overflow-y-auto` column. An observer watching the viewport still fires
 *    for an element clipped by an ancestor — but only once that element is really
 *    on screen, which discards `rootMargin` entirely: no prefetch, so the reader
 *    hits the bottom and waits for a request that only starts there. The scroll
 *    parent is found and used as the root instead, and pages that genuinely scroll
 *    the window resolve to `null` and behave exactly as before.
 */

const MAX_IDLE_PAGES = 3;
/**
 * Empty pages in a row while the end of the list is on screen. A feed that ends
 * — every Convex history — passes `Infinity`: the reader is looking at the end
 * and the walk is finite. One that might not end and might render nothing for a
 * long stretch (an external feed filtered client-side) keeps a cap, so a reader parked
 * at the bottom does not send requests until the API rate-limits them.
 */
const MAX_IDLE_PAGES_ON_SCREEN = 10;

type ScrollMetrics = Pick<HTMLElement, "clientHeight" | "scrollHeight">;

/**
 * The automatic paging guard is deliberately kept separate from the observer so
 * its stop condition can be regression-tested without a browser timing harness.
 *
 * Never while the column is underfilled: there is no scroll that could restart
 * it. Otherwise prefetching (sentinel near but off screen) pauses after
 * `MAX_IDLE_PAGES`, and paging with the end of the list in view only after
 * `onScreenLimit` — scrolling restarts either.
 */
export function shouldPauseAutomaticPaging(
  idlePages: number,
  scrollContainer: ScrollMetrics,
  sentinelOnScreen = false,
  onScreenLimit = MAX_IDLE_PAGES_ON_SCREEN,
): boolean {
  if (scrollContainer.scrollHeight <= scrollContainer.clientHeight) return false;
  return idlePages >= (sentinelOnScreen ? onScreenLimit : MAX_IDLE_PAGES);
}

interface Options {
  /** Called when the sentinel is visible and there is more to fetch. */
  onLoadMore: () => void;
  hasMore: boolean;
  /** True while any fetch is in flight; suppresses firing and arms the re-check. */
  busy: boolean;
  /**
   * Any number that changes when the visible list grows. Usually `items.length`.
   * Its only job is to distinguish a productive page from an empty one.
   */
  revision: number;
  /**
   * Optional identity for independent feeds that can reuse the same sentinel.
   * Changing it resets the idle guard and re-checks the current intersection.
   */
  resetKey?: string | number | boolean;
  /** How far below the fold to start fetching. */
  rootMargin?: string;
  /**
   * Empty pages in a row to keep fetching while the end of the list is on
   * screen. `Infinity` for a source that ends (Convex); see
   * `MAX_IDLE_PAGES_ON_SCREEN` for the default.
   */
  maxIdlePagesOnScreen?: number;
}

export function useInfiniteScroll({
  onLoadMore,
  hasMore,
  busy,
  revision,
  resetKey,
  rootMargin = "600px",
  maxIdlePagesOnScreen = MAX_IDLE_PAGES_ON_SCREEN,
}: Options): (node: HTMLElement | null) => void {
  const node = useRef<HTMLElement | null>(null);
  /** Within `rootMargin` of the fold: worth prefetching. */
  const nearObserver = useRef<IntersectionObserver | null>(null);
  /** Actually on screen: the reader is looking at the end of the list. */
  const screenObserver = useRef<IntersectionObserver | null>(null);
  const near = useRef(false);
  const onScreen = useRef(false);
  const scrollContainer = useRef<HTMLElement | null>(null);
  /** Both observers report in the same task; this folds them into one check. */
  const pendingCheck = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** A queued re-observe; see `recheck`. */
  const recheckFrame = useRef<number | null>(null);

  /**
   * The guards have to be current without being dependencies. An observer rebuilt
   * on every state change re-fires `observe()` on every render, which is the paging
   * loop the search hook's own comment describes — so everything mutable is read
   * through a ref and the observer is built exactly once per node.
   *
   * Written in a layout effect rather than during render: React Compiler refuses
   * to compile a hook that writes a ref while rendering. Nothing reads it before
   * the commit — `fire` only runs from a task of its own — so the observer still
   * never sees a stale guard.
   */
  const latest = useRef({ onLoadMore, hasMore, busy, revision, maxIdlePagesOnScreen });
  useLayoutEffect(() => {
    latest.current = { onLoadMore, hasMore, busy, revision, maxIdlePagesOnScreen };
  });

  const idlePages = useRef(0);
  const lastRevision = useRef(revision);
  const lastResetKey = useRef(resetKey);
  const wasBusy = useRef(busy);

  const fire = useCallback(() => {
    if (!near.current && !onScreen.current) return;
    const {
      onLoadMore: load,
      hasMore: more,
      busy: loading,
      maxIdlePagesOnScreen: limit,
    } = latest.current;
    if (!more || loading) return;
    const container = scrollContainer.current;
    if (!container) return;
    if (shouldPauseAutomaticPaging(idlePages.current, container, onScreen.current, limit)) return;
    idlePages.current += 1;
    load();
  }, []);

  /**
   * Deferred to its own task rather than run from each callback: re-observing
   * delivers an entry to both observers, and two direct calls would ask for two
   * pages — and count two idle pages — before React has rendered `busy`.
   */
  const scheduleCheck = useCallback(() => {
    if (pendingCheck.current !== null) return;
    pendingCheck.current = setTimeout(() => {
      pendingCheck.current = null;
      fire();
    }, 0);
  }, [fire]);

  const detach = useCallback(() => {
    nearObserver.current?.disconnect();
    screenObserver.current?.disconnect();
    nearObserver.current = null;
    screenObserver.current = null;
    near.current = false;
    onScreen.current = false;
    scrollContainer.current = null;
    if (pendingCheck.current !== null) clearTimeout(pendingCheck.current);
    pendingCheck.current = null;
    if (recheckFrame.current !== null) cancelAnimationFrame(recheckFrame.current);
    recheckFrame.current = null;
  }, []);

  /**
   * Re-delivers the current intersection state to both observers. Deferred a
   * frame because a page that just landed has not been laid out yet, so the
   * sentinel's position is still the old one.
   *
   * Held in a ref and cancelled only on detach. It used to be an effect's
   * cleanup, so anything that re-ran the effect before the frame — a generation
   * starting moves `revision` — dropped it, and the next run had no finished
   * load left to schedule another. A hidden tab runs no frames at all, so a page
   * landing there and a row changing before the user came back stopped paging
   * for good, with the sentinel on screen.
   */
  const recheck = useCallback(() => {
    if (recheckFrame.current !== null) return;
    recheckFrame.current = requestAnimationFrame(() => {
      recheckFrame.current = null;
      const element = node.current;
      if (!element) return;
      for (const observer of [nearObserver.current, screenObserver.current]) {
        if (!observer) continue;
        observer.unobserve(element);
        observer.observe(element);
      }
    });
  }, []);

  const attach = useCallback(
    (element: HTMLElement | null) => {
      detach();
      node.current = element;
      if (!element) return;

      const root = findScrollParent(element);
      scrollContainer.current = root ?? document.documentElement;
      const watch = (flag: { current: boolean }, margin: string) => {
        const created = new IntersectionObserver(
          (entries) => {
            flag.current = entries[entries.length - 1].isIntersecting;
            if (flag.current) scheduleCheck();
          },
          { root, rootMargin: margin, threshold: 0 },
        );
        created.observe(element);
        return created;
      };
      nearObserver.current = watch(near, rootMargin);
      screenObserver.current = watch(onScreen, "0px");
    },
    [detach, scheduleCheck, rootMargin],
  );

  useEffect(() => detach, [detach]);

  /**
   * Crossing `lg` is what turns the results column's `overflow-y` from `visible`
   * into `auto` and back, so the root chosen when the sentinel mounted is simply
   * the wrong element afterwards. Re-attaching recomputes it.
   */
  useEffect(() => {
    const query = splitLayoutQuery();
    const onChange = () => attach(node.current);
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, [attach]);

  /**
   * A real scroll is the user saying "keep going", so it clears the stall guard.
   * Without this a grid that once ran out of renderable rows would refuse to page
   * for the rest of the session. The scroll that lands the sentinel on screen
   * needs no help — the on-screen observer reports it — but one that ends inside
   * the margin does: nothing about the intersection changed, so the check is run
   * by hand.
   *
   * Capture phase on the window, because a scroll event on an inner container does
   * not bubble — a plain bubbling listener here only ever heard pages that scroll
   * the window, never a composer column.
   */
  useEffect(() => {
    const onScroll = () => {
      const paused = idlePages.current >= MAX_IDLE_PAGES;
      idlePages.current = 0;
      if (paused) scheduleCheck();
    };
    window.addEventListener("scroll", onScroll, { passive: true, capture: true });
    return () => window.removeEventListener("scroll", onScroll, { capture: true });
  }, [scheduleCheck]);

  /** Coming back to the tab: whatever landed while it was hidden gets looked at. */
  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState === "visible") recheck();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, [recheck]);

  useEffect(() => {
    const contextChanged = resetKey !== lastResetKey.current;
    if (contextChanged) {
      lastResetKey.current = resetKey;
      lastRevision.current = revision;
      idlePages.current = 0;
    } else if (revision !== lastRevision.current) {
      lastRevision.current = revision;
      idlePages.current = 0;
    }

    const finishedLoading = wasBusy.current && !busy;
    wasBusy.current = busy;
    if ((finishedLoading || contextChanged) && hasMore) recheck();
  }, [busy, hasMore, resetKey, revision, recheck]);

  return attach;
}
