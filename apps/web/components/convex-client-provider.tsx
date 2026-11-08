"use client";

import { ReactNode, useCallback, useEffect, useMemo, useState } from "react";
import { ConvexProviderWithAuth, ConvexReactClient } from "convex/react";
import { useAuth } from "@clerk/nextjs";
import { fetchConvexToken } from "@/lib/convex-token";
import { ConvexIdentityTracker } from "@/lib/convex-identity";

/**
 * `expectAuth` holds every query until the first token is in. Without it each
 * page's queries ran once anonymously — rendering "Nothing saved yet" and
 * "Sign in to …" for a moment — and again once the token landed, and every
 * page is behind sign-in anyway. `initialAuthTokenReuse` drops the second
 * Authenticate the client used to send right after the first was confirmed,
 * which re-ran every authenticated query a third time on load.
 */
const convex = new ConvexReactClient(process.env.NEXT_PUBLIC_CONVEX_URL!, {
  expectAuth: true,
  initialAuthTokenReuse: true,
});

/** How often a stranded session tries to re-authenticate on its own. */
const STRANDED_RETRY_MS = 30_000;

/**
 * Clerk's session as Convex wants it — `convex/react-clerk`'s adapter with two
 * changes: token requests ride out transient failures (lib/convex-token.ts),
 * and a session that still failed is re-authenticated when the window comes
 * back, the network returns, or every half minute, instead of staying
 * anonymous until a reload.
 */
function useClerkAuthForConvex() {
  const { isLoaded, isSignedIn, getToken, orgId, orgRole, sessionId, sessionClaims } = useAuth();
  // The stock adapter's test for the Convex integration versus the "convex"
  // JWT template.
  const useTemplate = sessionClaims?.aud !== "convex";
  const [recovery, setRecovery] = useState(0);
  const [stranded, setStranded] = useState(false);

  useEffect(() => {
    if (!stranded) return;
    const retry = () => {
      if (document.visibilityState === "hidden") return;
      setStranded(false);
      setRecovery((count) => count + 1);
    };
    window.addEventListener("online", retry);
    window.addEventListener("focus", retry);
    document.addEventListener("visibilitychange", retry);
    const timer = window.setInterval(retry, STRANDED_RETRY_MS);
    return () => {
      window.removeEventListener("online", retry);
      window.removeEventListener("focus", retry);
      document.removeEventListener("visibilitychange", retry);
      window.clearInterval(timer);
    };
  }, [stranded]);

  // A new function is what makes ConvexProviderWithAuth call setAuth again, so
  // its identity follows the session (as in the stock adapter) and `recovery`.
  const sessionKey = `${sessionId ?? ""}|${orgId ?? ""}|${orgRole ?? ""}|${recovery}`;
  const fetchAccessToken = useCallback(
    async ({ forceRefreshToken }: { forceRefreshToken: boolean }) => {
      void sessionKey; // read only for identity, see above
      const token = await fetchConvexToken(getToken, useTemplate, forceRefreshToken);
      // Still signed in to Clerk yet no token: Convex has now given up on this
      // session, so arrange to hand it a fresh fetcher later.
      if (token === null && sessionId) setStranded(true);
      return token;
    },
    [getToken, useTemplate, sessionId, sessionKey],
  );

  return useMemo(
    () => ({
      isLoading: !isLoaded,
      isAuthenticated: isSignedIn ?? false,
      fetchAccessToken,
    }),
    [isLoaded, isSignedIn, fetchAccessToken],
  );
}

export function ConvexClientProvider({ children }: { children: ReactNode }) {
  return (
    <ConvexProviderWithAuth client={convex} useAuth={useClerkAuthForConvex}>
      <ConvexIdentityTracker />
      {children}
    </ConvexProviderWithAuth>
  );
}
