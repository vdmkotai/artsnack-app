"use client";

import { ConvexError } from "convex/values";
import { useAction, useMutation, useQuery } from "convex/react";
import {
  AlertTriangle,
  CheckCircle2,
  HardDrive,
  Loader2,
  Power,
  RefreshCw,
  Trash2,
} from "lucide-react";
import { useEffect, useEffectEvent, useMemo, useRef, useState } from "react";

import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { PodLaunchDialog } from "@/components/pod-launch-dialog";
import {
  DEFAULT_RUNPOD_CONTAINER_DISK_GB,
  DEFAULT_RUNPOD_MAX_HOURLY_USD,
  MAX_RUNPOD_CONTAINER_DISK_GB,
  MAX_RUNPOD_VOLUME_DISK_GB,
  MIN_RUNPOD_CONTAINER_DISK_GB,
  RUNPOD_GPU_COUNTS,
  type RunpodCloudType,
  type RunpodGpuType,
  type RunpodTemplateProfile,
} from "@/lib/runpod-backend";

/**
 * How often a pod's provider status is re-read: every few seconds while it is
 * changing (booting, starting, being destroyed), about once a minute while it
 * is not. A ready or stopped pod changes only when someone acts on it, and this
 * dialog's own buttons write their result without waiting for a poll.
 */
export const FAST_POLL_MS = 5_000;
export const SLOW_POLL_MS = 60_000;

/** States in which a pod is on its way somewhere and worth checking often.
 *  Start puts a stopped pod back into "loading", so it is covered. Stage is
 *  deliberately not consulted: a stopped row can keep the "starting" stage. */
export function podIsChanging(row: { state: string }): boolean {
  return (
    row.state === "reserving" ||
    row.state === "loading" ||
    row.state === "provisioning" ||
    row.state === "destroying"
  );
}

const pageHidden = () => typeof document !== "undefined" && document.hidden;

/** One poll: do the request, set state only if `isCurrent()` still holds, and
 *  answer how long to wait before the next one. */
export type PollRun = (isCurrent: () => boolean) => Promise<number>;

/**
 * The loop behind usePolling. Module-level so the React Compiler never has to
 * lower it, and so its bookkeeping is plain variables rather than state.
 *
 * - Self-scheduling: the next wait starts when an answer arrives, so a slow
 *   provider cannot stack requests.
 * - `inFlight` outlives the loop: a loop started while the previous one's
 *   request is still out waits for it instead of sending a second alongside.
 * - Hidden page: no timer runs. On return the remaining wait is resumed, or the
 *   poll fires at once if the wait ran out while the page was hidden.
 */
function startPolling(inFlight: { current: Promise<void> | null }, run: PollRun): () => void {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let dueAt = 0;
  const isCurrent = () => !stopped;
  const clear = () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
  };
  const tick = (): void => {
    timer = undefined;
    if (stopped || pageHidden()) return;
    const previous = inFlight.current;
    if (previous) {
      void previous.then(() => {
        if (!stopped && timer === undefined && inFlight.current === null) tick();
      });
      return;
    }
    let delay = FAST_POLL_MS;
    const request = new Promise<number>((resolve) => resolve(run(isCurrent)))
      .then(
        (next) => {
          delay = next;
        },
        () => undefined,
      )
      .then(() => {
        inFlight.current = null;
        if (stopped) return;
        dueAt = Date.now() + delay;
        if (!pageHidden()) timer = setTimeout(tick, delay);
      });
    inFlight.current = request;
  };
  const onVisibilityChange = () => {
    if (pageHidden()) return clear();
    if (stopped || timer !== undefined || inFlight.current !== null) return;
    const wait = dueAt - Date.now();
    if (wait <= 0) tick();
    else timer = setTimeout(tick, wait);
  };
  if (typeof document !== "undefined") {
    document.addEventListener("visibilitychange", onVisibilityChange);
  }
  tick();
  return () => {
    stopped = true;
    clear();
    if (typeof document !== "undefined") {
      document.removeEventListener("visibilitychange", onVisibilityChange);
    }
  };
}

/**
 * Poll while `key` is non-null: at once, then after whatever delay each run
 * returns. A new key restarts the loop (and polls at once); `run` itself may
 * change every render without restarting anything.
 */
export function usePolling(key: string | null, run: PollRun): void {
  const poll = useEffectEvent(run);
  const inFlight = useRef<Promise<void> | null>(null);
  useEffect(() => {
    if (key === null) return;
    return startPolling(inFlight, (isCurrent) => poll(isCurrent));
  }, [key]);
}

function errorMessage(error: unknown): string {
  return error instanceof ConvexError
    ? String(error.data)
    : error instanceof Error
      ? error.message
      : "The request failed";
}

function usd(value: number): string {
  return `$${value.toFixed(value < 1 ? 3 : 2)}`;
}

function availability(gpu: RunpodGpuType, cloud: RunpodCloudType) {
  return cloud === "SECURE" ? gpu.secure : gpu.community;
}

function offered(gpu: RunpodGpuType, cloud: RunpodCloudType): boolean {
  return (availability(gpu, cloud).hourlyUsd ?? 0) > 0;
}

/** RunPod lists every GPU type, including ones no host is selling right now
 *  (no price, UNKNOWN stock) — those can be shown but not rented. */
function rentable(gpu: RunpodGpuType): boolean {
  return offered(gpu, "SECURE") || offered(gpu, "COMMUNITY");
}

function gpuDescription(gpu: RunpodGpuType): string {
  const parts = [`${gpu.memoryInGb} GB VRAM`];
  if (gpu.cudaCores > 0) parts.push(`${gpu.cudaCores.toLocaleString()} CUDA cores`);
  if (offered(gpu, "SECURE")) {
    parts.push(
      `Secure from ${usd(gpu.secure.hourlyUsd ?? 0)}/hr · ${gpu.secure.availableGpuCounts.map((count) => `${count}×`).join(", ")} · ${gpu.secure.stockStatus} stock`,
    );
  }
  if (offered(gpu, "COMMUNITY")) {
    parts.push(
      `Community from ${usd(gpu.community.hourlyUsd ?? 0)}/hr · ${gpu.community.availableGpuCounts.map((count) => `${count}×`).join(", ")} · ${gpu.community.stockStatus} stock`,
    );
  }
  if (!rentable(gpu)) parts.push("not available right now");
  return parts.join(" · ");
}

/** GPUs the video pod is offered first, best first — measured 2026-10-12: the
 *  RTX PRO 6000 renders a warm 5 s 768p H3 clip in 56 s against the H100's
 *  71 s, at $2.49/h against $3.99/h. */
const VIDEO_GPU_PREFERENCE = [
  "NVIDIA RTX PRO 6000 Blackwell Server Edition",
  "NVIDIA RTX PRO 6000 Blackwell Workstation Edition",
  "NVIDIA H100 80GB HBM3",
];

/** Keep the chosen GPU if the fresh catalogue still lists it. Otherwise the
 *  preferred one, but only when it can actually be rented: the catalogue lists
 *  out-of-stock types with a zero price, and defaulting to one of those turns
 *  the first Launch click into "no capacity". */
function defaultGpuId(types: RunpodGpuType[], current: string, video: boolean): string {
  if (types.some((gpu) => gpu.id === current)) return current;
  const preferred = video ? VIDEO_GPU_PREFERENCE : ["NVIDIA H100 80GB HBM3"];
  for (const id of preferred) {
    const gpu = types.find((candidate) => candidate.id === id);
    if (gpu && rentable(gpu)) return id;
  }
  return types[0]?.id ?? "";
}

/**
 * Launch and manage one managed RunPod pod. `purpose="video"` is the MiniMax
 * H3 pod of the Self-hosted video tab: same lifecycle, but it boots the video
 * provisioning profile, always on the CUDA 13.0 image, and never competes for
 * the image tab's "use for new generations" switch.
 */
export function RunpodBackendPanel({
  open,
  purpose = "image",
  backendId,
  launchOnly = false,
}: {
  open: boolean;
  purpose?: "image" | "video";
  /** Manage this pod (video pods can run side by side). */
  backendId?: Id<"runpodBackends">;
  /** Show only the rent form, for another video pod next to running ones. */
  launchOnly?: boolean;
}) {
  const video = purpose === "video";
  const current = useQuery(
    api.runpodBackendStore.current,
    backendId || launchOnly ? "skip" : { purpose },
  );
  const byId = useQuery(api.runpodBackendStore.byId, backendId ? { id: backendId } : "skip");
  const backend = launchOnly ? null : backendId ? byId : current;
  const selection = useQuery(api.selfHostedSelection.current);
  const listGpuTypes = useAction(api.runpodBackendActions.gpuTypes);
  const getBalance = useAction(api.runpodBackendActions.accountBalance);
  const launch = useAction(api.runpodBackendActions.launch);
  const refresh = useAction(api.runpodBackendActions.refresh);
  const start = useAction(api.runpodBackendActions.start);
  const stop = useAction(api.runpodBackendActions.stop);
  const destroy = useAction(api.runpodBackendActions.destroy);
  const selectProvider = useMutation(api.selfHostedSelection.set);

  const [gpus, setGpus] = useState<RunpodGpuType[]>([]);
  const [balance, setBalance] = useState<number | null>(null);
  const [gpuTypeId, setGpuTypeId] = useState("");
  const [gpuCount, setGpuCount] = useState(1);
  const [cloudType, setCloudType] = useState<RunpodCloudType>("SECURE");
  const [templateProfile, setTemplateProfile] = useState<RunpodTemplateProfile>("cuda13.0");
  const [containerDiskGb, setContainerDiskGb] = useState(
    // The video pod holds H3 and LTX 2.3 side by side: two base sets, the
    // community checkpoints (20–30 GB each) and their LoRAs.
    video ? 500 : DEFAULT_RUNPOD_CONTAINER_DISK_GB,
  );
  const [volumeDiskGb, setVolumeDiskGb] = useState(0);
  const [minDiskBandwidthMBps, setMinDiskBandwidthMBps] = useState(1_000);
  const [minDownloadMbps, setMinDownloadMbps] = useState(500);
  const [maxHourlyUsd, setMaxHourlyUsd] = useState(DEFAULT_RUNPOD_MAX_HOURLY_USD);
  const [confirmLaunch, setConfirmLaunch] = useState(false);
  const [confirmDestroy, setConfirmDestroy] = useState(false);
  // Busy is scoped per kind of action: a slow Refresh or Stop must not lock
  // the buttons it has nothing to do with. Start / Stop / Destroy exclude one
  // another; the launch form's catalogue load and launch exclude one another.
  const [formBusy, setFormBusy] = useState<"catalog" | "launch" | null>(null);
  const [lifecycle, setLifecycle] = useState<"start" | "stop" | "destroy" | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [selecting, setSelecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refreshError, setRefreshError] = useState<string | null>(null);

  const loadCatalog = () => {
    setFormBusy("catalog");
    setError(null);
    return Promise.all([listGpuTypes(), getBalance().catch(() => null)])
      .then(([types, credit]) => {
        setGpus(types);
        setBalance(credit);
        setGpuTypeId((current) => defaultGpuId(types, current, video));
      })
      .catch((cause: unknown) => {
        setError(errorMessage(cause));
        setGpus([]);
      })
      .finally(() => setFormBusy(null));
  };

  const noBackend = backend === null;
  const loadCatalogOnOpen = useEffectEvent(() => void loadCatalog());
  useEffect(() => {
    if (open && noBackend) loadCatalogOnOpen();
  }, [noBackend, open]);

  // The state is part of the key, so every transition re-reads RunPod at once
  // and then settles into the pace that state calls for.
  const pollKey =
    open && backend?.active && backend.podId && backend.state !== "destroyed"
      ? `${backend._id}:${backend.podId}:${backend.state}`
      : null;
  useEffect(() => {
    if (pollKey === null) setRefreshError(null);
  }, [pollKey]);
  usePolling(pollKey, async (isCurrent) => {
    if (!backend) return SLOW_POLL_MS;
    const delay = podIsChanging(backend) ? FAST_POLL_MS : SLOW_POLL_MS;
    const failure = await refresh({ id: backend._id }).then(
      () => null,
      (cause: unknown) => `RunPod status refresh failed: ${errorMessage(cause)}`,
    );
    if (isCurrent()) setRefreshError(failure);
    return delay;
  });

  const selectedGpu = useMemo(
    () => gpus.find((gpu) => gpu.id === gpuTypeId) ?? null,
    [gpuTypeId, gpus],
  );
  // A GPU is often offered in only one cloud — RunPod lists the other with no
  // price and UNKNOWN stock, which rendered as a $0.000/hr card that cannot be
  // rented. Follow the GPU to the cloud that actually sells it.
  useEffect(() => {
    if (!selectedGpu || offered(selectedGpu, cloudType)) return;
    const other: RunpodCloudType = cloudType === "SECURE" ? "COMMUNITY" : "SECURE";
    if (offered(selectedGpu, other)) setCloudType(other);
  }, [cloudType, selectedGpu]);
  const selectedAvailability = selectedGpu ? availability(selectedGpu, cloudType) : null;
  const hourlyUsd =
    selectedAvailability?.totalHourlyUsdByGpuCount.find((price) => price.gpuCount === gpuCount)
      ?.hourlyUsd ?? (selectedAvailability?.hourlyUsd ?? 0) * gpuCount;
  const availableCounts = selectedAvailability?.availableGpuCounts ?? [];
  const gpuOptions = useMemo(
    () =>
      // Rentable first; the rest stay listed (stock changes by the minute) but
      // sink to the bottom and say why they cannot be rented.
      [...gpus.filter(rentable), ...gpus.filter((gpu) => !rentable(gpu))].map((gpu) => ({
        label: gpu.displayName,
        value: gpu.id,
        description: gpuDescription(gpu),
      })),
    [gpus],
  );

  const numeric =
    (setter: (value: number) => void) => (event: React.ChangeEvent<HTMLInputElement>) =>
      setter(Number(event.target.value) || 0);

  const launchSelected = (skipModels: string[]) => {
    if (!selectedGpu || selectedAvailability?.hourlyUsd == null) return;
    setFormBusy("launch");
    setError(null);
    void launch({
      gpuTypeId: selectedGpu.id,
      gpuName: selectedGpu.displayName,
      gpuCount,
      cloudType,
      templateProfile,
      containerDiskGb,
      volumeDiskGb,
      minDiskBandwidthMBps,
      minDownloadMbps,
      displayedHourlyUsd: hourlyUsd,
      maxHourlyUsd,
      purpose,
      skipModels,
    })
      .then(() => setConfirmLaunch(false))
      .catch(async (cause: unknown) => {
        const message = errorMessage(cause);
        await loadCatalog();
        setError(message);
      })
      .finally(() => setFormBusy(null));
  };

  const control = (kind: "start" | "stop" | "destroy") => {
    if (!backend) return;
    const id = backend._id;
    setLifecycle(kind);
    setError(null);
    const request =
      kind === "start" ? start({ id }) : kind === "stop" ? stop({ id }) : destroy({ id });
    void request
      .then(() => setConfirmDestroy(false))
      .catch((cause: unknown) => setError(errorMessage(cause)))
      .finally(() => setLifecycle(null));
  };

  const makeDefault = () => {
    setSelecting(true);
    setError(null);
    void selectProvider({ provider: "runpod" })
      .catch((cause: unknown) => setError(errorMessage(cause)))
      .finally(() => setSelecting(false));
  };

  const refreshBackend = () => {
    if (!backend) return;
    setRefreshing(true);
    setError(null);
    setRefreshError(null);
    void refresh({ id: backend._id })
      .catch((cause: unknown) =>
        setRefreshError(`RunPod status refresh failed: ${errorMessage(cause)}`),
      )
      .finally(() => setRefreshing(false));
  };

  const visibleError = error ?? refreshError;

  if (backend === undefined) {
    return (
      <div className="flex items-center justify-center gap-2 p-12 text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading RunPod state…
      </div>
    );
  }

  if (backend) {
    const selected = !video && selection?.provider === "runpod";
    return (
      <div className="space-y-4">
        {visibleError && (
          <div className="rounded-md border border-destructive/30 bg-destructive/10 p-3 text-destructive">
            {visibleError}
          </div>
        )}
        <Card>
          <CardHeader className="grid-cols-[1fr_auto]">
            <div>
              <CardTitle>
                {backend.numGpus}× {backend.gpuName}
              </CardTitle>
              <p className="text-muted-foreground">
                RunPod #{backend.podId ?? "…"}
                {video && backend.numGpus > 1 && backend.state === "ready" && (
                  <>
                    {" "}
                    · {backend.instanceUrls?.length ?? 1} of {backend.numGpus} GPUs rendering — up
                    to {backend.instanceUrls?.length ?? 1} clips at once
                  </>
                )}
              </p>
            </div>
            <Badge variant={backend.state === "ready" ? "default" : "secondary"}>
              {backend.state}
            </Badge>
          </CardHeader>
          <CardContent className="space-y-4">
            <div>
              <div className="mb-1 flex items-center justify-between gap-3">
                <span>{backend.message}</span>
                <span className="font-mono">{Math.round(backend.progress)}%</span>
              </div>
              <div className="h-2 overflow-hidden rounded-full bg-muted">
                <div
                  className="h-full rounded-full bg-primary transition-all"
                  style={{ width: `${Math.max(2, backend.progress)}%` }}
                />
              </div>
            </div>
            <div className="grid gap-2 text-muted-foreground sm:grid-cols-2 lg:grid-cols-4">
              <span>{usd(backend.hourlyUsd)}/hr while running</span>
              <span>{backend.containerDiskGb} GB container disk</span>
              <span>{backend.volumeDiskGb} GB persistent volume</span>
              <span>{backend.templateProfile}</span>
            </div>
            {backend.state === "stopped" && (
              <div className="flex gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 p-3 text-amber-700 dark:text-amber-300">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                The container disk was wiped when this pod stopped. A configured volume remains and
                can continue billing until the pod is destroyed.
              </div>
            )}
            <div className="flex flex-wrap gap-2">
              {!video && backend.state === "ready" && !selected && (
                <Button disabled={selecting} onClick={makeDefault}>
                  {selecting ? <Loader2 className="animate-spin" /> : <CheckCircle2 />}
                  Use for new generations
                </Button>
              )}
              {backend.state === "ready" && selected && <Badge>Selected for generations</Badge>}
              {backend.state === "stopped" ? (
                <Button disabled={lifecycle !== null} onClick={() => control("start")}>
                  {lifecycle === "start" ? <Loader2 className="animate-spin" /> : <Power />} Start
                </Button>
              ) : (
                <Button
                  variant="outline"
                  disabled={lifecycle !== null || backend.state === "reserving"}
                  onClick={() => control("stop")}
                >
                  {lifecycle === "stop" ? <Loader2 className="animate-spin" /> : <Power />} Stop GPU
                </Button>
              )}
              <Button
                variant="outline"
                disabled={refreshing || !backend.podId}
                onClick={refreshBackend}
              >
                <RefreshCw className={refreshing ? "animate-spin" : ""} /> Refresh
              </Button>
              <Button
                variant="destructive"
                disabled={lifecycle !== null || !backend.podId}
                onClick={() => setConfirmDestroy(true)}
              >
                <Trash2 /> Destroy and stop billing
              </Button>
            </div>
          </CardContent>
        </Card>

        {confirmDestroy && (
          <div className="rounded-md border border-destructive/30 bg-destructive/10 p-4">
            <p className="font-medium">Permanently destroy this RunPod?</p>
            <p className="mt-1 text-muted-foreground">
              This deletes its {backend.containerDiskGb} GB container disk and any configured
              volume, then stops all billing.
            </p>
            <div className="mt-3 flex gap-2">
              <Button
                variant="destructive"
                disabled={lifecycle !== null}
                onClick={() => control("destroy")}
              >
                {lifecycle === "destroy" && <Loader2 className="animate-spin" />} Destroy
                permanently
              </Button>
              <Button variant="outline" onClick={() => setConfirmDestroy(false)}>
                Cancel
              </Button>
            </div>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {visibleError && (
        <div className="rounded-md border border-destructive/30 bg-destructive/10 p-3 text-destructive">
          {visibleError}
        </div>
      )}
      <div className="grid gap-3 rounded-lg border bg-muted/20 p-4 sm:grid-cols-2 lg:grid-cols-4">
        <div className="space-y-1.5 sm:col-span-2">
          <Label>GPU model</Label>
          <SearchableSelect
            options={gpuOptions}
            value={gpuTypeId}
            onValueChange={setGpuTypeId}
            placeholder={formBusy === "catalog" ? "Loading current GPUs…" : "Choose a GPU"}
          />
        </div>
        <div className="space-y-1.5">
          <Label>Cloud</Label>
          <div className="flex gap-1">
            {(["SECURE", "COMMUNITY"] as RunpodCloudType[]).map((value) => (
              <Button
                key={value}
                size="sm"
                variant={cloudType === value ? "default" : "outline"}
                disabled={selectedGpu !== null && !offered(selectedGpu, value)}
                title={
                  selectedGpu !== null && !offered(selectedGpu, value)
                    ? `No ${selectedGpu.displayName} for rent in this cloud right now`
                    : value === "SECURE"
                      ? "RunPod's own Tier 3/4 datacenters: steadier, a bit pricier"
                      : "Vetted third-party hosts: cheaper, more variable"
                }
                onClick={() => setCloudType(value)}
              >
                {value === "SECURE" ? "Secure" : "Community"}
              </Button>
            ))}
          </div>
          {selectedGpu && !rentable(selectedGpu) && (
            <p className="text-xs text-destructive">
              RunPod has no free {selectedGpu.displayName} in either cloud right now — pick another
              GPU or refresh later.
            </p>
          )}
        </div>
        <div className="space-y-1.5">
          <Label>{video ? "Clips at once" : "Number of GPUs"}</Label>
          <div className="flex gap-1">
            {RUNPOD_GPU_COUNTS.map((count) => (
              <Button
                key={count}
                size="sm"
                variant={gpuCount === count ? "default" : "outline"}
                disabled={availableCounts.length > 0 && !availableCounts.includes(count)}
                title={video ? `${count} GPU${count > 1 ? "s" : ""}, one clip each` : undefined}
                onClick={() => setGpuCount(count)}
              >
                {count}×
              </Button>
            ))}
          </div>
          {video && (
            <p className="text-xs text-muted-foreground">
              One GPU per clip:{" "}
              {gpuCount > 1
                ? `${gpuCount} clips render side by side`
                : "clips render one after another"}
              {hourlyUsd > 0 && ` · ${usd(hourlyUsd)}/hr in total`}. A single clip is not faster.
            </p>
          )}
        </div>
        <div className="space-y-1.5" hidden={video}>
          <Label>ComfyUI image</Label>
          <div className="flex gap-1">
            {(["cuda13.0", "cuda12.8"] as RunpodTemplateProfile[]).map((profile) => (
              <Button
                key={profile}
                size="sm"
                variant={templateProfile === profile ? "default" : "outline"}
                onClick={() => setTemplateProfile(profile)}
              >
                CUDA {profile.slice(4)}
              </Button>
            ))}
          </div>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="runpod-container-disk">Disposable container disk (GB)</Label>
          <Input
            id="runpod-container-disk"
            type="number"
            min={MIN_RUNPOD_CONTAINER_DISK_GB}
            max={MAX_RUNPOD_CONTAINER_DISK_GB}
            value={containerDiskGb}
            onChange={numeric(setContainerDiskGb)}
          />
          <p className="text-[10px] text-muted-foreground">
            Fast local disk; stop or destroy wipes it.
          </p>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="runpod-volume-disk">Persistent volume disk (GB)</Label>
          <Input
            id="runpod-volume-disk"
            type="number"
            min={0}
            max={MAX_RUNPOD_VOLUME_DISK_GB}
            value={volumeDiskGb}
            onChange={numeric(setVolumeDiskGb)}
          />
          <p className="text-[10px] text-muted-foreground">
            0 means no volume, matching your current workflow.
          </p>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="runpod-disk-speed">Minimum disk speed (MB/s)</Label>
          <Input
            id="runpod-disk-speed"
            type="number"
            min={0}
            value={minDiskBandwidthMBps}
            onChange={numeric(setMinDiskBandwidthMBps)}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="runpod-download">Minimum download (Mbps)</Label>
          <Input
            id="runpod-download"
            type="number"
            min={0}
            value={minDownloadMbps}
            onChange={numeric(setMinDownloadMbps)}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="runpod-max-price">Maximum total GPU price ($/hr)</Label>
          <Input
            id="runpod-max-price"
            type="number"
            min={0}
            max={DEFAULT_RUNPOD_MAX_HOURLY_USD}
            step={0.1}
            value={maxHourlyUsd}
            onChange={numeric(setMaxHourlyUsd)}
          />
          <p className="text-[10px] text-muted-foreground">
            Server safety cap: {usd(DEFAULT_RUNPOD_MAX_HOURLY_USD)}/hr.
          </p>
        </div>
        <div className="flex items-end sm:col-span-3">
          <Button
            className="w-full"
            variant="outline"
            disabled={formBusy !== null}
            onClick={() => void loadCatalog()}
          >
            <RefreshCw className={formBusy === "catalog" ? "animate-spin" : ""} /> Refresh current
            availability and prices
          </Button>
        </div>
      </div>

      {selectedGpu && selectedAvailability && (
        <Card>
          <CardHeader className="grid-cols-[1fr_auto]">
            <div>
              <CardTitle>{selectedGpu.displayName}</CardTitle>
              <div className="mt-1 flex flex-wrap gap-1.5">
                <Badge variant="outline">{selectedGpu.memoryInGb} GB VRAM</Badge>
                <Badge variant="outline">{selectedAvailability.stockStatus} stock</Badge>
                <Badge variant="secondary">{cloudType === "SECURE" ? "Secure" : "Community"}</Badge>
              </div>
            </div>
            <div className="text-right">
              {!offered(selectedGpu, cloudType) ? (
                <span className="text-destructive">Unavailable</span>
              ) : (
                <>
                  <div className="text-base font-semibold">{usd(hourlyUsd)}/hr</div>
                  <div className="text-[10px] text-muted-foreground">
                    {usd(hourlyUsd / gpuCount)}/GPU/hr; disk adjustments shown by RunPod after
                    placement
                  </div>
                </>
              )}
            </div>
          </CardHeader>
          <CardContent className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-2 text-muted-foreground">
              <HardDrive className="h-4 w-4" /> {containerDiskGb} GB disposable + {volumeDiskGb} GB
              persistent
            </div>
            <Button
              disabled={
                formBusy !== null ||
                selectedAvailability.hourlyUsd === null ||
                hourlyUsd <= 0 ||
                hourlyUsd > maxHourlyUsd ||
                (availableCounts.length > 0 && !availableCounts.includes(gpuCount))
              }
              onClick={() => {
                setError(null);
                setConfirmLaunch(true);
              }}
            >
              Rent
            </Button>
          </CardContent>
        </Card>
      )}

      <div className="flex items-center justify-between text-[10px] text-muted-foreground">
        <span>
          {gpus.length} GPU types · prices are live starting prices and rechecked before launch
        </span>
        {balance !== null && <span>RunPod credit: {usd(balance)}</span>}
      </div>

      {selectedGpu && (
        <PodLaunchDialog
          open={confirmLaunch}
          onOpenChange={setConfirmLaunch}
          profile={purpose}
          title={video ? "Confirm paid video pod rental" : "Confirm paid RunPod rental"}
          busy={formBusy !== null}
          error={error}
          onLaunch={launchSelected}
        >
          Launch {gpuCount}× {selectedGpu.displayName} in {cloudType.toLowerCase()} cloud with CUDA{" "}
          {templateProfile.slice(4)}, {containerDiskGb} GB disposable container disk, and{" "}
          {volumeDiskGb} GB persistent volume. Current GPU starting price is {usd(hourlyUsd)}/hr;
          Convex rejects a price change over 10% or the server cap before creating the pod.
        </PodLaunchDialog>
      )}
    </div>
  );
}
