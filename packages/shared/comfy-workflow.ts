/**
 * The ComfyUI graph for a self-hosted text-to-image generation.
 *
 * Lifted verbatim out of the Next route handler so Convex can build it too. Node
 * numbers are load-bearing: `applyLoraChain` re-points "3", "6" and "7" at the
 * end of the chain it inserts, and `packages/shared/workflows/lora-chain.ts`
 * documents why they are shared rather than duplicated.
 */

import { applyLoraChain, type LoraInput } from "./workflows/lora-chain";
import { readBoundedNumber } from "./workflows/numeric-params";

export type GenerateParams = {
  prompt: string;
  negativePrompt: string;
  checkpoint: string;
  width: number;
  height: number;
  seed: number;
  steps: number;
  cfg: number;
  sampler: string;
  scheduler: string;
  denoise: number;
  batchSize: number;
  loras: LoraInput[];
};

/** The numeric fields after bounds checking, so buildWorkflow cannot be reached
 *  with a value the pod would choke on. */
type BoundedParams = {
  steps: number;
  cfg: number;
  width: number;
  height: number;
  batchSize: number;
};

export function buildWorkflow(
  params: GenerateParams,
  bounded: BoundedParams,
): Record<string, object> {
  const seed = params.seed === -1 ? Math.floor(Math.random() * 2147483647) : params.seed;

  const denoise =
    typeof params.denoise === "number" && !isNaN(params.denoise) ? params.denoise : 1.0;
  const { batchSize, steps, cfg, width, height } = bounded;

  const workflow: Record<string, object> = {
    "3": {
      class_type: "KSampler",
      inputs: {
        seed: seed,
        steps: steps,
        cfg: cfg,
        sampler_name: params.sampler,
        scheduler: params.scheduler,
        denoise: denoise,
        model: ["4", 0],
        positive: ["6", 0],
        negative: ["7", 0],
        latent_image: ["5", 0],
      },
    },
    "4": {
      class_type: "CheckpointLoaderSimple",
      inputs: {
        ckpt_name: params.checkpoint,
      },
    },
    "5": {
      class_type: "EmptyLatentImage",
      inputs: {
        width: width,
        height: height,
        batch_size: batchSize,
      },
    },
    "6": {
      class_type: "CLIPTextEncode",
      inputs: {
        text: params.prompt,
        clip: ["4", 1],
      },
    },
    "7": {
      class_type: "CLIPTextEncode",
      inputs: {
        text: params.negativePrompt,
        clip: ["4", 1],
      },
    },
    "8": {
      class_type: "VAEDecode",
      inputs: {
        samples: ["3", 0],
        vae: ["4", 2],
      },
    },
    "9": {
      class_type: "SaveImage",
      inputs: {
        filename_prefix: "ArtSnack",
        images: ["8", 0],
      },
    },
  };

  applyLoraChain(workflow, params.loras);

  return workflow;
}

/** Bounds every numeric field, so buildWorkflow cannot be reached with a value
 *  the pod would choke on. Throws WorkflowParamError, which callers surface. */
export function boundParams(params: GenerateParams): BoundedParams {
  return {
    steps: readBoundedNumber("steps", params.steps, 20),
    cfg: readBoundedNumber("cfg", params.cfg, 7),
    width: readBoundedNumber("width", params.width, 1024),
    height: readBoundedNumber("height", params.height, 1024),
    batchSize: readBoundedNumber("batchSize", params.batchSize, 1),
  };
}
