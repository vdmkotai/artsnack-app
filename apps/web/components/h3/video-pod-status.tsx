"use client";

import * as React from "react";
import { useAction, useQuery } from "convex/react";
import { Download, Loader2, Plus, Settings2 } from "lucide-react";

import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { RunpodBackendPanel, usePolling } from "@/components/runpod-backend-panel";
import type { PodDownloadsStatus } from "@/lib/pod-model-downloads";
import { cn } from "@/lib/utils";

/** While a file is arriving the bar should move; otherwise the list only
 *  changes when a download order lands, so a slow look is enough. */
const DOWNLOAD_POLL_MS = 3_000;
const IDLE_DOWNLOAD_POLL_MS = 30_000;

/** The pod answers with a fresh object every time; keep the old one when
 *  nothing in it moved, so an idle list does not re-render every poll. */
function sameStatus(a: PodDownloadsStatus | null, b: PodDownloadsStatus | null): boolean {
  return a === b || (a !== null && b !== null && JSON.stringify(a) === JSON.stringify(b));
}

function gb(bytes: number): string {
  return `${(bytes / 1e9).toFixed(1)} GB`;
}

/**
 * What the video pod is fetching right now — the base set at boot is not on
 * this list (provision.sh downloads it before the pod reports ready), but every
 * custom checkpoint and LoRA from the provisioning manifest is, as it arrives
 * after boot.
 */
function VideoPodDownloads({
  active,
  backendId,
}: {
  active: boolean;
  backendId?: Id<"runpodBackends">;
}) {
  const readStatus = useAction(api.podDownloads.status);
  const [status, setStatus] = React.useState<PodDownloadsStatus | null>(null);

  usePolling(active ? `video-downloads:${backendId ?? ""}` : null, async (isCurrent) => {
    const next = await readStatus({ profile: "video", backendId }).catch(() => null);
    if (isCurrent()) setStatus((current) => (sameStatus(current, next) ? current : next));
    const downloading = next?.jobs.some((job) => job.status === "downloading") ?? false;
    return downloading ? DOWNLOAD_POLL_MS : IDLE_DOWNLOAD_POLL_MS;
  });

  if (!status) return null;
  return (
    <div className="space-y-2 rounded-lg border p-3 text-sm">
      <div className="flex items-center justify-between gap-2">
        <span className="font-medium">Models on the pod</span>
        {status.disk && (
          <span className="text-xs text-muted-foreground">
            {status.disk.free_gb} GB free of {status.disk.total_gb} GB
          </span>
        )}
      </div>
      {status.jobs.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          No downloads yet. Custom checkpoints and LoRAs from the provisioning manifest show up here
          as they arrive.
        </p>
      ) : (
        <ul className="space-y-1.5">
          {status.jobs.map((job) => {
            const percent =
              job.expected_bytes && job.expected_bytes > 0
                ? Math.min(100, Math.round((job.bytes / job.expected_bytes) * 100))
                : null;
            return (
              <li key={`${job.dir}/${job.filename}`} className="space-y-1">
                <div className="flex items-center justify-between gap-2 text-xs">
                  <span className="truncate" title={`${job.dir}/${job.filename}`}>
                    {job.filename}
                  </span>
                  <span
                    className={cn(
                      "shrink-0 tabular-nums",
                      job.status === "error" ? "text-destructive" : "text-muted-foreground",
                    )}
                  >
                    {job.status === "done"
                      ? "ready"
                      : job.status === "error"
                        ? "failed"
                        : percent !== null
                          ? `${percent}%`
                          : gb(job.bytes)}
                  </span>
                </div>
                {job.status === "downloading" && (
                  <div className="h-1 overflow-hidden rounded-full bg-muted">
                    <div
                      className="h-full rounded-full bg-primary transition-all"
                      style={{ width: `${percent ?? 5}%` }}
                    />
                  </div>
                )}
                {job.error && <p className="text-[11px] text-destructive">{job.error}</p>}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

/** Short name for a pod in lists and the "Run on" picker. */
export function videoPodLabel(pod: { gpuName: string; numGpus: number; podId?: string }): string {
  const gpu = pod.gpuName.replace(/^NVIDIA\s+/, "");
  return `${pod.numGpus > 1 ? `${pod.numGpus}× ` : ""}${gpu}${pod.podId ? ` · ${pod.podId.slice(0, 5)}` : ""}`;
}

/**
 * The video pods' chip in the tab header, and the dialog that runs them.
 * Several pods may run side by side (say an RTX PRO 6000 for H3 and a B200 for
 * LTX); each gets its own card, and one more can be rented below them.
 */
export function VideoPodStatus() {
  const pods = useQuery(api.runpodBackendStore.videoPods, {});
  const [open, setOpen] = React.useState(false);
  const [adding, setAdding] = React.useState(false);

  const list = pods ?? [];
  const isBooting = (pod: (typeof list)[number]) =>
    pod.state === "reserving" || pod.state === "loading" || pod.state === "provisioning";
  const readyPods = list.filter((pod) => pod.state === "ready");
  const bootingPod = list.find(isBooting);
  const degraded = readyPods.some((pod) => /with warnings/i.test(pod.message ?? ""));
  const progress = bootingPod ? Math.min(100, Math.max(0, bootingPod.progress)) : null;
  const label =
    pods === undefined
      ? "Video pod"
      : list.length === 0
        ? "Start video pod"
        : list.length === 1
          ? degraded
            ? "Video pod has problems"
            : readyPods.length === 1
              ? `Video pod ready · ${videoPodLabel(list[0]).split(" · ")[0]}`
              : `Video pod · ${list[0].state}`
          : `${list.length} video pods · ${readyPods.length} ready`;

  return (
    <>
      <Button
        variant="outline"
        className={cn("gap-2", progress !== null && "relative overflow-hidden")}
        title={bootingPod?.message}
        onClick={() => setOpen(true)}
      >
        {progress !== null && (
          <span
            aria-hidden
            className="pointer-events-none absolute inset-y-0 left-0 bg-gradient-to-r from-primary/5 to-primary/25 transition-[width] duration-700 ease-out"
            style={{ width: `${progress}%` }}
          />
        )}
        <span
          className={cn(
            "relative h-2 w-2 rounded-full",
            bootingPod
              ? "bg-amber-400 animate-pulse"
              : degraded
                ? "bg-amber-500"
                : readyPods.length > 0
                  ? "bg-green-500"
                  : pods === undefined
                    ? "bg-gray-400"
                    : "bg-red-500",
          )}
        />
        <span className="relative text-sm font-medium">{label}</span>
        {progress !== null && (
          <span className="relative rounded bg-primary/30 px-1.5 py-px font-mono text-xs font-semibold tabular-nums">
            {Math.round(progress)}%
          </span>
        )}
        {pods === undefined ? (
          <Loader2 className="relative h-3 w-3 animate-spin" />
        ) : (
          <Settings2 className="relative h-3 w-3" />
        )}
      </Button>
      <Dialog
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (!next) setAdding(false);
        }}
      >
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-3xl">
          <DialogHeader>
            <DialogTitle>Video pods (MiniMax H3 · LTX 2.3)</DialogTitle>
            <DialogDescription>
              RunPod pods for video. Each boots the H3 base models in a few minutes; LTX 2.3 and
              your checkpoints and LoRAs from the provisioning manifest follow right after. Several
              can run at once — pick one per clip in the form, or let Auto send each clip to the
              least busy pod that has its models. Each bills by the hour until you stop or destroy
              it.
            </DialogDescription>
          </DialogHeader>
          {list.length === 0 && <RunpodBackendPanel open={open} purpose="video" launchOnly />}
          {list.map((pod) => (
            <div key={pod._id} className="space-y-3 rounded-lg border p-3">
              <p className="text-xs font-medium text-muted-foreground">{videoPodLabel(pod)}</p>
              {/with warnings/i.test(pod.message ?? "") && pod.state === "ready" && (
                <div className="rounded-md border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-600 dark:text-amber-400">
                  {pod.message} Generations on this pod will likely fail; destroying it and renting
                  a new one usually fixes it.
                </div>
              )}
              <RunpodBackendPanel open={open} purpose="video" backendId={pod._id} />
              {pod.state === "ready" && <VideoPodDownloads active={open} backendId={pod._id} />}
            </div>
          ))}
          {list.length > 0 &&
            list.length < 4 &&
            (adding ? (
              <div className="space-y-2 rounded-lg border border-dashed p-3">
                <p className="text-xs font-medium">Another video pod</p>
                <RunpodBackendPanel open={open} purpose="video" launchOnly />
              </div>
            ) : (
              <Button variant="outline" className="w-full gap-1" onClick={() => setAdding(true)}>
                <Plus className="h-4 w-4" /> Rent another video pod
              </Button>
            ))}
          {readyPods.length > 0 && (
            <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <Download className="h-3 w-3" /> New models appear in the tab’s lists as soon as they
              finish.
            </p>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
