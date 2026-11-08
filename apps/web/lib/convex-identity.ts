"use client";

import { useEffect, useSyncExternalStore } from "react";
import { useAuth } from "@clerk/nextjs";
import { useConvexAuth } from "convex/react";
import {
  getConfirmedUser,
  observeConvexIdentity,
  subscribeConfirmedUser,
} from "@/lib/convex-identity-state";

/**
 * The Clerk user whose identity Convex has confirmed — the user that live query
 * results can be trusted to belong to.
 *
 * Clerk and Convex do not change identity in the same render. On a session
 * switch Clerk reports user B at once, while Convex still says "authenticated"
 * (about A's token) and every live subscription still holds A's results; only
 * after it drops A's token and confirms B's do the results become B's. Anything
 * that files results by user — convex-cache's snapshots — must wait for that
 * whole cycle, or it records A's data under B's name.
 *
 * So a user counts as confirmed only after Convex has been seen *not* ready and
 * then ready again since Clerk first reported that user. The same user's token
 * refreshes never touch this; a sign-out clears it.
 */

export function useConfirmedConvexUser(): string | null {
  return useSyncExternalStore(subscribeConfirmedUser, getConfirmedUser, () => null);
}

/** Mounted once, inside the Convex provider; renders nothing. */
export function ConvexIdentityTracker() {
  const { userId } = useAuth();
  const { isAuthenticated, isLoading } = useConvexAuth();
  useEffect(() => {
    observeConvexIdentity(userId ?? null, isAuthenticated && !isLoading);
  }, [userId, isAuthenticated, isLoading]);
  return null;
}
