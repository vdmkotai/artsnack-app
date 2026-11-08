import { usePaginatedQuery, useQuery } from "convex/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { api } from "@/convex/_generated/api";

import { boundedByTail, mergeByTime, safeBoundary, tailTime } from "./merge";
import {
  fromEnhancementRow,
  fromFailureRecord,
  fromHostedRow,
  fromLocalRow,
  fromVideoRow,
} from "./rows";
import { readSnapshot, saveSnapshot } from "./snapshot";
import type { FeedItem } from "./types";

export type FeedFilter = "all" | "photos" | "videos" | "local" | "api" | "failed" | "enhanced";

/**
 * `enabled` exists for one caller: the viewer, which mounts this and the favourites
 * feed only as a fallback for a cold entry with no hand-off. Hooks cannot be
 * conditional, so both ran on every open — four fresh paginated subscriptions whose
 * results were then thrown away, on the one screen in the app that wants the device's
 * whole attention for a photograph.
 */

const PAGE = 30;

/**
 * How many all-dropped pages a view will walk before believing them.
 *
 * Only two filters can produce one: "enhanced", where a run that made no file is
 * dropped here, and "videos", where a page of hosted rows can be all images. The
 * others keep every row their sources return, so draining them would only spend
 * bandwidth to arrive at the same empty grid.
 */
const DRAIN_LIMIT = 12;

/**
 * One feed over four tables.
 *
 * Self-hosted images live in `generations`, everything from Grok, fal and
 * Higgsfield in `grokGenerations`, self-hosted clips in `videos`, and enhanced
 * pictures in `enhancements`. They have different shapes, different indexes and
 * — since Convex paginates over one index at a time — a cursor each. The merge,
 * and the tail rule that keeps it from reordering as pages arrive, is in
 * `feed/merge.ts`; Favourites spans its own tables the same way.
 *
 * The last two were missing, and each was missing differently. A self-hosted clip
 * was findable in search and nowhere else — the Library drew a "Videos" chip that
 * could only ever show *hosted* video, so the pod's own output was invisible on the
 * phone. An enhanced picture was worse: the long press ran it, an alert said it had
 * worked, and the result went somewhere the app never looked, so the only way to see
 * one was to already have favourited it — which needed seeing it first.
 *
 * Enhancements stay out of "All" on purpose. They are second passes over pictures
 * that are already in the feed, and interleaving each one beside its original turns
 * the Library into a gallery of near-duplicates — the same reason the web gives them
 * a page instead of a place in the gallery. They get a chip.
 */
export function useFeed(filter: FeedFilter = "all", enabled = true) {
  // Which tables this filter can possibly draw from. Enhancements are the one
  // source that is never merged with the others: its chip is its whole view.
  const wantsLocal = enabled && (filter === "all" || filter === "photos" || filter === "local");
  const wantsApi =
    enabled && (filter === "all" || filter === "photos" || filter === "videos" || filter === "api");
  const wantsClips = enabled && (filter === "all" || filter === "videos" || filter === "local");
  const wantsEnhanced = enabled && filter === "enhanced";
  /**
   * Failures come off the status indexes instead, whole and already merged —
   * see convex/failures.ts for why paging them by time could not work.
   */
  const failures = useQuery(api.failures.list, enabled && filter === "failed" ? {} : "skip");

  const local = usePaginatedQuery(api.generations.listPaginated, wantsLocal ? {} : "skip", {
    initialNumItems: PAGE,
  });
  const hosted = usePaginatedQuery(api.grokGenerations.list, wantsApi ? {} : "skip", {
    initialNumItems: PAGE,
  });
  const clips = usePaginatedQuery(api.videos.listPaginated, wantsClips ? {} : "skip", {
    initialNumItems: PAGE,
  });
  const enhanced = usePaginatedQuery(api.enhancements.listPaginated, wantsEnhanced ? {} : "skip", {
    initialNumItems: PAGE,
  });

  const localItems = useMemo(() => (local.results ?? []).flatMap(fromLocalRow), [local.results]);
  const hostedItems = useMemo(
    () => (hosted.results ?? []).flatMap(fromHostedRow),
    [hosted.results],
  );
  const clipItems = useMemo(() => (clips.results ?? []).flatMap(fromVideoRow), [clips.results]);
  const enhancedItems = useMemo(
    () => (enhanced.results ?? []).flatMap(fromEnhancementRow),
    [enhanced.results],
  );

  /**
   * The four cursors as one list, so the merge, the tail rule and "which one is
   * behind" are written once rather than once per pair. A side nobody asked for
   * is inert: no items, nothing to load, and no constraint on the boundary.
   */
  const sides = useMemo(
    () => [
      { wanted: wantsLocal, items: localItems, status: local.status, loadMore: local.loadMore },
      { wanted: wantsApi, items: hostedItems, status: hosted.status, loadMore: hosted.loadMore },
      { wanted: wantsClips, items: clipItems, status: clips.status, loadMore: clips.loadMore },
      {
        wanted: wantsEnhanced,
        items: enhancedItems,
        status: enhanced.status,
        loadMore: enhanced.loadMore,
      },
    ],
    [
      wantsLocal,
      wantsApi,
      wantsClips,
      wantsEnhanced,
      localItems,
      hostedItems,
      clipItems,
      enhancedItems,
      local.status,
      hosted.status,
      clips.status,
      enhanced.status,
      local.loadMore,
      hosted.loadMore,
      clips.loadMore,
      enhanced.loadMore,
    ],
  );

  const failureItems = useMemo(() => (failures ?? []).map(fromFailureRecord), [failures]);

  const items = useMemo(() => {
    if (filter === "failed") return failureItems;
    const active = sides.filter((side) => side.wanted);
    const merged = active.reduce<FeedItem[]>((all, side) => mergeByTime(all, side.items), []);
    const boundary = active.reduce<number | undefined>(
      (cut, side) => (side.status === "Exhausted" ? cut : safeBoundary(cut, tailTime(side.items))),
      undefined,
    );
    return boundedByTail(merged, boundary).filter((item) => matches(item, filter));
  }, [sides, filter, failureItems]);

  /**
   * Load from whichever source is holding the boundary back. Pulling from the
   * other one would add items the cut immediately hides, which reads as a dead
   * button.
   *
   * A side with more to load and nothing on screen is maximally behind — it has
   * no tail to compare, and skipping it would starve its cursor while the feed
   * still claims there is more.
   */
  const loadMore = useCallback(() => {
    const waiting = sides.filter((side) => side.wanted && side.status === "CanLoadMore");
    if (waiting.length === 0) return;
    const empty = waiting.find((side) => side.items.length === 0);
    const target =
      empty ??
      waiting.reduce((furthest, side) =>
        (tailTime(side.items) ?? 0) > (tailTime(furthest.items) ?? 0) ? side : furthest,
      );
    target.loadMore(PAGE);
  }, [sides]);

  const canLoadMore =
    filter !== "failed" && sides.some((side) => side.wanted && side.status === "CanLoadMore");

  // Only genuinely first-load. Any source still loading its first page means
  // the merge is incomplete, and showing a partial feed then reordering is worse
  // than a moment of nothing.
  const isFirstLoad =
    filter === "failed"
      ? // `enabled` is false only for the viewer's cold-entry fallback, where the
        // query is skipped and would otherwise report loading for ever.
        enabled && failures === undefined
      : sides.some((side) => side.wanted && side.status === "LoadingFirstPage");

  /**
   * A page whose rows all fall away leaves an empty grid, and an empty list never
   * scrolls — so `onEndReached` never fires and the rows behind it are unreachable.
   *
   * Two filters can do it. "Enhanced" drops a run which produced no file — the
   * "no faces detected" case writes a row with an empty key. "Videos" reads a
   * table of mostly images. Keep asking until something lands or the budget runs
   * out; past it the empty state is the honest answer rather than a loop. The grid
   * is told it is still loading meanwhile, because "Nothing here yet." over a
   * fetch that has not finished is a wrong answer, not a slow one.
   */
  const drains = useRef(0);
  const lastFilter = useRef(filter);
  if (lastFilter.current !== filter) {
    lastFilter.current = filter;
    drains.current = 0;
  }
  const draining =
    !isFirstLoad && items.length === 0 && canLoadMore && drains.current < DRAIN_LIMIT;
  useEffect(() => {
    if (!draining) return;
    drains.current += 1;
    loadMore();
  }, [draining, loadMore]);

  // While the first page is still in flight, the snapshot stands in — so a cold
  // launch on the underground shows the library rather than an empty grid over a
  // full image cache. It is dropped the instant real results arrive.
  const [snapshot] = useState(readSnapshot);
  const showingSnapshot = isFirstLoad && filter === "all" && snapshot.length > 0;

  // Written whenever a live feed exists, read only when one does not. The
  // unfiltered view is the one worth keeping — a snapshot of "videos only" would
  // be a smaller answer to a different question.
  useEffect(() => {
    if (filter === "all" && !isFirstLoad && items.length > 0) saveSnapshot(items);
  }, [filter, isFirstLoad, items]);

  return {
    items: showingSnapshot ? snapshot : items,
    loadMore,
    canLoadMore,
    isLoading: (isFirstLoad || draining) && !showingSnapshot,
    showingSnapshot,
  };
}

function matches(item: FeedItem, filter: FeedFilter): boolean {
  switch (filter) {
    case "photos":
      return item.kind === "image" && item.status !== "failed";
    case "videos":
      return item.kind === "video" && item.status !== "failed";
    case "failed":
      return item.status === "failed";
    case "local":
    case "api":
    case "enhanced":
    case "all":
      // Failures are their own filter, so they stay out of the ordinary views —
      // a grid of red placeholders between real results helps nobody.
      return item.status !== "failed";
  }
}
