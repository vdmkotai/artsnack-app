"use node";

import { v } from "convex/values";
import { action } from "./_generated/server";
import { api } from "./_generated/api";
import { requireAllowedUser } from "./authz";
import { noCacheFetch } from "../../shared/no-cdn-cache";
import {
  buildFaceFixWorkflow,
  buildImg2ImgWorkflow,
  buildRefineWorkflow,
  buildUpscaleWorkflow,
  FACE_FIX_DEFAULTS,
  FACE_FIX_FALLBACK_CHECKPOINT,
} from "../../shared/enhance-workflows";
import { readBoundedNumber, WorkflowParamError } from "../../shared/workflows/numeric-params";
import type { LoraInput } from "../../shared/workflows/lora-chain";
import { collectComfyOutputs, submitToPod } from "./podClient";
import { resolveComfyuiTarget } from "./comfyuiTarget";

/**
 * Enhancement, as an asynchronous job.
 *
 * The Next route it replaces blocked for the whole render — which is why the web
 * page had to track in-flight work in `sessionStorage` to survive a tab switch,
 * and why a backgrounded phone would have killed it outright. Here the request
 * returns as soon as the pod has the job and the result is collected the same way
 * generations are.
 */

const loraValidator = v.object({
  enabled: v.boolean(),
  loraName: v.string(),
  strengthModel: v.number(),
  strengthClip: v.number(),
});

export const enhance = action({
  args: {
    mode: v.union(
      v.literal("img2img"),
      v.literal("upscale"),
      v.literal("refine"),
      v.literal("facefix"),
    ),
    /** Convex storage id of the source image, uploaded by the client. */
    sourceStorageId: v.id("_storage"),
    /** B2 key of the source when it came from a generation, for the record. */
    sourceB2Key: v.optional(v.string()),
    prompt: v.optional(v.string()),
    negativePrompt: v.optional(v.string()),
    checkpoint: v.optional(v.string()),
    sampler: v.optional(v.string()),
    scheduler: v.optional(v.string()),
    steps: v.optional(v.number()),
    cfg: v.optional(v.number()),
    seed: v.optional(v.number()),
    denoise: v.optional(v.number()),
    scale: v.optional(v.union(v.literal("2"), v.literal("4"))),
    loras: v.optional(v.array(loraValidator)),
    /**
     * The generation that produced the source, when there is one.
     *
     * Face Fix re-renders the face with the checkpoint, prompt and LoRAs that
     * drew the picture, and the phone reaches this action from a long press on a
     * tile — it has the row id and nothing else. Passing the id rather than the
     * settings keeps the client from having to carry a form state it never
     * assembled, and an id that no longer resolves simply falls back.
     */
    sourceGenerationId: v.optional(v.id("generations")),
    /** Face Fix only — see `buildFaceFixWorkflow`. */
    faceDetail: v.optional(v.union(v.literal("standard"), v.literal("high"), v.literal("max"))),
    faceDetector: v.optional(v.union(v.literal("accurate"), v.literal("fast"))),
    refineEyes: v.optional(v.boolean()),
    eyeDenoise: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<{ b2Keys: string[]; warning?: string }> => {
    await requireAllowedUser(ctx);

    let steps: number;
    let cfg: number;
    try {
      steps = readBoundedNumber("steps", args.steps ?? 20, 20);
      cfg = readBoundedNumber("cfg", args.cfg ?? 7, 7);
    } catch (error) {
      if (error instanceof WorkflowParamError) throw new Error(error.message);
      throw error;
    }

    const blob = await ctx.storage.get(args.sourceStorageId);
    if (!blob) throw new Error("The source image is no longer in storage");

    // One enhancement must stay on one machine from upload through collection,
    // even if the user switches the default provider while it is running.
    const target = await resolveComfyuiTarget(ctx);
    const filename = await uploadToPod(await blob.arrayBuffer(), target);

    const seed = args.seed ?? -1;

    // What drew the source, when the caller pointed at it. `getById` scopes to
    // the signed-in user and returns null for anything else, so an id from
    // somewhere it should not have come from reads as "no source".
    const source = args.sourceGenerationId
      ? await ctx.runQuery(api.generations.getById, { id: args.sourceGenerationId })
      : null;

    const loras: LoraInput[] = args.loras ?? source?.formState?.loras ?? [];
    const checkpoint =
      args.checkpoint || source?.formState?.checkpoint || FACE_FIX_FALLBACK_CHECKPOINT;
    const prompt = args.prompt ?? source?.formState?.prompt ?? "";
    const negativePrompt = args.negativePrompt ?? source?.formState?.negativePrompt ?? "";

    const workflow =
      args.mode === "img2img"
        ? buildImg2ImgWorkflow({
            inputImageFilename: filename,
            prompt,
            negativePrompt,
            checkpoint,
            sampler: args.sampler ?? "euler",
            scheduler: args.scheduler ?? "normal",
            steps,
            cfg,
            seed,
            denoise: args.denoise ?? 0.5,
            loras,
          })
        : args.mode === "upscale"
          ? buildUpscaleWorkflow({ inputImageFilename: filename, scale: args.scale ?? "4" })
          : args.mode === "refine"
            ? buildRefineWorkflow({
                inputImageFilename: filename,
                denoise: args.denoise ?? 0.3,
                checkpoint,
                prompt,
                negativePrompt,
              })
            : buildFaceFixWorkflow({
                inputImageFilename: filename,
                seed,
                checkpoint,
                prompt,
                negativePrompt,
                loras,
                // Undefined, not a default, for everything the caller left out:
                // the builder owns the Face Fix defaults, and the phone sends
                // none of these.
                denoise: args.denoise,
                steps: args.steps,
                cfg: args.cfg,
                detail: args.faceDetail,
                detector: args.faceDetector,
                refineEyes: args.refineEyes ?? FACE_FIX_DEFAULTS.refineEyes,
                eyeDenoise: args.eyeDenoise,
              });

    const promptId = await submitToPod(workflow, target);
    const outputs = await collectComfyOutputs(promptId, target);

    // Not a failure: the detector simply found nothing to work on, and saying so
    // is more useful than an error that implies something broke.
    const warning =
      args.mode === "facefix" && outputs.length === 0 ? "No faces detected" : undefined;

    await ctx.runMutation(api.enhancements.save, {
      timestamp: Date.now(),
      mode: args.mode,
      sourceImageUrl: args.sourceB2Key ?? "",
      sourceB2Key: args.sourceB2Key,
      resultB2Key: outputs[0] ?? "",
      params: {
        // The resolved values, not the arguments: Face Fix fills most of these
        // in itself, and a history row that says "steps: 20" for a run that did
        // 28 is worse than no row at all.
        prompt,
        negativePrompt,
        checkpoint,
        denoise: args.denoise ?? (args.mode === "facefix" ? FACE_FIX_DEFAULTS.denoise : undefined),
        scale: args.scale,
        steps: args.mode === "facefix" ? (args.steps ?? FACE_FIX_DEFAULTS.steps) : steps,
        cfg: args.mode === "facefix" ? (args.cfg ?? FACE_FIX_DEFAULTS.cfg) : cfg,
        seed,
      },
      backend: "comfyui",
      warning,
    });

    return { b2Keys: outputs, warning };
  },
});

/** ComfyUI's own upload endpoint, which takes multipart and returns a name. */
async function uploadToPod(
  bytes: ArrayBuffer,
  target: Awaited<ReturnType<typeof resolveComfyuiTarget>>,
): Promise<string> {
  const form = new FormData();
  form.append("image", new Blob([bytes], { type: "image/png" }), "source.png");
  form.append("overwrite", "true");

  const response = await noCacheFetch(`${target.url}/upload/image`, {
    method: "POST",
    headers: target.headers,
    body: form,
  });
  if (!response.ok) throw new Error(`Backend refused the upload (${response.status})`);
  const { name } = (await response.json()) as { name?: string };
  if (!name) throw new Error("Backend accepted the upload but returned no filename");
  return name;
}
