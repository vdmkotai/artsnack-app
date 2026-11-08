"use client";

import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  clearMediaCache,
  mediaCacheEnabled,
  mediaCacheStats,
  type MediaCacheStats,
} from "@/lib/media-cache";

function formatSize(bytes: number): string {
  const mb = bytes / 1024 ** 2;
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${Math.round(mb)} MB`;
}

/**
 * The local media cache on this device: how much it holds, and a way to empty
 * it. Per device and per browser, unlike everything else on the Settings page.
 */
export function MediaCacheSettings() {
  // undefined while asking; null when no worker controls this page.
  const [stats, setStats] = useState<MediaCacheStats | null | undefined>(undefined);
  const [clearing, setClearing] = useState(false);

  useEffect(() => {
    void mediaCacheStats().then(setStats);
  }, []);

  const clear = async () => {
    setClearing(true);
    const done = await clearMediaCache();
    setClearing(false);
    if (!done) {
      toast.error("Could not reach the media cache");
      return;
    }
    setStats(await mediaCacheStats());
    toast.success("Media cache cleared");
  };

  return (
    <section className="mt-8 space-y-3">
      <div>
        <h2 className="text-base font-semibold">Local media cache</h2>
        <p className="text-sm text-muted-foreground">
          Images you open, and videos you hover or that just finished, are kept on this device, so
          the next time they open from disk; other videos stream without being kept. This one is per
          device and per browser.
        </p>
      </div>

      <div className="flex items-center justify-between gap-4 rounded-lg border bg-card px-4 py-3">
        <span className="text-sm">
          {stats === undefined ? (
            <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
          ) : stats === null ? (
            <span className="text-muted-foreground">
              {mediaCacheEnabled
                ? "Not active in this window yet — it starts after the next reload."
                : "Turned off for this deployment."}
            </span>
          ) : (
            <>
              <span className="font-medium">{formatSize(stats.bytes)}</span>
              <span className="text-muted-foreground">
                {" "}
                in {stats.count} {stats.count === 1 ? "file" : "files"}, up to{" "}
                {formatSize(stats.limit)}
              </span>
            </>
          )}
        </span>
        <Button
          variant="outline"
          size="sm"
          disabled={!stats || stats.count === 0 || clearing}
          onClick={() => void clear()}
        >
          {clearing && <Loader2 className="mr-1 h-3 w-3 animate-spin" />}
          Clear
        </Button>
      </div>
    </section>
  );
}
