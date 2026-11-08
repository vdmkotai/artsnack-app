"use client";

import "./globals.css";

// This replaces the root layout when it is the layout itself that throws, so it
// gets no fonts, no nav and no Convex provider — hence the plain markup and the
// hard link instead of next/link. `dark` is set here because app/layout.tsx,
// which normally sets it, is exactly what is missing.
export default function GlobalError({
  error,
  unstable_retry,
}: {
  error: Error & { digest?: string };
  unstable_retry: () => void;
}) {
  return (
    <html lang="en" className="dark">
      <body className="min-h-screen bg-background text-foreground antialiased">
        <title>Something went wrong — ArtSnack</title>
        <div className="flex min-h-dvh flex-col items-center justify-center gap-6 px-4 py-12 text-center">
          <div className="max-w-md space-y-2">
            <h1 className="text-2xl font-bold tracking-tight">Something went wrong</h1>
            <p className="text-muted-foreground">
              ArtSnack failed to start up. Reloading usually clears it.
            </p>
          </div>

          {(error.message || error.digest) && (
            <pre className="max-w-md overflow-x-auto rounded-md border border-border bg-muted/30 p-3 text-left font-mono text-xs text-muted-foreground">
              {/* Both, never one or the other: a production build replaces the message
                  of a server error with a fixed generic string, so the digest is the
                  only thing that correlates this screen with a line in the log. */}
              {[error.message, error.digest && `Error digest: ${error.digest}`]
                .filter(Boolean)
                .join("\n")}
            </pre>
          )}

          <div className="flex flex-wrap items-center justify-center gap-2">
            <button
              type="button"
              onClick={() => unstable_retry()}
              className="inline-flex h-8 items-center rounded-md bg-primary px-3 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/80"
            >
              Try again
            </button>
            {/* oxlint-disable-next-line no-html-link-for-pages -- next/link needs the
                app-router context that the thrown root layout may not have set up;
                a client-side navigation here would rethrow inside this boundary. */}
            <a
              href="/generate"
              className="inline-flex h-8 items-center rounded-md border border-border px-3 text-xs font-medium transition-colors hover:bg-muted"
            >
              Back to Generate
            </a>
          </div>
        </div>
      </body>
    </html>
  );
}
