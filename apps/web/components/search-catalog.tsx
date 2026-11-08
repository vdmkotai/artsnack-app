"use client";

import { Component, useEffect, useLayoutEffect, type ReactNode } from "react";
import { usePaginatedQuery } from "convex/react";

import { api } from "@/convex/_generated/api";
import type { SearchCatalogStore } from "@/lib/search-catalog";

const CATALOG_PAGE = 256;

/**
 * The two catalogue subscriptions, mounted by SearchProvider only while the
 * user is on /search or recently left it.
 *
 * They live in their own component behind an error boundary: SearchProvider
 * wraps every page, and a query error thrown out of `usePaginatedQuery` would
 * otherwise unmount the whole app shell. Here it only reaches the store, and
 * the search page shows it with a retry.
 */
export function SearchCatalogSubscription({ store }: { store: SearchCatalogStore }) {
  return (
    <SearchCatalogBoundary store={store}>
      <SearchCatalogLoader store={store} />
    </SearchCatalogBoundary>
  );
}

function SearchCatalogLoader({ store }: { store: SearchCatalogStore }) {
  const local = usePaginatedQuery(api.searchCatalog.local, {}, { initialNumItems: CATALOG_PAGE });
  const hosted = usePaginatedQuery(api.searchCatalog.hosted, {}, { initialNumItems: CATALOG_PAGE });
  const localResults = local.results;
  const hostedResults = hosted.results;
  const localStatus = local.status;
  const hostedStatus = hosted.status;
  const loadMoreLocal = local.loadMore;
  const loadMoreHosted = hosted.loadMore;

  // Full-history search: page both tables to the end, as fast as they answer.
  useEffect(() => {
    if (localStatus === "CanLoadMore") loadMoreLocal(CATALOG_PAGE);
  }, [localStatus, loadMoreLocal]);
  useEffect(() => {
    if (hostedStatus === "CanLoadMore") loadMoreHosted(CATALOG_PAGE);
  }, [hostedStatus, loadMoreHosted]);

  // Layout effect so the search page never paints a frame between the
  // snapshot and the "refreshing" state of the subscription that replaces it.
  useLayoutEffect(() => {
    store.connect();
    return () => store.disconnect();
  }, [store]);

  useEffect(() => {
    store.push({
      local: { documents: localResults, done: localStatus === "Exhausted" },
      hosted: { documents: hostedResults, done: hostedStatus === "Exhausted" },
    });
  }, [store, localResults, hostedResults, localStatus, hostedStatus]);

  return null;
}

class SearchCatalogBoundary extends Component<
  { store: SearchCatalogStore; children: ReactNode },
  { failed: boolean }
> {
  override state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  override componentDidCatch(error: unknown) {
    this.props.store.fail(error instanceof Error ? error : new Error(String(error)));
  }

  override render() {
    return this.state.failed ? null : this.props.children;
  }
}
