import { router } from "expo-router";
import { useCallback } from "react";
import { Alert } from "react-native";

import type { Id } from "@/convex/_generated/dataModel";
import type { FeedItem } from "@/features/feed/types";
import { mediaUrl } from "@/lib/media-url";

import { ENHANCE_LABELS, useEnhance } from "@/features/enhance/use-enhance";

import { setEngine } from "./engine-store";
import { pendingHandoff } from "./handoff-store";
import { retainReference } from "./reference-files";

/**
 * The two things you can do with a finished generation somewhere else.
 *
 * On the web these are `sessionStorage["grok_pending_reference"]` written in the
 * hope the target tab mounts, and `?tab=api&reproduceApi=<id>`. Here the first
 * becomes an upload that finishes before the composer opens — so the strip is
 * populated when you arrive rather than a moment later — and the second stays
 * what it was: an id, resolved against the live row rather than a snapshot.
 */
/**
 * Recreate — the self-hosted equivalent of "Send to another model", and the same
 * thing the web's ↻ button does.
 *
 * The pod stores the entire form each run used, so this restores all of it:
 * negative prompt, checkpoint, size, seed, steps, CFG, sampler, scheduler and the
 * LoRA chain, not just the prompt. It needs no hooks, so the viewer can offer it
 * as its own button rather than only inside the menu.
 */
export function recreateLocal(item: FeedItem) {
  pendingHandoff.recreateLocalId = item.rowId as Id<"generations">;
  // The self-hosted form is a face of the Create tab rather than a route, so
  // getting there means switching the engine, not navigating to it.
  setEngine("local");
  // navigate, not push: the viewer is a root route above the tabs, and pushing
  // would leave it underneath the composer instead of popping it.
  router.navigate("/(tabs)/(create)");
}

/** Where the bytes are: a reference upload wants a URL, and our output is a B2 key. */
function sourceUrlFor(item: FeedItem): string | undefined {
  return item.mediaKey ? mediaUrl(item.mediaKey) : undefined;
}

/**
 * Whether "Use this elsewhere" has anything to offer, so the viewer can draw the
 * button only when it does.
 *
 * The test is what the row *can do*, not where it came from. A clip can only be
 * sent to another model, and only a hosted one has an id worth sending.
 */
export function canHandOff(item: FeedItem): boolean {
  // A hosted row carries settings worth sending on whether or not it has
  // produced a file yet, and that is the same admission `useHandoff` makes.
  if (item.source === "api") return true;
  if (item.kind === "image") return sourceUrlFor(item) !== undefined;
  return false;
}

export function useHandoff() {
  const { run: enhance } = useEnhance();

  return useCallback(
    (item: FeedItem) => {
      const sourceUrl = sourceUrlFor(item);
      if (!sourceUrl && item.source !== "api") return;

      const options: { text: string; onPress?: () => void; style?: "cancel" }[] = [];

      // First for self-hosted rows, because it is the one people reach for: the
      // viewer also carries it as its own button.
      if (item.source === "local") {
        options.push({
          text: "Recreate — restore all settings",
          onPress: () => recreateLocal(item),
        });
      }

      if (item.kind === "image" && sourceUrl)
        options.push({
          text: "Use as reference",
          onPress: () => {
            void (async () => {
              try {
                // Prepared for fal's box, which is the larger of the two. If the
                // composer is on Grok when it opens, the strip re-fits it.
                const reference = await retainReference(sourceUrl);
                pendingHandoff.reference = reference;
                // Only the hosted composer has a reference strip, so land on it —
                // the mirror of what recreateLocal does for the self-hosted form.
                // Without this the Create tab opened on whichever engine was last
                // used, and with the default being self-hosted the reference was
                // delivered to a screen that cannot show it.
                setEngine("api");
                // navigate, not push: the viewer is a root route above the tabs, and
                // pushing would leave it underneath the composer instead of
                // popping it.
                router.navigate("/(tabs)/(create)");
              } catch (error) {
                Alert.alert(
                  "Could not attach",
                  error instanceof Error ? error.message : "Unknown error",
                );
              }
            })();
          },
        });

      // Enhancement runs on the pod, so it is offered only for images and only
      // when there is a pod to run it — the action reports plainly when there is
      // not, which beats hiding the option and leaving no explanation.
      //
      // It needs a key rather than a URL: the action re-reads the file out of our
      // own bucket.
      if (item.kind === "image" && item.mediaKey) {
        options.push({
          text: "Enhance with settings…",
          onPress: () =>
            router.push({
              pathname: "/tools",
              params: {
                section: "enhance",
                sourceKey: item.mediaKey,
                ...(item.source === "local" ? { sourceGenerationId: item.rowId } : {}),
              },
            }),
        });
        for (const mode of ["upscale", "facefix", "refine"] as const) {
          options.push({
            text: ENHANCE_LABELS[mode],
            onPress: () =>
              void enhance(
                mode,
                item.mediaKey!,
                // Only a self-hosted row is a `generations` document; the other
                // two sources have ids into other tables entirely.
                item.source === "local" ? (item.rowId as Id<"generations">) : undefined,
              ),
          });
        }
      }

      // Deliberately not offered for "enhance": `reproduceId` is read by the
      // hosted composer and validated as a grokGenerations id, so an enhanced
      // image could only ever deliver settings that fail to load.
      if (item.source === "api") {
        options.push({
          text: "Send to another model",
          onPress: () => {
            pendingHandoff.reproduceId = item.rowId as Id<"grokGenerations">;
            // Only the hosted composer reads `reproduceId`, and the engine defaults to
            // self-hosted — so without this the settings were delivered to a screen
            // that never looks for them, and sat in the box until something else
            // happened to open the API composer.
            setEngine("api");
            router.navigate("/(tabs)/(create)");
          },
        });
      }

      options.push({ text: "Cancel", style: "cancel" });
      Alert.alert("Use this elsewhere", undefined, options);
    },
    [enhance],
  );
}
