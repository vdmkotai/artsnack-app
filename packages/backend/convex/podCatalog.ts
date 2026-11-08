"use node";

import { v } from "convex/values";
import { internal } from "./_generated/api";
import { action } from "./_generated/server";
import { requireAllowedUser } from "./authz";
import { noCacheFetch } from "../../shared/no-cdn-cache";
import { SAMPLERS, SCHEDULERS } from "../../shared/comfy-catalog";
import { resolveComfyuiTarget, resolveVideoPods } from "./comfyuiTarget";
import { H3_EXTRA_FILES, H3_SAMPLERS, H3_SCHEDULERS, H3_TURBO_LORAS } from "../../shared/h3-video";
import { LTX_BASE_FILES, LTX_REQUIRED_FILES } from "../../shared/ltx-video";
import { guessVideoFamily, type VideoFamily } from "../../shared/pod-model-downloads";
import type { ComfyuiTarget } from "./comfyuiTarget";

/**
 * What the pod currently has installed.
 *
 * These lists used to be Next route handlers, which meant the phone could not
 * read them: `proxy.ts` authenticates with a Clerk session cookie and a native
 * client carries none. As Convex actions they are reachable by anything holding
 * a Clerk token, and the web app calls the same code rather than a parallel copy.
 *
 * Samplers and schedulers are constants rather than probes — ComfyUI reports them
 * per node, and the set has not moved in years.
 */

/**
 * One `/object_info` probe, returning the choices of a single node input.
 *
 * A pod that is still loading answers `/object_info` before the choices are
 * populated, so an empty list is a "not ready", never a "none installed" — which
 * is why callers are told which it was rather than being handed `[]` twice.
 */
async function nodeChoices(target: ComfyuiTarget, node: string, input: string): Promise<string[]> {
  const response = await noCacheFetch(`${target.url}/object_info/${node}`, {
    headers: target.headers,
  });
  if (!response.ok) throw new Error(`Backend returned ${response.status}`);
  const data = (await response.json()) as Record<
    string,
    { input?: { required?: Record<string, unknown[]> } }
  >;
  const spec = data?.[node]?.input?.required?.[input];
  const choices = spec?.[0];
  if (Array.isArray(choices)) return choices as string[];
  // Newer ComfyUI describes some combos as ["COMBO", { options: [...] }].
  const options = (spec?.[1] as { options?: unknown } | undefined)?.options;
  return Array.isArray(options)
    ? options.filter((item): item is string => typeof item === "string")
    : [];
}

export type PodCatalog = {
  checkpoints: string[];
  loras: string[];
  unets: string[];
  samplers: readonly string[];
  schedulers: readonly string[];
  /** Present when the pod could not be reached or is still starting. */
  error?: string;
};

/**
 * Everything the self-hosted composer needs, in one round trip.
 *
 * The three Next routes fetched separately and the form waited on all of them;
 * one action is both fewer requests from the phone and one place for the
 * "still booting" case to be decided.
 */
export const catalog = action({
  args: {},
  handler: async (ctx): Promise<PodCatalog> => {
    await requireAllowedUser(ctx);
    const target = await resolveComfyuiTarget(ctx);

    /**
     * `allSettled`, not `all`.
     *
     * The three probes are independent, and only the first one is load-bearing:
     * `UNETLoader` is not installed on every ComfyUI build and `LoraLoader` can be
     * absent from a minimal one, so under `Promise.all` a single 404 on a node nothing
     * on the phone renders took the checkpoint list down with it — the composer showed
     * "Could not reach the backend" for a pod that was answering perfectly well.
     *
     * A failed checkpoint probe is still fatal, because a self-hosted generation cannot
     * run without one, and its own message is the useful one.
     */
    const [checkpoints, loras, unets] = await Promise.allSettled([
      nodeChoices(target, "CheckpointLoaderSimple", "ckpt_name"),
      nodeChoices(target, "LoraLoader", "lora_name"),
      nodeChoices(target, "UNETLoader", "unet_name"),
    ]);

    const settled = <T>(result: PromiseSettledResult<T[]>): T[] =>
      result.status === "fulfilled" ? result.value : [];

    if (checkpoints.status === "rejected") {
      const reason = checkpoints.reason as unknown;
      return {
        checkpoints: [],
        loras: settled(loras),
        unets: settled(unets),
        samplers: SAMPLERS,
        schedulers: SCHEDULERS,
        error: reason instanceof Error ? reason.message : "Could not reach the backend",
      };
    }

    return {
      checkpoints: checkpoints.value,
      loras: settled(loras),
      unets: settled(unets),
      samplers: SAMPLERS,
      schedulers: SCHEDULERS,
      error:
        checkpoints.value.length === 0
          ? "The pod answered but has no checkpoints loaded yet"
          : undefined,
    };
  },
});

export type VideoPodCatalog = {
  /** models/diffusion_models — the official H3 builds and every custom checkpoint. */
  checkpoints: string[];
  /** models/loras minus the official turbo LoRAs, which the Turbo switch owns. */
  loras: string[];
  samplers: readonly string[];
  schedulers: readonly string[];
  /** Which community add-ons the pod can run right now (file and node present). */
  extras: { rife: boolean; upscaler: boolean };
  /** LTX 2.3 on the same pod: its own checkpoints and LoRAs, and whether the
   *  base set (text encoder, VAEs, upscaler) has landed yet. */
  ltx: { ready: boolean; checkpoints: string[]; loras: string[]; sheet: boolean };
  error?: string;
};

/**
 * The video pod's lists, for the Self-hosted video tab. Probed on the nodes the
 * H3 graph actually uses (UNETLoader, LoraLoaderModelOnly), so what is offered
 * is exactly what the graph can load.
 */
export const videoCatalog = action({
  args: {
    /** One pod's models; absent = every ready pod's, merged (the "Auto" choice). */
    backendId: v.optional(v.id("runpodBackends")),
  },
  handler: async (ctx, args): Promise<VideoPodCatalog> => {
    await requireAllowedUser(ctx);
    const empty = (error: string): VideoPodCatalog => ({
      checkpoints: [],
      loras: [],
      samplers: H3_SAMPLERS,
      schedulers: H3_SCHEDULERS,
      extras: { rife: false, upscaler: false },
      ltx: { ready: false, checkpoints: [], loras: [], sheet: false },
      error,
    });
    const all = await resolveVideoPods(ctx);
    const pods = args.backendId ? all.filter((pod) => pod.backendId === args.backendId) : all;
    if (pods.length === 0) {
      return empty(
        args.backendId
          ? "That video pod is not running"
          : "The video pod is not running — start it in the Self-hosted video tab",
      );
    }
    const families = (await ctx.runQuery(internal.podModels.videoFamilies, {})) as Record<
      string,
      VideoFamily
    >;
    const familyOf = (name: string) => families[name] ?? guessVideoFamily(name);
    const perPod = await Promise.all(pods.map((pod) => podLists(pod)));
    const union = (pick: (lists: PodLists) => string[]) => [
      ...new Set(perPod.flatMap((lists) => pick(lists))),
    ];
    const checkpoints = union((lists) => lists.checkpoints);
    // The turbo LoRAs belong to H3's Turbo switch, Ingredients to LTX's
    // Reference sheet mode — neither is offered as a free-standing LoRA.
    const allLoras = union((lists) => lists.loras).filter(
      (name) => !H3_TURBO_LORAS.includes(name) && name !== LTX_BASE_FILES.ingredients,
    );
    // Unknown files are listed for both families; known ones only for theirs.
    const h3Only = (name: string) => familyOf(name) !== "ltx";
    const ltxOnly = (name: string) => familyOf(name) !== "h3";
    const reachable = perPod.some((lists) => lists.reachable);
    return {
      checkpoints: checkpoints.filter(h3Only),
      loras: allLoras.filter(h3Only),
      ltx: {
        ready: perPod.some((lists) => LTX_REQUIRED_FILES.every((file) => lists.ltxFiles.has(file))),
        checkpoints: checkpoints.filter(
          (name) => name === LTX_BASE_FILES.checkpoint || familyOf(name) === "ltx",
        ),
        loras: allLoras.filter(ltxOnly),
        sheet: perPod.some((lists) => lists.loras.includes(LTX_BASE_FILES.ingredients)),
      },
      samplers: H3_SAMPLERS,
      schedulers: H3_SCHEDULERS,
      extras: {
        rife: perPod.some((lists) => lists.interpolators.includes(H3_EXTRA_FILES.rife)),
        upscaler: perPod.some((lists) => lists.upscalers.includes(H3_EXTRA_FILES.latentUpscaler)),
      },
      error: reachable ? undefined : "Could not reach the video pod",
    };
  },
});

type PodLists = {
  reachable: boolean;
  checkpoints: string[];
  loras: string[];
  interpolators: string[];
  upscalers: string[];
  ltxFiles: Set<string>;
};

/** Everything one video pod's loaders list, each list empty when it fails. */
async function podLists(target: ComfyuiTarget): Promise<PodLists> {
  const [checkpoints, loras, interpolators, upscalers, ltxEncoders, ltxVaes, ltxUps] =
    await Promise.allSettled([
      nodeChoices(target, "UNETLoader", "unet_name"),
      nodeChoices(target, "LoraLoaderModelOnly", "lora_name"),
      nodeChoices(target, "FrameInterpolationModelLoader", "model_name"),
      // A pod booted before the upscaler existed has no such node: rejected → off.
      nodeChoices(target, "MinimaxH3LatentUpscaler3D", "model_name"),
      nodeChoices(target, "DualCLIPLoader", "clip_name1"),
      nodeChoices(target, "VAELoaderKJ", "vae_name"),
      nodeChoices(target, "LatentUpscaleModelLoader", "model_name"),
    ]);
  const list = (result: PromiseSettledResult<string[]>) =>
    result.status === "fulfilled" ? result.value : [];
  return {
    reachable: checkpoints.status === "fulfilled",
    checkpoints: list(checkpoints),
    loras: list(loras),
    interpolators: list(interpolators),
    upscalers: list(upscalers),
    ltxFiles: new Set([...list(ltxEncoders), ...list(ltxVaes), ...list(ltxUps)]),
  };
}

/** Whether the pod is answering at all — the dot beside the engine chip. */
export const health = action({
  args: {},
  handler: async (ctx): Promise<{ online: boolean; detail?: string }> => {
    await requireAllowedUser(ctx);
    try {
      const target = await resolveComfyuiTarget(ctx);
      const response = await noCacheFetch(`${target.url}/system_stats`, {
        headers: target.headers,
      });
      return response.ok
        ? { online: true }
        : { online: false, detail: `Backend returned ${response.status}` };
    } catch (error) {
      return {
        online: false,
        detail: error instanceof Error ? error.message : "Could not reach the backend",
      };
    }
  },
});
