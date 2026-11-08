"use client";

import { SignIn } from "@clerk/nextjs";
import { useSearchParams } from "next/navigation";
import { useState } from "react";
import { Globe } from "lucide-react";
import { useDesktop } from "@/hooks/use-desktop";

/**
 * The sign-in page, with one difference inside the macOS shell: a card that
 * sends sign-in to the system browser, because Google will not complete
 * OAuth inside an embedded browser. Clerk's own <SignIn> still mounts
 * underneath — it is what consumes the `__clerk_ticket` the browser hands
 * back, and it still offers any non-OAuth method. In a browser this is just
 * <SignIn>.
 */
export function DesktopSignIn() {
  const desktop = useDesktop();
  const params = useSearchParams();
  const [opened, setOpened] = useState(false);
  const finishingTicket = params.has("__clerk_ticket");

  if (!desktop || finishingTicket) return <SignIn />;

  return (
    <div className="flex w-full max-w-sm flex-col items-center gap-6">
      <div className="w-full rounded-2xl border bg-card p-6 text-center shadow-lg">
        <h1 className="font-heading text-lg font-semibold tracking-tight">Sign in to ArtSnack</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Google sign-in has to happen in your browser. It will hand the session back to the app
          when it is done.
        </p>
        <button
          type="button"
          onClick={() => {
            window.artsnackDesktop?.signInWithBrowser();
            setOpened(true);
          }}
          className="mt-5 inline-flex h-10 w-full items-center justify-center gap-2 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <Globe className="h-4 w-4" />
          {opened ? "Open again in browser" : "Continue in browser"}
        </button>
        {opened && (
          <p className="mt-3 text-xs text-muted-foreground">
            Finish signing in there. This window updates by itself.
          </p>
        )}
      </div>
      <details className="w-full text-center">
        <summary className="cursor-pointer text-xs text-muted-foreground hover:text-foreground">
          Other ways to sign in
        </summary>
        <div className="mt-4 flex justify-center">
          <SignIn />
        </div>
      </details>
    </div>
  );
}
