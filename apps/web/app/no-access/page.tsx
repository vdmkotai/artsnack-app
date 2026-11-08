"use client";

import { useState } from "react";
import { useAuth, useClerk } from "@clerk/nextjs";

/**
 * Shown when a valid Clerk session belongs to someone who is not on the
 * allowlist.
 *
 * This has to be a real route rather than HTML returned from the proxy, because
 * the only thing that actually ends the session is Clerk's own JS. Clerk keeps
 * `__client` on its Frontend-API domain (clerk.<your-domain>), not on the app's —
 * so clearing this site's cookies does nothing, and a plain link to /sign-in
 * makes it worse: `<SignIn />` sees a live session, bounces to the after-sign-in
 * URL, which is protected, which lands back here. That loop is what the first
 * version of this page shipped, and from the outside it looks like a ban.
 *
 * `signOut()` calls the Frontend API to destroy the client, which is the one
 * operation that breaks the cycle.
 *
 * The fallback link is the instance's own user-profile page (the Account
 * Portal unless the Clerk dashboard names another), read from Clerk rather
 * than configured, so it always belongs to whichever instance the keys select.
 */
export default function NoAccessPage() {
  const clerk = useClerk();
  const { signOut } = clerk;
  // Subscribes to Clerk's load, so the link appears once the URL is known.
  const { isLoaded } = useAuth();
  const accountPortalUrl = isLoaded ? clerk.buildUserProfileUrl() || null : null;
  const [signingOut, setSigningOut] = useState(false);

  const handleSignOut = async () => {
    setSigningOut(true);
    try {
      await signOut({ redirectUrl: "/sign-in" });
    } catch {
      // Never leave the person stuck on a dead button: a full reload of the
      // Account Portal can always sign out by hand.
      setSigningOut(false);
      if (accountPortalUrl) window.location.href = accountPortalUrl;
    }
  };

  return (
    <div className="flex min-h-dvh items-center justify-center px-8">
      <main className="max-w-lg text-center">
        <h1 className="mb-3 text-xl font-semibold tracking-tight">
          This account does not have access
        </h1>
        <p className="text-muted-foreground">
          ArtSnack is a private instance. Sign out below and try the account that does.
        </p>
        <button
          type="button"
          onClick={handleSignOut}
          disabled={signingOut}
          className="mt-7 rounded-md border border-border px-4 py-2 text-sm transition-colors hover:bg-accent hover:text-accent-foreground disabled:opacity-60"
        >
          {signingOut ? "Signing out…" : "Sign out"}
        </button>
        {accountPortalUrl && (
          <p className="mt-6 text-xs text-muted-foreground">
            Still stuck?{" "}
            <a className="underline" href={accountPortalUrl} rel="noreferrer noopener">
              Sign out from your Clerk account page
            </a>
            .
          </p>
        )}
      </main>
    </div>
  );
}
