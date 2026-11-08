import type { Id } from "@/convex/_generated/dataModel";

import type { Reference } from "./use-composer";

/**
 * What the composer should pick up when it next mounts.
 *
 * A module-level box rather than a route param because a `Reference` is an
 * object and an id is meaningless to anything but the composer. The web used
 * `sessionStorage` for the same job; the difference is that this is written only
 * after the upload has already succeeded, so the composer never shows a slot
 * that turns out to be empty.
 *
 * Read once and cleared, so a second visit to Create does not re-apply it.
 */
export const pendingHandoff: {
  reference?: Reference;
  /** Ordered multi-selection from the dedicated search screen. */
  references?: Reference[];
  /** "Send to another model" for a hosted row, read by the API composer. */
  reproduceId?: Id<"grokGenerations">;
  /**
   * Recreate a self-hosted generation: every setting it ran with — positive and
   * negative prompt, checkpoint, size, seed, steps, CFG, sampler, scheduler and
   * the whole LoRA chain. The id rather than the settings themselves, so what
   * lands in the form is the row as it is now; the API side and the web both
   * re-read the document for the same reason.
   */
  recreateLocalId?: Id<"generations">;
} = {};

type Handoff = typeof pendingHandoff;

/**
 * Takes only the fields the caller names, and clears only those.
 *
 * It used to take everything, and two different screens called it: the API
 * composer, which understands `reference` and `reproduceId`, and the local one,
 * which understands `recreateLocalId`. Whichever happened to be
 * focused consumed the other's payload and threw it away — so "Use as reference"
 * from the viewer, with the engine on self-hosted (the default), silently destroyed
 * the reference it had just spent an upload on, and no later switch to the hosted
 * composer could recover it.
 *
 * The local composer's focus effect also re-runs when the pod catalogue arrives,
 * which turned that into a second chance to eat something that had landed in
 * between.
 */
export function takeHandoff<K extends keyof Handoff>(...keys: K[]): Pick<Handoff, K> {
  const taken = {} as Pick<Handoff, K>;
  for (const key of keys) {
    if (pendingHandoff[key] === undefined) continue;
    taken[key] = pendingHandoff[key];
    delete pendingHandoff[key];
  }
  return taken;
}
