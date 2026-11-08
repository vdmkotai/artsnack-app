"use client";

import { ConvexError } from "convex/values";
import { useAction } from "convex/react";
import { AlertTriangle, Loader2, Search } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { api } from "@/convex/_generated/api";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { FACE_FIX_FALLBACK_CHECKPOINT } from "@/lib/enhance-workflows";
import type { PodProfile } from "@/lib/pod-model-downloads";
import { podModelKey, type PodModelGroup } from "@/lib/pod-model-selection";

function errorMessage(error: unknown): string {
  return error instanceof ConvexError
    ? String(error.data)
    : error instanceof Error
      ? error.message
      : "The request failed";
}

/** The models unchecked at the last launch of this profile — a skip list, so
 *  a model added since then starts checked. */
const skipStorageKey = (profile: PodProfile) => `artsnack.podLaunch.skip.${profile}`;

function restoreSkipped(profile: PodProfile, groups: PodModelGroup[]): Set<string> {
  try {
    const saved: unknown = JSON.parse(window.localStorage.getItem(skipStorageKey(profile)) ?? "[]");
    const keys = new Set(groups.flatMap((group) => group.models.map((model) => model.key)));
    return new Set(
      Array.isArray(saved)
        ? saved.filter((key): key is string => typeof key === "string" && keys.has(key))
        : [],
    );
  } catch {
    return new Set();
  }
}

const ALWAYS_DOWNLOADED: Record<PodProfile, string> = {
  image: "Always downloaded: the 4x-UltraSharp upscaler and the Face Fix detectors.",
  video:
    "Always downloaded: the MiniMax H3 base set — both models, the text encoder, the VAEs and the turbo LoRAs.",
};

const FALLBACK_KEY = podModelKey("checkpoints", FACE_FIX_FALLBACK_CHECKPOINT);

/**
 * The paid-launch confirmation, with the models the new pod will download.
 *
 * Everything provision.sh would fetch that a pod can do without is listed as
 * the gist groups it, checked; what the user unchecks goes to the launch action
 * as `skipModels`. If the list cannot be read the pod downloads everything, as
 * it did before this dialog existed.
 */
export function PodLaunchDialog({
  open,
  onOpenChange,
  profile,
  title,
  children,
  busy,
  error,
  onLaunch,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  profile: PodProfile;
  title: string;
  /** What is rented and at what price. */
  children: React.ReactNode;
  busy: boolean;
  error: string | null;
  onLaunch: (skipModels: string[]) => void;
}) {
  const listModels = useAction(api.podLaunchModels.list);
  const [groups, setGroups] = useState<PodModelGroup[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [skipped, setSkipped] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState("");

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setGroups(null);
    setLoadError(null);
    setQuery("");
    listModels({ profile })
      .then((result) => {
        if (cancelled) return;
        setGroups(result);
        setSkipped(restoreSkipped(profile, result));
      })
      .catch((cause) => {
        if (!cancelled) setLoadError(errorMessage(cause));
      });
    return () => {
      cancelled = true;
    };
  }, [listModels, open, profile]);

  const total = useMemo(
    () => groups?.reduce((count, group) => count + group.models.length, 0) ?? 0,
    [groups],
  );
  const visibleGroups = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!groups || !needle) return groups ?? [];
    return groups
      .map((group) => ({
        ...group,
        models: group.models.filter(
          (model) =>
            model.label.toLowerCase().includes(needle) ||
            model.filename.toLowerCase().includes(needle),
        ),
      }))
      .filter((group) => group.models.length > 0);
  }, [groups, query]);

  const setChecked = (keys: string[], checked: boolean) =>
    setSkipped((current) => {
      const next = new Set(current);
      for (const key of keys) {
        if (checked) next.delete(key);
        else next.add(key);
      }
      return next;
    });
  const visibleKeys = visibleGroups.flatMap((group) => group.models.map((model) => model.key));

  const launch = () => {
    if (!groups) return onLaunch([]);
    const skipModels = [...skipped];
    window.localStorage.setItem(skipStorageKey(profile), JSON.stringify(skipModels));
    onLaunch(skipModels);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[90vh] flex-col sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <div className="space-y-1 text-muted-foreground">{children}</div>
        </DialogHeader>

        {groups === null && !loadError && (
          <div className="flex items-center justify-center gap-2 p-8 text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Reading the provisioning manifest…
          </div>
        )}
        {loadError && (
          <div className="flex gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 p-3 text-amber-700 dark:text-amber-300">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            <span>
              The model list could not be read ({loadError}). Launching now downloads every model,
              as before.
            </span>
          </div>
        )}

        {groups !== null && (
          <>
            <div className="flex flex-wrap items-center gap-2">
              <div className="relative min-w-48 flex-1">
                <Search className="pointer-events-none absolute top-1/2 left-2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
                <Input
                  className="pl-7"
                  value={query}
                  placeholder="Filter models"
                  onChange={(event) => setQuery(event.target.value)}
                />
              </div>
              <Button size="sm" variant="outline" onClick={() => setChecked(visibleKeys, true)}>
                All
              </Button>
              <Button size="sm" variant="outline" onClick={() => setChecked(visibleKeys, false)}>
                None
              </Button>
              <span className="text-muted-foreground tabular-nums">
                {total - skipped.size} of {total} selected
              </span>
            </div>

            <div className="min-h-0 flex-1 space-y-3 overflow-y-auto rounded-lg border p-3">
              {visibleGroups.map((group) => {
                const keys = group.models.map((model) => model.key);
                const unchecked = keys.filter((key) => skipped.has(key)).length;
                return (
                  <div key={group.title}>
                    <label className="flex items-center gap-2 font-medium">
                      <input
                        type="checkbox"
                        className="accent-primary"
                        checked={unchecked === 0}
                        ref={(element) => {
                          if (element) {
                            element.indeterminate = unchecked > 0 && unchecked < keys.length;
                          }
                        }}
                        onChange={(event) => setChecked(keys, event.target.checked)}
                      />
                      {group.title}
                      <span className="font-normal text-muted-foreground tabular-nums">
                        {keys.length - unchecked}/{keys.length}
                      </span>
                    </label>
                    <div className="mt-1 grid gap-x-4 gap-y-0.5 pl-5 sm:grid-cols-2">
                      {group.models.map((model) => (
                        <label
                          key={model.key}
                          className="flex min-w-0 items-center gap-2"
                          title={`${model.dir}/${model.filename}`}
                        >
                          <input
                            type="checkbox"
                            className="shrink-0 accent-primary"
                            checked={!skipped.has(model.key)}
                            onChange={(event) => setChecked([model.key], event.target.checked)}
                          />
                          <span className="truncate">{model.label}</span>
                        </label>
                      ))}
                    </div>
                  </div>
                );
              })}
              {total === 0 && (
                <p className="text-muted-foreground">This pod has no optional models to choose.</p>
              )}
              {total > 0 && visibleGroups.length === 0 && (
                <p className="text-muted-foreground">No model matches “{query}”.</p>
              )}
            </div>

            <p className="text-muted-foreground">{ALWAYS_DOWNLOADED[profile]}</p>
            {profile === "image" && skipped.has(FALLBACK_KEY) && (
              <div className="flex gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 p-3 text-amber-700 dark:text-amber-300">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                Enhance falls back to {FACE_FIX_FALLBACK_CHECKPOINT.replace(
                  /\.safetensors$/,
                  "",
                )}{" "}
                when it does not know an image&apos;s checkpoint (uploads, API images). Without it
                those Enhance jobs fail on this pod.
              </div>
            )}
          </>
        )}

        {error && (
          <div className="rounded-md border border-destructive/30 bg-destructive/10 p-3 text-destructive">
            {error}
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button disabled={busy || (groups === null && !loadError)} onClick={launch}>
            {busy && <Loader2 className="animate-spin" />} Confirm and launch
            {groups !== null && ` · ${total - skipped.size} of ${total} models`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
