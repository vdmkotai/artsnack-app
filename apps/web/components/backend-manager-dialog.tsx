"use client";

import { ConvexError } from "convex/values";
import { useAction, useMutation, useQuery } from "convex/react";
import {
  AlertTriangle,
  CheckCircle2,
  Cpu,
  HardDrive,
  Loader2,
  MapPin,
  Network,
  Power,
  RefreshCw,
  Search,
  ShieldCheck,
  Trash2,
  Zap,
} from "lucide-react";
import { useEffect, useEffectEvent, useMemo, useRef, useState } from "react";

import { api } from "@/convex/_generated/api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { PodLaunchDialog } from "@/components/pod-launch-dialog";
import {
  FAST_POLL_MS,
  podIsChanging,
  RunpodBackendPanel,
  SLOW_POLL_MS,
  usePolling,
} from "@/components/runpod-backend-panel";
import {
  clampVastDiskGb,
  DEFAULT_MAX_HOURLY_USD,
  DEFAULT_MIN_VAST_DISK_BANDWIDTH_MBPS,
  DEFAULT_VAST_DISK_GB,
  MAX_VAST_DISK_GB,
  MIN_VAST_DISK_GB,
  type VastGpuType,
  type VastOffer,
  type VastOfferSort,
} from "@/lib/vast-backend";

const ANY_GPU = "__any__";
/** After this many failed status reads in a row, say so and back off. */
const MAX_MISSED_POLLS = 5;
const MISSED_POLL_BACKOFF_MS = 30_000;

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

function mb(value: number): string {
  return `${Math.round(value).toLocaleString()} MB/s`;
}

function gpuDescription(gpu: VastGpuType): string {
  const parts: string[] = [];
  if (gpu.category) {
    parts.push(gpu.category.charAt(0).toUpperCase() + gpu.category.slice(1));
  }
  if (gpu.gpuRamMb > 0) parts.push(`${Math.round(gpu.gpuRamMb / 1024)} GB VRAM`);
  if (gpu.computeCapability > 0) {
    parts.push(`Compute capability ${gpu.computeCapability.toFixed(1)}`);
  }
  if (gpu.cudaCores > 0) parts.push(`${gpu.cudaCores.toLocaleString()} CUDA cores`);
  if (gpu.maxPowerWatts) parts.push(`${gpu.maxPowerWatts} W`);
  return parts.join(" · ");
}

function OfferCard({
  offer,
  diskGb,
  busy,
  onChoose,
}: {
  offer: VastOffer;
  diskGb: number;
  busy: boolean;
  onChoose: (offer: VastOffer) => void;
}) {
  return (
    <Card className={offer.compatible ? "" : "opacity-60"}>
      <CardHeader className="grid-cols-[1fr_auto]">
        <div>
          <CardTitle>
            {offer.numGpus}× {offer.gpuName}
          </CardTitle>
          <div className="mt-1 flex flex-wrap gap-1.5">
            <Badge variant="outline">{Math.round(offer.gpuRamMb / 1024)} GB VRAM</Badge>
            <Badge variant={offer.compatible ? "secondary" : "destructive"}>
              CUDA {offer.cudaMax || "?"}
            </Badge>
            <Badge variant="outline">{(offer.reliability * 100).toFixed(1)}% reliable</Badge>
          </div>
        </div>
        <div className="text-right">
          <div className="text-base font-semibold">{usd(offer.hourlyUsd)}/hr</div>
          <div className="text-[10px] text-muted-foreground">
            including {diskGb} GB disk; traffic separate
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="grid grid-cols-2 gap-x-4 gap-y-2 text-muted-foreground sm:grid-cols-4">
          <span className="flex items-center gap-1.5" title={offer.diskName}>
            <HardDrive className="h-3.5 w-3.5 shrink-0" /> {mb(offer.diskBandwidthMbps)}
          </span>
          <span className="flex items-center gap-1.5">
            <Network className="h-3.5 w-3.5 shrink-0" /> ↓ {Math.round(offer.downloadMbps)} · ↑{" "}
            {Math.round(offer.uploadMbps)} Mbps
          </span>
          <span className="flex items-center gap-1.5">
            <MapPin className="h-3.5 w-3.5 shrink-0" /> {offer.location}
          </span>
          <span className="flex items-center gap-1.5">
            <Zap className="h-3.5 w-3.5 shrink-0" /> {offer.dlperf.toFixed(1)} DLPerf ·{" "}
            {offer.dlperfPerDollar.toFixed(1)}/$
          </span>
        </div>
        {!offer.compatible && <p className="text-destructive">{offer.incompatibilityReason}</p>}
        <div className="flex items-center justify-between gap-3 border-t pt-3">
          <div className="text-[10px] text-muted-foreground">
            <div>
              Disk: {offer.diskName} · {Math.round(offer.diskSpaceGb)} GB available · storage
              portion {usd(offer.storageHourlyUsd)}/hr
            </div>
            <div>
              Bandwidth: ↓ {usd(offer.downloadCostPerTbUsd)}/TB · ↑ {usd(offer.uploadCostPerTbUsd)}
              /TB
            </div>
          </div>
          <Button size="sm" disabled={busy || !offer.compatible} onClick={() => onChoose(offer)}>
            Rent
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

export function BackendManagerDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const backend = useQuery(api.vastBackendStore.current);
  const selection = useQuery(api.selfHostedSelection.current);
  const selectProvider = useMutation(api.selfHostedSelection.set);
  const listOffers = useAction(api.vastBackendActions.offers);
  const listGpuNames = useAction(api.vastBackendActions.gpuNames);
  const listGpuTypes = useAction(api.vastBackendActions.gpuTypes);
  const getAccountCredit = useAction(api.vastBackendActions.accountCredit);
  const launch = useAction(api.vastBackendActions.launch);
  const refresh = useAction(api.vastBackendActions.refresh);
  const start = useAction(api.vastBackendActions.start);
  const stop = useAction(api.vastBackendActions.stop);
  const destroy = useAction(api.vastBackendActions.destroy);
  const clearUncertainLaunch = useAction(api.vastBackendActions.clearUncertainLaunch);

  const [gpuTypes, setGpuTypes] = useState<VastGpuType[]>([]);
  const [accountCredit, setAccountCredit] = useState<number | null>(null);
  const [gpuName, setGpuName] = useState("H100 SXM");
  const [numGpus, setNumGpus] = useState(1);
  const [diskGb, setDiskGb] = useState(DEFAULT_VAST_DISK_GB);
  const [minDiskBandwidth, setMinDiskBandwidth] = useState(DEFAULT_MIN_VAST_DISK_BANDWIDTH_MBPS);
  const [minDownloadMbps, setMinDownloadMbps] = useState(500);
  const [minReliabilityPercent, setMinReliabilityPercent] = useState(98);
  const [maxHourlyUsd, setMaxHourlyUsd] = useState(DEFAULT_MAX_HOURLY_USD);
  const [sort, setSort] = useState<VastOfferSort>("price");
  const [offers, setOffers] = useState<VastOffer[]>([]);
  const [offersDiskGb, setOffersDiskGb] = useState(DEFAULT_VAST_DISK_GB);
  const [selected, setSelected] = useState<VastOffer | null>(null);
  const [confirmDestroy, setConfirmDestroy] = useState(false);
  // Scoped like RunpodBackendPanel's: offers search and launch exclude each
  // other, the lifecycle buttons exclude each other, selecting stands alone.
  const [formBusy, setFormBusy] = useState<"search" | "launch" | null>(null);
  const [lifecycle, setLifecycle] = useState<"start" | "stop" | "destroy" | "clear" | null>(null);
  const [selecting, setSelecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [provider, setProvider] = useState<"vast" | "runpod">("runpod");

  const search = () => {
    setFormBusy("search");
    setError(null);
    setSelected(null);
    const searchedDiskGb = clampVastDiskGb(diskGb);
    void listOffers({
      gpuName: gpuName === ANY_GPU ? undefined : gpuName,
      numGpus,
      diskGb,
      minDiskBandwidth: minDiskBandwidth || undefined,
      minDownloadMbps: minDownloadMbps || undefined,
      minReliability: minReliabilityPercent ? minReliabilityPercent / 100 : undefined,
      maxHourlyUsd: maxHourlyUsd || undefined,
      sort,
    })
      .then((rows) => {
        setOffers(rows);
        setOffersDiskGb(searchedDiskGb);
      })
      .catch((cause: unknown) => {
        setError(errorMessage(cause));
        setOffers([]);
      })
      .finally(() => setFormBusy(null));
  };

  const browsing = open && provider === "vast" && backend === null;

  useEffect(() => {
    if (!browsing) return;
    let cancelled = false;
    void listGpuTypes()
      .catch(async () =>
        (await listGpuNames()).map(
          (name): VastGpuType => ({
            name,
            gpuRamMb: 0,
            computeCapability: 0,
            cudaCores: 0,
            architecture: "",
            category: "",
          }),
        ),
      )
      .then((types) => {
        if (!cancelled) setGpuTypes(types);
      })
      .catch(() => undefined);
    void getAccountCredit()
      .then((credit) => {
        if (!cancelled) setAccountCredit(credit);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [browsing, getAccountCredit, listGpuNames, listGpuTypes]);

  // Search is deliberately one-shot when the offer list comes into view;
  // changing a filter waits for the explicit button so typing a price cannot
  // hammer Vast's API. An effect event reads the current filters without
  // making them dependencies.
  const searchOnOpen = useEffectEvent(search);
  useEffect(() => {
    if (browsing) searchOnOpen();
  }, [browsing]);

  // Every state change re-reads Vast at once (the state is in the key), then
  // polls at the pace the state calls for. Five misses in a row surface an
  // error and back off.
  const pollKey =
    open && provider === "vast" && backend?.active && backend.state !== "destroyed"
      ? `${backend._id}:${backend.state}`
      : null;
  const missedPolls = useRef({ key: "", count: 0 });
  usePolling(pollKey, async (isCurrent) => {
    if (!backend || pollKey === null) return SLOW_POLL_MS;
    const missed = missedPolls.current;
    if (missed.key !== pollKey) {
      missed.key = pollKey;
      missed.count = 0;
    }
    const failure = await refresh({ id: backend._id }).then(
      () => null,
      (cause: unknown) => errorMessage(cause),
    );
    missed.count = failure === null ? 0 : missed.count + 1;
    if (failure !== null && missed.count >= MAX_MISSED_POLLS && isCurrent()) {
      setError(`Vast.ai status could not be refreshed: ${failure}`);
    }
    if (!podIsChanging(backend)) return SLOW_POLL_MS;
    return missed.count >= MAX_MISSED_POLLS ? MISSED_POLL_BACKOFF_MS : FAST_POLL_MS;
  });

  const gpuOptions = useMemo(
    () => [
      { label: "Any GPU", value: ANY_GPU },
      ...gpuTypes.map((gpu) => ({
        label: gpu.name,
        value: gpu.name,
        description: gpuDescription(gpu),
      })),
    ],
    [gpuTypes],
  );

  const rent = (skipModels: string[]) => {
    if (!selected) return;
    setFormBusy("launch");
    setError(null);
    void launch({
      offerId: selected.id,
      diskGb: offersDiskGb,
      displayedHourlyUsd: selected.hourlyUsd,
      skipModels,
    })
      .then(() => setSelected(null))
      .catch((cause: unknown) => setError(errorMessage(cause)))
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

  const numeric =
    (setter: (value: number) => void) => (event: React.ChangeEvent<HTMLInputElement>) =>
      setter(Number(event.target.value) || 0);

  const reconcileUncertain = () => {
    if (!backend) return;
    setLifecycle("clear");
    setError(null);
    void clearUncertainLaunch({ id: backend._id })
      .then((result) => {
        if (result.foundInstance) {
          setError(
            "Vast.ai found the instance and restored control of it. You can now destroy it safely.",
          );
        }
      })
      .catch((cause: unknown) => setError(errorMessage(cause)))
      .finally(() => setLifecycle(null));
  };

  const makeVastDefault = () => {
    setSelecting(true);
    setError(null);
    void selectProvider({ provider: "vast" })
      .catch((cause: unknown) => setError(errorMessage(cause)))
      .finally(() => setSelecting(false));
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-4xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Cpu className="h-4 w-4" /> Self-hosted backend
          </DialogTitle>
          <DialogDescription>
            Vast.ai and RunPod can stay online together. Choose which provider to manage here and
            which ready backend receives new generations.
          </DialogDescription>
        </DialogHeader>

        <div className="flex gap-1 rounded-lg border bg-muted/20 p-1">
          <Button
            className="flex-1"
            variant={provider === "runpod" ? "default" : "ghost"}
            onClick={() => setProvider("runpod")}
          >
            RunPod
          </Button>
          <Button
            className="flex-1"
            variant={provider === "vast" ? "default" : "ghost"}
            onClick={() => setProvider("vast")}
          >
            Vast.ai
          </Button>
        </div>

        {provider === "runpod" ? (
          <RunpodBackendPanel open={open} />
        ) : (
          <>
            {error && (
              <div className="rounded-md border border-destructive/30 bg-destructive/10 p-3 text-destructive">
                {error}
              </div>
            )}

            {backend === undefined ? (
              <div className="flex items-center justify-center gap-2 p-12 text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" /> Loading backend state…
              </div>
            ) : backend ? (
              <div className="space-y-4">
                <Card>
                  <CardHeader className="grid-cols-[1fr_auto]">
                    <div>
                      <CardTitle>
                        {backend.numGpus}× {backend.gpuName}
                      </CardTitle>
                      <p className="text-muted-foreground">
                        Vast instance #{backend.instanceId ?? "…"}
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
                      <span>{backend.diskGb} GB local disk</span>
                      <span>{mb(backend.diskBandwidthMbps)} disk</span>
                      <span>{backend.location}</span>
                    </div>
                    {backend.state === "stopped" && (
                      <div className="flex gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 p-3 text-amber-700 dark:text-amber-300">
                        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                        Stopping preserves the local disk, so storage continues to cost roughly{" "}
                        {usd(backend.storageHourlyUsd)}
                        /hr. Destroy stops all billing and permanently deletes the models.
                      </div>
                    )}
                    {backend.state === "error" && (
                      <div className="flex gap-2 rounded-md border border-destructive/30 bg-destructive/10 p-3 text-destructive">
                        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                        Automatic cleanup is retrying in the background. Until this row says
                        destroyed, verify billing in Vast.ai or destroy the instance here.
                      </div>
                    )}
                    <div className="flex flex-wrap gap-2">
                      {backend.state === "ready" && selection?.provider !== "vast" && (
                        <Button disabled={selecting} onClick={makeVastDefault}>
                          {selecting ? <Loader2 className="animate-spin" /> : <CheckCircle2 />}
                          Use for new generations
                        </Button>
                      )}
                      {backend.state === "ready" && selection?.provider === "vast" && (
                        <Badge>Selected for generations</Badge>
                      )}
                      {!backend.instanceId && backend.stage === "launch_uncertain" && (
                        <Button
                          variant="outline"
                          disabled={lifecycle !== null}
                          onClick={reconcileUncertain}
                        >
                          {lifecycle === "clear" ? (
                            <Loader2 className="animate-spin" />
                          ) : (
                            <Search />
                          )}{" "}
                          Check Vast.ai and release lock
                        </Button>
                      )}
                      {backend.state === "stopped" ? (
                        <Button disabled={lifecycle !== null} onClick={() => control("start")}>
                          {lifecycle === "start" ? <Loader2 className="animate-spin" /> : <Power />}{" "}
                          Start
                        </Button>
                      ) : (
                        <Button
                          variant="outline"
                          disabled={lifecycle !== null || backend.state === "reserving"}
                          onClick={() => control("stop")}
                        >
                          {lifecycle === "stop" ? <Loader2 className="animate-spin" /> : <Power />}{" "}
                          Stop GPU
                        </Button>
                      )}
                      <Button
                        variant="destructive"
                        disabled={lifecycle !== null || backend.instanceId === undefined}
                        onClick={() => setConfirmDestroy(true)}
                      >
                        <Trash2 /> Destroy and stop billing
                      </Button>
                    </div>
                  </CardContent>
                </Card>

                {confirmDestroy && (
                  <div className="rounded-md border border-destructive/30 bg-destructive/10 p-4">
                    <p className="font-medium">Permanently destroy this instance?</p>
                    <p className="mt-1 text-muted-foreground">
                      Vast deletes the {backend.diskGb} GB local disk immediately. Downloaded models
                      cannot be recovered, and all compute and storage billing stops.
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
            ) : (
              <div className="space-y-4">
                <div className="grid gap-3 rounded-lg border bg-muted/20 p-4 sm:grid-cols-2 lg:grid-cols-4">
                  <div className="space-y-1.5 sm:col-span-2">
                    <Label>GPU model</Label>
                    <SearchableSelect
                      options={gpuOptions}
                      value={gpuName}
                      onValueChange={setGpuName}
                      placeholder="Choose a GPU"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label>Number of GPUs</Label>
                    <div className="flex gap-1">
                      {[1, 2, 4, 8].map((count) => (
                        <Button
                          key={count}
                          type="button"
                          size="sm"
                          variant={numGpus === count ? "default" : "outline"}
                          onClick={() => setNumGpus(count)}
                        >
                          {count}×
                        </Button>
                      ))}
                    </div>
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="vast-disk">Local disk (GB)</Label>
                    <Input
                      id="vast-disk"
                      type="number"
                      min={MIN_VAST_DISK_GB}
                      max={MAX_VAST_DISK_GB}
                      value={diskGb}
                      onChange={numeric(setDiskGb)}
                    />
                    <p className="text-[10px] text-muted-foreground">
                      Fixed at creation; destroy wipes it.
                    </p>
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="vast-disk-speed">Minimum disk speed (MB/s)</Label>
                    <Input
                      id="vast-disk-speed"
                      type="number"
                      min={0}
                      value={minDiskBandwidth}
                      onChange={numeric(setMinDiskBandwidth)}
                    />
                    <p className="text-[10px] text-muted-foreground">
                      Set 0 to include every local disk.
                    </p>
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="vast-download">Minimum download (Mbps)</Label>
                    <Input
                      id="vast-download"
                      type="number"
                      min={0}
                      value={minDownloadMbps}
                      onChange={numeric(setMinDownloadMbps)}
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="vast-reliability">Minimum reliability (%)</Label>
                    <Input
                      id="vast-reliability"
                      type="number"
                      min={0}
                      max={100}
                      step={0.1}
                      value={minReliabilityPercent}
                      onChange={numeric(setMinReliabilityPercent)}
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="vast-max-price">Maximum hourly rent: GPU + disk ($/hr)</Label>
                    <Input
                      id="vast-max-price"
                      type="number"
                      min={0}
                      max={DEFAULT_MAX_HOURLY_USD}
                      step={0.1}
                      value={maxHourlyUsd}
                      onChange={numeric(setMaxHourlyUsd)}
                    />
                    <p className="text-[10px] text-muted-foreground">
                      Server safety cap: {usd(DEFAULT_MAX_HOURLY_USD)}/hr.
                    </p>
                  </div>
                  <div className="space-y-1.5 sm:col-span-2">
                    <Label>Sort offers</Label>
                    <div className="flex flex-wrap gap-1">
                      {(["price", "value", "disk", "download"] as VastOfferSort[]).map((value) => (
                        <Button
                          key={value}
                          size="sm"
                          variant={sort === value ? "default" : "outline"}
                          onClick={() => setSort(value)}
                        >
                          {value}
                        </Button>
                      ))}
                    </div>
                  </div>
                  <div className="flex items-end sm:col-span-2">
                    <Button className="w-full" disabled={formBusy !== null} onClick={search}>
                      {formBusy === "search" ? <Loader2 className="animate-spin" /> : <Search />}{" "}
                      Find current offers
                    </Button>
                  </div>
                </div>

                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="text-muted-foreground">
                    {offers.length} on-demand offer{offers.length === 1 ? "" : "s"}; hourly rent
                    includes the searched {offersDiskGb} GB disk. Bandwidth is listed separately.
                  </p>
                  <div className="flex flex-wrap items-center gap-3 text-[10px] text-muted-foreground">
                    {accountCredit !== null && <span>Vast credit: {usd(accountCredit)}</span>}
                    <span className="flex items-center gap-1">
                      <ShieldCheck className="h-3.5 w-3.5" /> Verified hosts only
                    </span>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      disabled={formBusy !== null}
                      onClick={search}
                    >
                      <RefreshCw className={formBusy === "search" ? "animate-spin" : ""} /> Refresh
                      offers
                    </Button>
                  </div>
                </div>

                <div className="max-h-[42vh] space-y-2 overflow-y-auto pr-1">
                  {offers.map((offer) => (
                    <OfferCard
                      key={offer.id}
                      offer={offer}
                      diskGb={offersDiskGb}
                      busy={formBusy !== null}
                      onChoose={(choice) => {
                        setError(null);
                        setSelected(choice);
                      }}
                    />
                  ))}
                  {formBusy !== "search" && offers.length === 0 && (
                    <div className="rounded-lg border border-dashed p-8 text-center text-muted-foreground">
                      No matching offers. Try “Any GPU”, a slower disk, or a higher price cap.
                    </div>
                  )}
                </div>

                {selected && (
                  <PodLaunchDialog
                    open
                    onOpenChange={(next) => {
                      if (!next) setSelected(null);
                    }}
                    profile="image"
                    title="Confirm paid rental"
                    busy={formBusy !== null}
                    error={error}
                    onLaunch={rent}
                  >
                    <p>
                      Rent {selected.numGpus}× {selected.gpuName} with {offersDiskGb} GB of
                      disposable local disk for {usd(selected.hourlyUsd)}/hr. The server re-checks
                      availability and price before charging; a change over 10% requires a fresh
                      confirmation. Bandwidth is separate: ↓ {usd(selected.downloadCostPerTbUsd)}
                      /TB and ↑ {usd(selected.uploadCostPerTbUsd)}/TB on this host.
                    </p>
                    {accountCredit !== null && selected.hourlyUsd > 0 && (
                      <p>
                        Your {usd(accountCredit)} Vast credit covers roughly{" "}
                        {(accountCredit / selected.hourlyUsd).toFixed(1)} hours at this rate before
                        other charges.
                      </p>
                    )}
                  </PodLaunchDialog>
                )}
              </div>
            )}
          </>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
