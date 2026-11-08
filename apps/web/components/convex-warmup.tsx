"use client";

import { Component, useEffect, useState, type ReactNode } from "react";
import { useConvexAuth } from "convex/react";
import { api } from "@/convex/_generated/api";
import { useQuery, usePaginatedQuery } from "@/lib/convex-cache";

/** Long enough for the page the user landed on to finish its own loading first. */
const WARMUP_DELAY_MS = 2_500;
/** A warm-up that has not settled by then gives up; nothing depends on it. */
const WARMUP_LIMIT_MS = 20_000;

/**
 * Fills the convex-cache snapshots for each tab's first screen, once, while
 * the app is idle — so even the first visit to a tab in a session renders from
 * memory instead of waiting a WebSocket round trip behind a skeleton.
 *
 * Mounted in the root layout. After the landing page has settled it subscribes
 * to the queries the main tabs open with, with the same arguments they use (the
 * snapshot key is user + query + arguments), waits for each to answer once,
 * and unmounts — so nothing stays subscribed and no background job's writes
 * reach it afterwards. A tab visited later shows what this saw, then its own
 * live subscription replaces it within a round trip.
 */
export function ConvexWarmup() {
  const { isAuthenticated, isLoading } = useConvexAuth();
  const [phase, setPhase] = useState<"waiting" | "warming" | "done">("waiting");

  useEffect(() => {
    if (phase !== "waiting" || isLoading || !isAuthenticated) return;
    let idle = 0;
    const timer = window.setTimeout(() => {
      const start = () => setPhase("warming");
      idle =
        typeof window.requestIdleCallback === "function"
          ? window.requestIdleCallback(start, { timeout: 5_000 })
          : window.setTimeout(start, 0);
    }, WARMUP_DELAY_MS);
    return () => {
      window.clearTimeout(timer);
      if (idle && typeof window.cancelIdleCallback === "function") window.cancelIdleCallback(idle);
    };
  }, [phase, isLoading, isAuthenticated]);

  useEffect(() => {
    if (phase !== "warming") return;
    const timer = window.setTimeout(() => setPhase("done"), WARMUP_LIMIT_MS);
    return () => window.clearTimeout(timer);
  }, [phase]);

  return phase === "warming" ? (
    <WarmupBoundary onError={() => setPhase("done")}>
      <WarmQueries onDone={() => setPhase("done")} />
    </WarmupBoundary>
  ) : null;
}

/**
 * A query that fails here — any of them, for any reason — must not reach the
 * root layout's error handling: Convex hooks throw query errors during render,
 * and this sits above every page. The warm-up just ends; the tab that owns the
 * query will meet the same error on its own, inside its own boundary.
 */
class WarmupBoundary extends Component<{ onError: () => void; children: ReactNode }> {
  override state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  override componentDidCatch() {
    this.props.onError();
  }

  override render() {
    return this.state.failed ? null : this.props.children;
  }
}

function WarmQueries({ onDone }: { onDone: () => void }) {
  // History, Gallery and the Self-hosted tab share this list (and its key).
  const generations = usePaginatedQuery(api.generations.listPaginated, {}, { initialNumItems: 30 });
  // The API tab's results.
  const hosted = usePaginatedQuery(api.grokGenerations.list, {}, { initialNumItems: 30 });
  // Favorites as it opens: every folder, no filters.
  const favorites = usePaginatedQuery(api.favorites.listFavorites, {}, { initialNumItems: 30 });
  const facets = useQuery(api.favorites.facets, {});
  const folders = useQuery(api.favoriteFolders.list);
  const favoriteKeys = useQuery(api.favorites.myKeys);
  const enhancements = useQuery(api.enhancements.list);
  const prompts = useQuery(api.savedPrompts.list);

  const settled =
    generations.status !== "LoadingFirstPage" &&
    hosted.status !== "LoadingFirstPage" &&
    favorites.status !== "LoadingFirstPage" &&
    facets !== undefined &&
    folders !== undefined &&
    favoriteKeys !== undefined &&
    enhancements !== undefined &&
    prompts !== undefined;

  useEffect(() => {
    // One more frame so convex-cache's own effects have recorded the answers.
    if (!settled) return;
    const frame = window.requestAnimationFrame(onDone);
    return () => window.cancelAnimationFrame(frame);
  }, [settled, onDone]);

  return null;
}
