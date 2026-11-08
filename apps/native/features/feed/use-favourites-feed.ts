import { usePaginatedQuery } from "convex/react";
import { useCallback, useEffect, useMemo, useRef } from "react";

import { api } from "@/convex/_generated/api";

import { aspectFrom, type FeedItem } from "./types";

const PAGE = 40;

type FavouriteRow = {
  _id: string;
  createdAt: number;
  b2Key: string;
  generationId?: string;
  apiGenerationId?: string;
  enhancementId?: string;
  mediaType: "image" | "video";
  aspectRatio?: string;
  prompt?: string;
  formState?: { width: number; height: number };
};

/**
 * The narrowings the Favourites screen can apply, in the dialect
 * `favorites.listFavorites` speaks: `folderId` is absent for everything,
 * `"none"` for the unfiled pool, or a folder's id.
 */
export type FavouritesFilter = {
  folderId?: string;
  mediaType?: "image" | "video";
  providers?: string[];
  checkpoints?: string[];
};

/**
 * Favourites: kept output, newest first.
 *
 * Filters are the server's: folder scope, media type, provider and checkpoint all
 * go to `listFavorites`, which filters *after* paginating — so a page can come back
 * empty while more exist, and the effect below keeps drawing until something lands
 * or the cursor is exhausted.
 */
export function useFavouritesFeed(enabled = true, filter: FavouritesFilter = {}) {
  const providerFilter = filter.providers ?? [];
  const checkpointFilter = filter.checkpoints ?? [];

  const favourites = usePaginatedQuery(
    api.favorites.listFavorites,
    enabled
      ? {
          folderId: filter.folderId,
          mediaType: filter.mediaType,
          providers: providerFilter.length > 0 ? providerFilter : undefined,
          checkpoints: checkpointFilter.length > 0 ? checkpointFilter : undefined,
        }
      : "skip",
    { initialNumItems: PAGE },
  );

  const items = useMemo<FeedItem[]>(
    () =>
      (favourites.results ?? []).map((row: FavouriteRow) => ({
        id: row._id,
        source: row.generationId ? "local" : row.enhancementId ? "enhance" : "api",
        // Never the favourite's own id as a fallback: it belongs to a different
        // table than any of the three validators accept, so a row that reached
        // that branch could not be un-favourited at all.
        rowId: row.generationId ?? row.enhancementId ?? row.apiGenerationId ?? row._id,
        favoriteId: row._id,
        createdAt: row.createdAt,
        kind: row.mediaType,
        mediaKey: row.b2Key,
        status: "completed" as const,
        prompt: row.prompt ?? "",
        aspect: aspectFrom(row.aspectRatio, row.formState?.width, row.formState?.height),
      })),
    [favourites.results],
  );

  const loadMore = useCallback(() => {
    if (favourites.status === "CanLoadMore") favourites.loadMore(PAGE);
  }, [favourites]);

  const canLoadMore = favourites.status === "CanLoadMore";

  const isLoading = favourites.status === "LoadingFirstPage";

  /**
   * The server filters after paginating, so a filtered first page can be empty with
   * more behind it — and an empty list never scrolls, so `onEndReached` alone would
   * leave "Nothing here" over rows that exist. Keep drawing until something lands
   * or the budget runs out. The cap exists because a filter that truly matches
   * nothing would otherwise walk the whole table one page at a time; past it, the
   * empty state stands as the best available answer.
   */
  const drains = useRef(0);
  const drainKey = `${filter.folderId ?? ""}|${filter.mediaType ?? ""}|${providerFilter.join(",")}|${checkpointFilter.join(",")}`;
  const lastDrainKey = useRef(drainKey);
  if (lastDrainKey.current !== drainKey) {
    lastDrainKey.current = drainKey;
    drains.current = 0;
  }
  useEffect(() => {
    if (isLoading) return;
    if (items.length > 0) return;
    // Only when a cursor is actually ready to move. `loadMore` changes identity
    // on every render, so without this the budget was spent by re-renders — a
    // page in flight reports "LoadingMore", every call during it was a no-op, and
    // a deep filter gave up around half way with rows still unread.
    if (!canLoadMore) return;
    if (drains.current >= 25) return;
    drains.current += 1;
    loadMore();
  }, [isLoading, items.length, canLoadMore, loadMore]);

  return {
    items,
    loadMore,
    canLoadMore,
    isLoading,
  };
}
