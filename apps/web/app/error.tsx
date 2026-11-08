"use client";

import Link from "next/link";
import { RotateCcw, Trash2, TriangleAlert } from "lucide-react";

import { Button } from "@/components/ui/button";

// Duplicated rather than imported. Three of these live inside page modules
// (app/generate, app/generate-video, app/enhance) and this boundary is the last
// thing standing when one of those pages fails to render — importing it back in
// would put the broken module in the recovery path.
const SETTINGS_STORAGE_KEYS = [
  "artsnack_form_state", // app/generate
  "artsnack-video-settings", // app/generate-video
  "artsnack_enhance_form_state", // app/enhance
  "artsnack_api_form", // components/api/api-panel (lib/normalize-form)
  "artsnack_grok_form", // legacy key the API panel still reads
];

export default function ErrorBoundary({
  error,
  unstable_retry,
}: {
  error: Error & { digest?: string };
  unstable_retry: () => void;
}) {
  const clearSavedSettings = () => {
    for (const key of SETTINGS_STORAGE_KEYS) {
      try {
        window.localStorage.removeItem(key);
      } catch {
        // Private-mode / disabled storage: nothing to clear, nothing to report.
      }
    }
    // A full reload rather than unstable_retry(): a structurally wrong blob has
    // usually already been parsed into module scope, which a boundary retry keeps.
    window.location.reload();
  };

  return (
    <div className="container flex min-h-[calc(100dvh-4rem)] flex-col items-center justify-center gap-6 px-4 py-12 text-center">
      <div className="rounded-full bg-destructive/10 p-6">
        <TriangleAlert className="h-12 w-12 text-destructive" />
      </div>

      <div className="max-w-md space-y-2">
        <h2 className="text-2xl font-bold tracking-tight">Something went wrong</h2>
        <p className="text-muted-foreground">
          This screen failed to render. Trying again is usually enough; if it keeps happening,
          clearing the saved form settings is the next thing to try.
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
        <Button size="lg" onClick={() => unstable_retry()}>
          <RotateCcw />
          Try again
        </Button>
        <Link href="/generate">
          <Button size="lg" variant="outline">
            Back to Generate
          </Button>
        </Link>
        <Button size="lg" variant="destructive" onClick={clearSavedSettings}>
          <Trash2 />
          Clear saved settings
        </Button>
      </div>
    </div>
  );
}
