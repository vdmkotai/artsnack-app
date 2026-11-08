import { NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { getBackend } from "@/lib/backends";
import { uploadImageToBackend } from "@/lib/upload-to-backend";
import { type LoraInput } from "@/lib/workflows/lora-chain";
import { WorkflowParamError, readBoundedNumber } from "@/lib/workflows/numeric-params";
import {
  buildFaceFixWorkflow,
  buildImg2ImgWorkflow,
  buildRefineWorkflow,
  buildUpscaleWorkflow,
  FACE_FIX_DEFAULTS,
  FACE_FIX_FALLBACK_CHECKPOINT,
  type FaceFixDetail,
  type FaceFixDetector,
} from "@/lib/enhance-workflows";

/**
 * The four graphs live in packages/shared, not here.
 *
 * They were duplicated character-for-character between this route and the Convex
 * action that the phone uses, which meant a change to Face Fix could reach the
 * web app and not the phone with nothing anywhere to say so.
 */

/**
 * This route blocks on `backend.getResult()`, which polls the pod for up to
 * RESULT_MAX_ATTEMPTS x RESULT_POLL_DELAY_MS (lib/backends/comfyui.ts). The B2
 * upload happens *inside* that poll, so a platform timeout does not merely
 * return late — it loses a finished, already-paid-for image. Declaring the
 * ceiling here keeps the function alive longer than the poll can run.
 */
export const maxDuration = 300;

export async function POST(request: NextRequest) {
  const { userId } = await auth();

  if (!userId) {
    return NextResponse.json({ error: "Unauthorized. Please sign in." }, { status: 401 });
  }

  try {
    const formData = await request.formData();

    const mode = formData.get("mode") as string;
    const inputImageFile = formData.get("inputImage") as File | null;

    if (!mode || !["img2img", "upscale", "refine", "facefix"].includes(mode)) {
      return NextResponse.json(
        {
          error: "Invalid mode. Must be 'img2img', 'upscale', 'refine', or 'facefix'.",
        },
        { status: 400 },
      );
    }

    if (!inputImageFile) {
      return NextResponse.json({ error: "Input image is required" }, { status: 400 });
    }

    const backendType = (formData.get("backend") as "comfyui" | "runpod") || "comfyui";
    const scale = (formData.get("scale") as "2" | "4") || "4";
    const denoise = formData.get("denoise")
      ? parseFloat(formData.get("denoise") as string)
      : undefined;
    const prompt = (formData.get("prompt") as string) || "";
    const negativePrompt = (formData.get("negativePrompt") as string) || "";
    const checkpoint = (formData.get("checkpoint") as string) || "";
    const sampler = (formData.get("sampler") as string) || "euler";
    const scheduler = (formData.get("scheduler") as string) || "normal";
    const seed = formData.get("seed") ? parseInt(formData.get("seed") as string) : -1;

    let steps: number;
    let cfg: number;
    try {
      // Number, not parseInt: the CFG slider steps by 0.5 and parseInt silently
      // truncated 7.5 to 7.
      steps = readBoundedNumber("steps", formData.get("steps"), 20);
      cfg = readBoundedNumber("cfg", formData.get("cfg"), 7);
    } catch (error) {
      if (error instanceof WorkflowParamError) {
        return NextResponse.json({ error: error.message }, { status: 400 });
      }
      throw error;
    }

    let loras: LoraInput[] = [];
    const lorasJson = formData.get("loras") as string;
    if (lorasJson) {
      try {
        loras = JSON.parse(lorasJson) as LoraInput[];
      } catch {
        console.warn("[Enhance API] Failed to parse LoRAs JSON");
      }
    }

    let sourceCheckpoint = "";
    let sourcePrompt = "";
    let sourceNegativePrompt = "";
    let sourceLoras: LoraInput[] = [];
    const sourceFormStateJson = formData.get("sourceFormState") as string;
    if (sourceFormStateJson) {
      try {
        const sourceFormState = JSON.parse(sourceFormStateJson) as {
          checkpoint?: string;
          prompt?: string;
          negativePrompt?: string;
          loras?: LoraInput[];
        };
        sourceCheckpoint = sourceFormState.checkpoint || "";
        sourcePrompt = sourceFormState.prompt || "";
        sourceNegativePrompt = sourceFormState.negativePrompt || "";
        sourceLoras = sourceFormState.loras || [];
      } catch {
        console.warn("[Enhance API] Failed to parse sourceFormState JSON");
      }
    }

    const backend = getBackend(backendType);

    const health = await backend.healthCheck();
    if (!health.online) {
      return NextResponse.json(
        { error: health.error || "Backend offline", offline: true },
        { status: 503 },
      );
    }

    const imageArrayBuffer = await inputImageFile.arrayBuffer();
    const uploadedFilename = await uploadImageToBackend(imageArrayBuffer, backendType);

    let workflow: Record<string, unknown>;

    switch (mode) {
      case "img2img":
        workflow = buildImg2ImgWorkflow({
          inputImageFilename: uploadedFilename,
          prompt,
          negativePrompt,
          checkpoint: checkpoint || FACE_FIX_FALLBACK_CHECKPOINT,
          sampler,
          scheduler,
          steps,
          cfg,
          seed,
          denoise: denoise ?? 0.5,
          loras,
        });
        break;

      case "upscale":
        workflow = buildUpscaleWorkflow({
          inputImageFilename: uploadedFilename,
          scale,
        });
        break;

      case "refine":
        workflow = buildRefineWorkflow({
          inputImageFilename: uploadedFilename,
          denoise: denoise ?? 0.3,
          checkpoint: checkpoint || sourceCheckpoint || FACE_FIX_FALLBACK_CHECKPOINT,
          prompt: prompt || sourcePrompt,
          negativePrompt: negativePrompt || sourceNegativePrompt,
        });
        break;

      case "facefix":
        workflow = buildFaceFixWorkflow({
          inputImageFilename: uploadedFilename,
          seed,
          // Same precedence as refine: what the user typed here, else what drew
          // the source, else the fallback. The face is re-rendered by the model
          // that made the picture, which is the whole point of the mode.
          checkpoint: checkpoint || sourceCheckpoint || FACE_FIX_FALLBACK_CHECKPOINT,
          prompt: prompt || sourcePrompt,
          negativePrompt: negativePrompt || sourceNegativePrompt,
          loras: loras.length > 0 ? loras : sourceLoras,
          denoise,
          steps: formData.get("steps") ? steps : undefined,
          cfg: formData.get("cfg") ? cfg : undefined,
          detail: (formData.get("faceDetail") as FaceFixDetail) || undefined,
          detector: (formData.get("faceDetector") as FaceFixDetector) || undefined,
          refineEyes: formData.get("refineEyes") === "true",
          eyeDenoise: formData.get("eyeDenoise")
            ? parseFloat(formData.get("eyeDenoise") as string)
            : FACE_FIX_DEFAULTS.eyeDenoise,
        });
        break;

      default:
        return NextResponse.json({ error: "Invalid mode" }, { status: 400 });
    }

    const { promptId } = await backend.generate(workflow);
    const result = await backend.getResult(promptId);

    if (!result.success) {
      return NextResponse.json(
        {
          error: result.error || "Enhancement failed",
          details: result.error,
        },
        { status: 500 },
      );
    }

    let warning: string | undefined;
    if (mode === "facefix" && (!result.images || result.images.length === 0)) {
      warning = "No faces detected";
    }

    return NextResponse.json({
      success: true,
      b2Keys: result.b2Keys || [],
      ...(warning ? { warning } : {}),
    });
  } catch (error) {
    console.error("[Enhance API] Error:", error);
    return NextResponse.json(
      {
        error: "Enhancement failed",
        details: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 },
    );
  }
}
