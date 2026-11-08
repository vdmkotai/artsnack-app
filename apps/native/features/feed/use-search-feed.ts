import { usePaginatedQuery } from "convex/react";
import { useEffect, useMemo, useRef } from "react";

import { api } from "@/convex/_generated/api";
import {
  resolveSearchOutput,
  searchDocuments,
  type SearchIntent,
  type SearchOutput,
  type SearchResult,
} from "@/lib/search";

import { aspectFrom, type FeedItem } from "./types";

const PAGE = 256;

/** The same complete catalogue and query grammar as the web search page. */
export function useSearchFeed(intent: SearchIntent) {
  const local = usePaginatedQuery(api.searchCatalog.local, {}, { initialNumItems: PAGE });
  const hosted = usePaginatedQuery(api.searchCatalog.hosted, {}, { initialNumItems: PAGE });
  const videos = usePaginatedQuery(api.searchCatalog.videos, {}, { initialNumItems: PAGE });
  const localStatus = local.status;
  const hostedStatus = hosted.status;
  const videoStatus = videos.status;
  const loadMoreLocal = local.loadMore;
  const loadMoreHosted = hosted.loadMore;
  const loadMoreVideos = videos.loadMore;

  useEffect(() => {
    if (localStatus === "CanLoadMore") loadMoreLocal(PAGE);
  }, [localStatus, loadMoreLocal]);
  useEffect(() => {
    if (hostedStatus === "CanLoadMore") loadMoreHosted(PAGE);
  }, [hostedStatus, loadMoreHosted]);
  useEffect(() => {
    if (videoStatus === "CanLoadMore") loadMoreVideos(PAGE);
  }, [videoStatus, loadMoreVideos]);

  const documents = useMemo(
    () => [...local.results, ...hosted.results, ...videos.results],
    [local.results, hosted.results, videos.results],
  );
  const lastValid = useRef<SearchOutput | undefined>(undefined);
  const resolved = useMemo(
    () => resolveSearchOutput(documents, intent, lastValid.current),
    [documents, intent],
  );
  lastValid.current = resolved.lastValid;
  const results = resolved.output.results;
  const items = useMemo(() => results.map(toFeedItem), [results]);
  const loading =
    localStatus !== "Exhausted" || hostedStatus !== "Exhausted" || videoStatus !== "Exhausted";

  return {
    items,
    results,
    output: resolved.output,
    syntaxError: resolved.syntaxError,
    loading,
    catalogCount: documents.length,
    previewCount: (next: SearchIntent) => {
      const preview = searchDocuments(documents, next);
      return "results" in preview ? preview.results.length : 0;
    },
  };
}

function toFeedItem(result: SearchResult): FeedItem {
  const document = result.document;
  return {
    id: result.id,
    source: document.source === "api" ? "api" : document.mediaType === "video" ? "video" : "local",
    rowId: document.id,
    createdAt: document.createdAt,
    kind: document.mediaType,
    mediaKey: result.asset.key,
    thumbnailKey: result.asset.thumbnailKey,
    status: "completed",
    prompt: document.prompt,
    aspect: aspectFrom(document.aspectRatio, document.width, document.height),
  };
}
