"use client";

import { useMutation, useQuery } from "convex/react";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";

import { api } from "@/convex/_generated/api";
import { Switch } from "@/components/ui/switch";
import { MediaCacheSettings } from "@/components/media-cache-settings";
import { FEATURE_FLAGS, type FeatureFlagKey } from "@/lib/feature-flags";

/**
 * Feature flags, one switch each. They only change what the UI offers — see
 * packages/shared/feature-flags.ts — and are stored per account, so the browser
 * and the desktop app show the same tabs.
 */
export default function SettingsPage() {
  const flags = useQuery(api.featureFlags.mine);
  const setFlag = useMutation(api.featureFlags.set).withOptimisticUpdate(
    (store, { key, enabled }) => {
      const current = store.getQuery(api.featureFlags.mine, {});
      if (current) store.setQuery(api.featureFlags.mine, {}, { ...current, [key]: enabled });
    },
  );

  const toggle = (key: FeatureFlagKey, enabled: boolean) => {
    void setFlag({ key, enabled }).catch((error: unknown) => {
      toast.error(error instanceof Error ? error.message : "Could not save the setting");
    });
  };

  return (
    <div className="mx-auto max-w-2xl px-4 py-6 lg:px-6">
      <div className="mb-6">
        <h1 className="text-2xl font-bold">Settings</h1>
        <p className="text-sm text-muted-foreground">
          Saved to your account, so the browser and the desktop app match.
        </p>
      </div>

      <section className="space-y-3">
        <div>
          <h2 className="text-base font-semibold">Feature flags</h2>
          <p className="text-sm text-muted-foreground">
            Hide the API providers you are not using. A hidden provider keeps its results, and
            reproducing one of them still works.
          </p>
        </div>

        <div className="divide-y rounded-lg border bg-card">
          {flags === undefined ? (
            <div className="flex justify-center py-8">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            </div>
          ) : flags === null ? (
            <p className="px-4 py-8 text-center text-sm text-muted-foreground">
              Sign in to change settings.
            </p>
          ) : (
            FEATURE_FLAGS.map((flag) => (
              <label
                key={flag.key}
                className="flex cursor-pointer items-center justify-between gap-4 px-4 py-3"
              >
                <span className="min-w-0">
                  <span className="block text-sm font-medium">{flag.label}</span>
                  <span className="block text-xs text-muted-foreground">{flag.description}</span>
                </span>
                <Switch
                  checked={flags[flag.key]}
                  onCheckedChange={(checked) => toggle(flag.key, checked)}
                />
              </label>
            ))
          )}
        </div>
      </section>

      <MediaCacheSettings />
    </div>
  );
}
