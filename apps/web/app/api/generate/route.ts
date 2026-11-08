import { NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { getBackend } from "@/lib/backends";
import { applyLoraChain, type LoraInput } from "@/lib/workflows/lora-chain";
import { WorkflowParamError, readBoundedNumber } from "@/lib/workflows/numeric-params";

interface GenerateRequest {
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
  backend?: "comfyui" | "runpod";
}

/** The numeric fields after bounds checking, so buildWorkflow cannot be reached
 *  with a value the pod would choke on. */
type BoundedParams = {
  steps: number;
  cfg: number;
  width: number;
  height: number;
  batchSize: number;
};

function buildWorkflow(params: GenerateRequest, bounded: BoundedParams): Record<string, unknown> {
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

export async function POST(request: NextRequest) {
  const { userId } = await auth();

  if (!userId) {
    return NextResponse.json(
      { error: "Unauthorized. Please sign in to generate images." },
      { status: 401 },
    );
  }

  try {
    const params: GenerateRequest = await request.json();

    if (!params.prompt?.trim()) {
      return NextResponse.json({ error: "Prompt is required" }, { status: 400 });
    }
    if (!params.checkpoint) {
      return NextResponse.json({ error: "Checkpoint is required" }, { status: 400 });
    }

    let bounded: BoundedParams;
    try {
      bounded = {
        steps: readBoundedNumber("steps", params.steps, 20),
        cfg: readBoundedNumber("cfg", params.cfg, 7),
        width: readBoundedNumber("width", params.width, 1024),
        height: readBoundedNumber("height", params.height, 1024),
        batchSize: readBoundedNumber("batchSize", params.batchSize, 1),
      };
    } catch (error) {
      if (error instanceof WorkflowParamError) {
        return NextResponse.json({ error: error.message }, { status: 400 });
      }
      throw error;
    }

    const backendType = params.backend || "comfyui";
    const backend = getBackend(backendType);

    const health = await backend.healthCheck();
    if (!health.online) {
      return NextResponse.json({ error: "Backend offline", offline: true }, { status: 503 });
    }

    const workflow = buildWorkflow(params, bounded);
    const { promptId } = await backend.generate(workflow);

    return NextResponse.json({
      success: true,
      promptId,
      backend: backendType,
    });
  } catch (error) {
    console.error("[Generate API] Error:", error);
    return NextResponse.json(
      {
        error: "Generation failed",
        details: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 },
    );
  }
}
