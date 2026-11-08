"use client";

import { useMutation } from "convex/react";
import { toast } from "sonner";

import { api } from "@/convex/_generated/api";

/**
 * Favouriting, with the heart flipping immediately.
 *
 * Without an optimistic update the heart only changes once the mutation lands
 * and `myKeys` re-runs. On a slow link that reads as a dead button, and the
 * natural response — clicking again — is a second toggle that silently undoes
 * the first.
 */
export function useToggleFavorite() {
  const toggle = useMutation(api.favorites.toggle).withOptimisticUpdate((store, args) => {
    const keys = store.getQuery(api.favorites.myKeys, {});
    if (keys === undefined) return;
    store.setQuery(
      api.favorites.myKeys,
      {},
      keys.includes(args.b2Key) ? keys.filter((key) => key !== args.b2Key) : [...keys, args.b2Key],
    );
  });

  return (
    args:
      | { apiGenerationId: Parameters<typeof toggle>[0]["apiGenerationId"]; b2Key: string }
      | { generationId: Parameters<typeof toggle>[0]["generationId"]; b2Key: string }
      | { enhancementId: Parameters<typeof toggle>[0]["enhancementId"]; b2Key: string },
  ) =>
    toggle(args).catch((error: unknown) =>
      toast.error(error instanceof Error ? error.message : "Could not update favorites"),
    );
}
