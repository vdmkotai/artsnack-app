"use client";

import { useEffect, useState } from "react";
import { useDesktop } from "@/hooks/use-desktop";

/**
 * Fires the deep link once on mount and then leaves a button in case the
 * browser asked for confirmation and the user dismissed it. Deliberately not
 * a server redirect: a 302 to a custom scheme is treated inconsistently and
 * gives the user nothing to click when it is blocked.
 */
export function HandoffLauncher({ href }: { href: string }) {
  const [launched, setLaunched] = useState(false);
  const desktop = useDesktop();

  useEffect(() => {
    const id = setTimeout(() => {
      window.location.href = href;
      setLaunched(true);
    }, 150);
    return () => clearTimeout(id);
  }, [href]);

  return (
    <div className="flex min-h-screen items-center justify-center p-6">
      <div className="w-full max-w-sm rounded-2xl border bg-card p-8 text-center shadow-xl">
        <Mark />
        <h1 className="mt-6 font-heading text-xl font-semibold tracking-tight">
          {launched ? "Opening ArtSnack…" : "Signing you in to ArtSnack"}
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">
          {desktop
            ? "You are already in the app. Sign-in should complete in a moment."
            : "If the app did not open, use the button below. The link works once and expires in two minutes."}
        </p>
        <a
          href={href}
          className="mt-6 inline-flex h-10 w-full items-center justify-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
        >
          Open ArtSnack
        </a>
        <p className="mt-4 text-xs text-muted-foreground">You can close this tab afterwards.</p>
      </div>
    </div>
  );
}

/** Shown when the server could not mint a sign-in token. */
export function HandoffFailure({ message }: { message: string }) {
  return (
    <div className="flex min-h-screen items-center justify-center p-6">
      <div className="w-full max-w-md rounded-2xl border bg-card p-8 text-center shadow-xl">
        <Mark />
        <h1 className="mt-6 font-heading text-xl font-semibold tracking-tight">
          Couldn&apos;t hand sign-in to the app
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">
          You are signed in here, but Clerk refused to issue the one-time token the app needs.
        </p>
        <pre className="mt-4 whitespace-pre-wrap break-words rounded-md border bg-muted/40 p-3 text-left font-mono text-xs text-muted-foreground">
          {message}
        </pre>
        <button
          type="button"
          onClick={() => window.location.reload()}
          className="mt-6 inline-flex h-10 w-full items-center justify-center rounded-md border bg-background px-4 text-sm font-medium transition-colors hover:bg-accent"
        >
          Try again
        </button>
      </div>
    </div>
  );
}

function Mark() {
  return (
    <svg width="44" height="44" viewBox="0 0 32 32" className="mx-auto" aria-hidden>
      <defs>
        <linearGradient id="artsnack-handoff-mark" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#f97316" />
          <stop offset="1" stopColor="#ec4899" />
        </linearGradient>
      </defs>
      <rect width="32" height="32" rx="7" fill="#18181b" />
      <path
        d="M8 24 L12 8 L16 18 L20 10 L24 24"
        stroke="url(#artsnack-handoff-mark)"
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />
      <circle cx="24" cy="10" r="2.5" fill="url(#artsnack-handoff-mark)" />
    </svg>
  );
}
