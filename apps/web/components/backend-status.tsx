"use client";

import * as React from "react";
import { useQuery } from "convex/react";
import { Loader2, Settings2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { api } from "@/convex/_generated/api";
import { Button } from "@/components/ui/button";
import { LazyBackendManagerDialog, preloadBackendManagerDialog } from "@/components/lazy-dialogs";

/**
 * Liveness indicator for the self-hosted backend.
 *
 * There is only one self-hosted backend: ComfyUI behind one stable public
 * hostname (VAST_BACKEND_PUBLIC_URL on the Convex deployment). Convex orchestrates its Vast.ai instance; `comfyui` remains the
 * internal generation key so stored jobs and workflows need no migration.
 */
const BACKEND = "comfyui";

class BackendDeployBoundary extends React.Component<
  { children: React.ReactNode },
  { failed: boolean }
> {
  override state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  override render() {
    return this.state.failed ? <LegacyBackendStatus /> : this.props.children;
  }
}

function LegacyBackendStatus() {
  const [status, setStatus] = React.useState<"checking" | "online" | "offline">("checking");
  React.useEffect(() => {
    void fetch(`/api/backend-health?backend=${BACKEND}`)
      .then((response) => response.json())
      .then((body) => setStatus(body.online ? "online" : "offline"))
      .catch(() => setStatus("offline"));
  }, []);
  return (
    <Button variant="outline" className="gap-2" disabled title="Backend controls are updating">
      <div
        className={cn(
          "h-2 w-2 rounded-full",
          status === "online"
            ? "bg-green-500"
            : status === "offline"
              ? "bg-red-500"
              : "bg-gray-400",
        )}
      />
      <span className="text-sm font-medium">
        {status === "online" ? "Self-hosted ready" : "Backend controls updating"}
      </span>
    </Button>
  );
}

function BackendStatusInner() {
  const vastBackend = useQuery(api.vastBackendStore.current);
  const runpodBackend = useQuery(api.runpodBackendStore.current, {});
  const selection = useQuery(api.selfHostedSelection.current);
  const backend =
    selection?.provider === "runpod"
      ? runpodBackend
      : selection?.provider === "vast"
        ? vastBackend
        : (vastBackend ?? runpodBackend);
  const backendState = backend?.state;
  const backendLoaded = vastBackend !== undefined && runpodBackend !== undefined;
  const [open, setOpen] = React.useState(false);
  // Mounted from the first open on, so it keeps its close animation and state.
  const [opened, setOpened] = React.useState(false);
  const [status, setStatus] = React.useState<"checking" | "online" | "offline">("checking");

  // Keyed on what decides health — which row, its state, its address — not on
  // the row object, which is replaced by every progress write and used to
  // re-check (and flash the spinner) each time. Each check is aborted when the
  // next one starts, so an older answer can never land last.
  const backendId = backend?._id;
  const publicUrl = backend?.publicUrl;
  const noBackend = backend === null;
  React.useEffect(() => {
    if (backendState !== "ready" && !noBackend) {
      setStatus(backendLoaded ? "offline" : "checking");
      return;
    }
    const controller = new AbortController();
    setStatus("checking");
    void fetch(`/api/backend-health?backend=${BACKEND}`, { signal: controller.signal })
      .then((response) => response.json() as Promise<{ online?: boolean }>)
      .then((data) => {
        if (!controller.signal.aborted) setStatus(data.online ? "online" : "offline");
      })
      .catch(() => {
        if (!controller.signal.aborted) setStatus("offline");
      });
    return () => controller.abort();
  }, [backendId, backendLoaded, backendState, noBackend, publicUrl]);

  // Booting is not "offline": the dot turns amber and pulses, and the button
  // itself fills as the pod reports progress, so the percentage no longer
  // lives only inside the dialog.
  const booting =
    backend?.state === "reserving" ||
    backend?.state === "loading" ||
    backend?.state === "provisioning";
  const progress = booting ? Math.min(100, Math.max(0, backend.progress)) : null;

  const statusColor = booting
    ? "bg-amber-400 animate-pulse"
    : {
        checking: "bg-gray-400",
        online: "bg-green-500",
        offline: "bg-red-500",
      }[status];

  // podId is optional while RunPod is only reserved, whereas templateProfile
  // exists for its entire lifecycle and cannot mislabel an early launch as Vast.
  const providerLabel = backend && "templateProfile" in backend ? "RunPod" : "Vast.ai";
  const label = backend
    ? backend.state === "ready"
      ? `${providerLabel} ready`
      : `${providerLabel} · ${backend.state}`
    : status === "online"
      ? "Self-hosted ready"
      : "Start backend";

  return (
    <>
      <Button
        variant="outline"
        className={cn("gap-2", progress !== null && "relative overflow-hidden")}
        data-testid="backend-status"
        title={booting ? backend.message : undefined}
        onPointerEnter={preloadBackendManagerDialog}
        onFocus={preloadBackendManagerDialog}
        onClick={() => {
          setOpened(true);
          setOpen(true);
        }}
      >
        {progress !== null && (
          <>
            {/* The fill sits behind the label and the bar runs along the
                bottom edge; both track the same number the dialog shows. */}
            <span
              aria-hidden
              className="pointer-events-none absolute inset-y-0 left-0 bg-gradient-to-r from-primary/5 to-primary/25 transition-[width] duration-700 ease-out"
              style={{ width: `${progress}%` }}
            />
            <span
              aria-hidden
              className="pointer-events-none absolute bottom-0 left-0 h-0.5 bg-primary shadow-[0_0_6px] shadow-primary transition-[width] duration-700 ease-out"
              style={{ width: `${Math.max(2, progress)}%` }}
            />
          </>
        )}
        <div className={cn("relative h-2 w-2 rounded-full", statusColor)} />
        <span className="relative text-sm font-medium">{label}</span>
        {progress !== null && (
          <span
            className="relative rounded bg-primary/30 px-1.5 py-px font-mono text-xs font-semibold tabular-nums text-foreground"
            role="progressbar"
            aria-label="Provisioning progress"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(progress)}
          >
            {Math.round(progress)}%
          </span>
        )}
        {status === "checking" ? (
          <Loader2 className="relative h-3 w-3 animate-spin" />
        ) : (
          <Settings2 className="relative h-3 w-3" />
        )}
      </Button>
      {opened && <LazyBackendManagerDialog open={open} onOpenChange={setOpen} />}
    </>
  );
}

export function BackendStatus() {
  return (
    <BackendDeployBoundary>
      <BackendStatusInner />
    </BackendDeployBoundary>
  );
}
