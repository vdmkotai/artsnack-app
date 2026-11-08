"use client";

import { useEffect, useState } from "react";
import { useAuth } from "@clerk/nextjs";
import {
  useConvexAuth,
  useQuery as useLiveQuery,
  usePaginatedQuery as useLivePaginatedQuery,
  type OptionalRestArgsOrSkip,
  type PaginatedQueryArgs,
  type PaginatedQueryReference,
  type UsePaginatedQueryReturnType,
} from "convex/react";
import { getFunctionName, type FunctionReference, type FunctionReturnType } from "convex/server";
import { convexToJson, type Value } from "convex/values";
import { useConfirmedConvexUser } from "@/lib/convex-identity";

/**
 * Stale-while-revalidate for Convex queries across route changes.
 *
 * Convex drops a query's result the moment its last subscriber unmounts, so
 * every tab switch used to start from nothing: a skeleton for a WebSocket round
 * trip, then the whole grid mounting at once. These hooks are drop-in
 * replacements for `useQuery` / `usePaginatedQuery` that remember the last
 * result per query, arguments and signed-in user for the rest of the session,
 * and hand it back while a fresh subscription is still loading. The live
 * result replaces it as soon as it arrives — typically a few hundred
 * milliseconds — so what shows is at most as old as the last visit.
 *
 * Only results are remembered, not subscriptions: nothing keeps running on the
 * server for pages that are not open.
 */

/** Generous for one person's tabs; the oldest entry goes first beyond it. */
const MAX_SNAPSHOTS = 100;
/** A returning list asks for at most this many times its usual first page. */
const RESTORE_PAGE_FACTOR = 4;

const snapshots = new Map<string, unknown>();
/** The user the snapshots belong to; a different one empties the store. */
let snapshotOwner: string | null = null;

/**
 * Stores a result — only from an effect, and only once Convex has confirmed the
 * very user the page is rendering for (lib/convex-identity.ts). Across a session
 * switch Clerk reports the new user at once while the live subscriptions still
 * hold the previous user's results until Convex re-authenticates, so recording
 * in that window would file one person's data under another's key. Keys carry
 * the user id as well, and a new owner clears everything, so nothing recorded
 * before a switch survives it.
 */
function remember(owner: string, key: string, value: unknown) {
  if (owner !== snapshotOwner) {
    snapshots.clear();
    snapshotOwner = owner;
  }
  snapshots.delete(key);
  snapshots.set(key, value);
  if (snapshots.size > MAX_SNAPSHOTS) {
    const oldest = snapshots.keys().next().value;
    if (oldest !== undefined) snapshots.delete(oldest);
  }
}

function snapshotKey(
  user: string | null | undefined,
  query: FunctionReference<"query">,
  args: Record<string, Value>,
): string | null {
  if (!user) return null;
  return `${user}|${getFunctionName(query)}|${JSON.stringify(convexToJson(args))}`;
}

/** `useQuery` from convex/react, answering from the last visit while it loads. */
export function useQuery<Query extends FunctionReference<"query">>(
  query: Query,
  ...args: OptionalRestArgsOrSkip<Query>
): FunctionReturnType<Query> | undefined {
  const { userId } = useAuth();
  const { isAuthenticated, isLoading } = useConvexAuth();
  const confirmedUser = useConfirmedConvexUser();
  const confirmed = isAuthenticated && !isLoading && !!userId && confirmedUser === userId;
  const raw = args[0] as Record<string, Value> | "skip" | undefined;
  // Widened to call without a spread, which the React Compiler cannot compile
  // in a hook call; the public signature above keeps callers fully typed.
  const live = useLiveQuery(query as FunctionReference<"query">, raw) as
    | FunctionReturnType<Query>
    | undefined;
  const key = raw === "skip" ? null : snapshotKey(userId, query, raw ?? {});

  useEffect(() => {
    if (confirmed && userId && key !== null && live !== undefined) remember(userId, key, live);
  }, [confirmed, userId, key, live]);

  if (live !== undefined || key === null) return live;
  return snapshots.get(key) as FunctionReturnType<Query> | undefined;
}

/**
 * `usePaginatedQuery` from convex/react, answering from the last visit while
 * its first page loads.
 *
 * The remembered list is reported as "LoadingMore" — items on screen, more on
 * the way — so a page that hides everything behind "LoadingFirstPage" shows it
 * at once. A list the user had scrolled through is also asked for whole again
 * (up to RESTORE_PAGE_FACTOR first pages), so it does not shrink back to one
 * page under them when the live result lands.
 */
export function usePaginatedQuery<Query extends PaginatedQueryReference>(
  query: Query,
  args: PaginatedQueryArgs<Query> | "skip",
  options: { initialNumItems: number },
): UsePaginatedQueryReturnType<Query> {
  const { userId } = useAuth();
  const { isAuthenticated, isLoading } = useConvexAuth();
  const confirmedUser = useConfirmedConvexUser();
  const confirmed = isAuthenticated && !isLoading && !!userId && confirmedUser === userId;
  const key =
    args === "skip"
      ? null
      : snapshotKey(userId, query, { ...(args as Record<string, Value>), __paginated: true });
  // Decided once per mount: a changing page size would restart pagination.
  const [initialNumItems] = useState(() => {
    const restored = key === null ? undefined : (snapshots.get(key) as unknown[] | undefined);
    return Math.max(
      options.initialNumItems,
      Math.min(restored?.length ?? 0, options.initialNumItems * RESTORE_PAGE_FACTOR),
    );
  });
  const live = useLivePaginatedQuery(query, args, { initialNumItems });

  useEffect(() => {
    if (confirmed && userId && key !== null && live.status !== "LoadingFirstPage") {
      remember(userId, key, live.results);
    }
  }, [confirmed, userId, key, live.status, live.results]);

  if (live.status === "LoadingFirstPage" && key !== null) {
    const restored = snapshots.get(key) as
      | UsePaginatedQueryReturnType<Query>["results"]
      | undefined;
    if (restored) {
      return {
        results: restored,
        status: "LoadingMore",
        isLoading: true,
        loadMore: ignoreLoadMore,
      };
    }
  }
  return live;
}

function ignoreLoadMore() {
  // Pages are requested once the live first page is in.
}
