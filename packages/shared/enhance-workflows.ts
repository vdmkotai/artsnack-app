/**
 * The four ComfyUI graphs behind Enhancement.
 *
 * Lifted out of the Next route handler so Convex can build them too — the phone
 * cannot reach that route, which authenticates with a Clerk session cookie.
 * Unchanged otherwise: node numbers and class names are what the pod matches on.
 *
 * img2img and refine differ only in denoise range and what they take as the
 * prompt; upscale runs a model rather than a sampler; facefix needs the
 * Impact-pack detector nodes, which is why it is the one that can report "no
 * faces found" as a warning rather than a failure. See the block above
 * `buildFaceFixWorkflow` for what those detectors are and why each is there.
 */

import { applyLoraChain, type LoraInput } from "./workflows/lora-chain";

export function buildImg2ImgWorkflow(params: {
  inputImageFilename: string;
  prompt: string;
  negativePrompt: string;
  checkpoint: string;
  sampler: string;
  scheduler: string;
  steps: number;
  cfg: number;
  seed: number;
  denoise: number;
  loras: LoraInput[];
}): Record<string, unknown> {
  const seed = params.seed === -1 ? Math.floor(Math.random() * 2147483647) : params.seed;
  const { steps, cfg } = params;
  const denoise =
    typeof params.denoise === "number" && !isNaN(params.denoise) ? params.denoise : 0.5;

  const workflow: Record<string, object> = {
    "4": {
      class_type: "CheckpointLoaderSimple",
      inputs: { ckpt_name: params.checkpoint },
    },
    "6": {
      class_type: "CLIPTextEncode",
      inputs: { text: params.prompt, clip: ["4", 1] },
    },
    "7": {
      class_type: "CLIPTextEncode",
      inputs: { text: params.negativePrompt, clip: ["4", 1] },
    },
    "10": {
      class_type: "LoadImage",
      inputs: { image: params.inputImageFilename },
    },
    "11": {
      class_type: "VAEEncode",
      inputs: { pixels: ["10", 0], vae: ["4", 2] },
    },
    "3": {
      class_type: "KSampler",
      inputs: {
        seed,
        steps,
        cfg,
        sampler_name: params.sampler,
        scheduler: params.scheduler,
        denoise,
        model: ["4", 0],
        positive: ["6", 0],
        negative: ["7", 0],
        latent_image: ["11", 0],
      },
    },
    "8": {
      class_type: "VAEDecode",
      inputs: { samples: ["3", 0], vae: ["4", 2] },
    },
    "9": {
      class_type: "SaveImage",
      inputs: { filename_prefix: "ArtSnack_enhance", images: ["8", 0] },
    },
  };

  applyLoraChain(workflow, params.loras);

  return workflow;
}

export function buildUpscaleWorkflow(params: {
  inputImageFilename: string;
  scale: "2" | "4";
}): Record<string, unknown> {
  const workflow: Record<string, object> = {
    "10": {
      class_type: "LoadImage",
      inputs: { image: params.inputImageFilename },
    },
    "20": {
      class_type: "UpscaleModelLoader",
      inputs: { model_name: "4x-UltraSharp.pth" },
    },
    "21": {
      class_type: "ImageUpscaleWithModel",
      inputs: { upscale_model: ["20", 0], image: ["10", 0] },
    },
  };

  if (params.scale === "2") {
    // 4x model then downscale by 0.5 to get 2x result
    workflow["22"] = {
      class_type: "ImageScaleBy",
      inputs: { image: ["21", 0], upscale_method: "lanczos", scale_by: 0.5 },
    };
    workflow["9"] = {
      class_type: "SaveImage",
      inputs: { filename_prefix: "ArtSnack_upscale", images: ["22", 0] },
    };
  } else {
    workflow["9"] = {
      class_type: "SaveImage",
      inputs: { filename_prefix: "ArtSnack_upscale", images: ["21", 0] },
    };
  }

  return workflow;
}

export function buildRefineWorkflow(params: {
  inputImageFilename: string;
  denoise: number;
  checkpoint: string;
  prompt: string;
  negativePrompt: string;
}): Record<string, unknown> {
  const denoise =
    typeof params.denoise === "number" && !isNaN(params.denoise) ? params.denoise : 0.3;

  // Fallback quality prompt when none provided (e.g. direct upload)
  const prompt = params.prompt || "masterpiece, best quality, absurdres, highly detailed";
  const negativePrompt =
    params.negativePrompt || "worst quality, low quality, blurry, noise, jpeg artifacts";
  const workflow: Record<string, object> = {
    "4": {
      class_type: "CheckpointLoaderSimple",
      inputs: { ckpt_name: params.checkpoint },
    },
    "6": {
      class_type: "CLIPTextEncode",
      inputs: { text: prompt, clip: ["4", 1] },
    },
    "7": {
      class_type: "CLIPTextEncode",
      inputs: { text: negativePrompt, clip: ["4", 1] },
    },
    "10": {
      class_type: "LoadImage",
      inputs: { image: params.inputImageFilename },
    },
    "11": {
      class_type: "VAEEncode",
      inputs: { pixels: ["10", 0], vae: ["4", 2] },
    },
    "3": {
      class_type: "KSampler",
      inputs: {
        seed: Math.floor(Math.random() * 2147483647),
        steps: 20,
        cfg: 7,
        sampler_name: "euler",
        scheduler: "normal",
        denoise,
        model: ["4", 0],
        positive: ["6", 0],
        negative: ["7", 0],
        latent_image: ["11", 0],
      },
    },
    "8": {
      class_type: "VAEDecode",
      inputs: { samples: ["3", 0], vae: ["4", 2] },
    },
    "9": {
      class_type: "SaveImage",
      inputs: { filename_prefix: "ArtSnack_refine", images: ["8", 0] },
    },
  };
  return workflow;
}

/**
 * ── Face Fix ──────────────────────────────────────────────────────────────
 *
 * Not a face *restorer*. GFPGAN and CodeFormer — which the UI used to claim was
 * running here, and never was — take a degraded photograph and hallucinate a
 * plausible face back into it from a GAN prior trained on real people. On an
 * image this app generated, that prior is the problem: it overwrites the
 * checkpoint's style with an averaged human one, so an anime face comes back
 * plastic and a stylised one comes back generic.
 *
 * What actually runs is detect-and-inpaint: find the faces, crop each one,
 * render it much larger with the *same* checkpoint that drew the picture, and
 * composite it back. The face is re-drawn by the model that owns the style, so
 * the style survives. Restoration belongs to a different problem — a real photo
 * someone uploads — and would need a different graph.
 *
 * Two models do the work, and each is a separate choice:
 *
 * - `bbox/face_yolov9c.pt` — YOLOv9-C face detection. Finds *where* the faces
 *   are. Better recall on small, profile and partly-hidden faces than the
 *   yolov8m this used to run; both are kept because v8m is a shade faster and
 *   was the proven default.
 * - `segm/Anzhc_Eyes_seg_hd.pt` — eye segmentation, for the optional second
 *   pass, which re-renders the eyes alone at high resolution after the face
 *   pass. Measured on the pod: two eyes at 0.91 and 0.90 confidence on a
 *   close-up, and 0.09 on a face 53px wide. So it earns its place on portraits
 *   and does nothing at all on a distant figure — which is the opposite of what
 *   it sounds like it should do, and is why the UI says so.
 *
 * A face *segmentation* model was tried here as well, wired to Impact's
 * `segm_detector_opt` so the repaint would follow the jaw and hairline instead
 * of a rectangle. It is not in this graph, on measurement rather than taste:
 * Impact intersects the segmentation mask with the detector's boxes, and when
 * the segmentation finds nothing the intersection is empty, the detailer logs
 * `segment skip [empty mask]` and Face Fix returns the source image untouched
 * while reporting success. `Anzhc Face seg 640 v3` scored 0.845 on a distant
 * face and found *nothing at all* on a close-up portrait, even at a confidence
 * floor of 0.05 — so the mode would have silently stopped working on the most
 * ordinary input there is. A feathered box mask always fires, and between
 * `feather` and `noise_mask_feather` below there is no visible seam to fix.
 *
 * The checkpoint, prompt and LoRAs are the source image's own — hardcoding one
 * checkpoint here meant every repaired face came back in that checkpoint's
 * style regardless of what drew the picture, which on anything stylised was the
 * most visible defect the mode had.
 */

/** Where the detectors live on the pod. Provisioned by `infra/provision.sh`. */
export const FACE_FIX_MODELS = {
  detectors: {
    accurate: "bbox/face_yolov9c.pt",
    fast: "bbox/face_yolov8m.pt",
  },
  eyeSegm: "segm/Anzhc_Eyes_seg_hd.pt",
} as const;

export type FaceFixDetector = keyof typeof FACE_FIX_MODELS.detectors;
export type FaceFixDetail = "standard" | "high" | "max";

/**
 * How many pixels a face gets.
 *
 * `guideSize` is the width the detected face box is scaled up to before it is
 * re-rendered; `cropFactor` is how much context around it comes along, so the
 * sampler actually sees `guideSize * cropFactor` pixels and `maxSize` caps that
 * at something SDXL renders without doubling artefacts. The old fixed values
 * (384 / 3.0 / 1024) hit the cap first and left the face itself at ~341px —
 * `high` puts 640 on it inside a 1408px frame, which is where the visible
 * difference comes from.
 */
export const FACE_FIX_DETAIL: Record<
  FaceFixDetail,
  { guideSize: number; maxSize: number; cropFactor: number }
> = {
  standard: { guideSize: 512, maxSize: 1152, cropFactor: 2.0 },
  high: { guideSize: 640, maxSize: 1536, cropFactor: 2.2 },
  max: { guideSize: 768, maxSize: 1792, cropFactor: 2.2 },
};

export const FACE_FIX_DEFAULTS = {
  denoise: 0.4,
  steps: 28,
  cfg: 7,
  sampler: "dpmpp_2m",
  scheduler: "karras",
  detail: "high" as FaceFixDetail,
  detector: "accurate" as FaceFixDetector,
  refineEyes: false,
  eyeDenoise: 0.3,
} as const;

export const FACE_FIX_FALLBACK_CHECKPOINT = "sd_xl_base_1.0.safetensors";

export interface FaceFixParams {
  inputImageFilename: string;
  seed: number;
  /** The checkpoint that drew the source. Falls back only when nothing is known. */
  checkpoint?: string;
  /** The source's own prompt, so the face is re-drawn in its terms. */
  prompt?: string;
  negativePrompt?: string;
  /** 0.15 barely touches it, 0.7 re-invents the face. */
  denoise?: number;
  steps?: number;
  cfg?: number;
  sampler?: string;
  scheduler?: string;
  detail?: FaceFixDetail;
  detector?: FaceFixDetector;
  /** Second pass over the eyes alone, after the face pass. */
  refineEyes?: boolean;
  eyeDenoise?: number;
  /** The source's LoRA stack — character and style triggers live here. */
  loras?: LoraInput[];
}

function clamp(value: number | undefined, min: number, max: number, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

export function buildFaceFixWorkflow(params: FaceFixParams): Record<string, unknown> {
  const seed = params.seed === -1 ? Math.floor(Math.random() * 2147483647) : params.seed;
  const preset = FACE_FIX_DETAIL[params.detail ?? FACE_FIX_DEFAULTS.detail];
  const detector = FACE_FIX_MODELS.detectors[params.detector ?? FACE_FIX_DEFAULTS.detector];
  const denoise = clamp(params.denoise, 0.05, 0.95, FACE_FIX_DEFAULTS.denoise);
  const steps = clamp(params.steps, 1, 150, FACE_FIX_DEFAULTS.steps);
  const cfg = clamp(params.cfg, 1, 30, FACE_FIX_DEFAULTS.cfg);
  const sampler = params.sampler || FACE_FIX_DEFAULTS.sampler;
  const scheduler = params.scheduler || FACE_FIX_DEFAULTS.scheduler;

  const workflow: Record<string, object> = {
    "4": {
      class_type: "CheckpointLoaderSimple",
      inputs: { ckpt_name: params.checkpoint || FACE_FIX_FALLBACK_CHECKPOINT },
    },
    "6": {
      class_type: "CLIPTextEncode",
      inputs: { text: params.prompt ?? "", clip: ["4", 1] },
    },
    "7": {
      class_type: "CLIPTextEncode",
      inputs: { text: params.negativePrompt ?? "", clip: ["4", 1] },
    },
    "10": {
      class_type: "LoadImage",
      inputs: { image: params.inputImageFilename },
    },
    "30": {
      class_type: "UltralyticsDetectorProvider",
      inputs: { model_name: detector },
    },
    "31": {
      class_type: "FaceDetailer",
      inputs: {
        image: ["10", 0],
        model: ["4", 0],
        clip: ["4", 1],
        vae: ["4", 2],
        positive: ["6", 0],
        negative: ["7", 0],
        bbox_detector: ["30", 0],
        seed,
        steps,
        cfg,
        sampler_name: sampler,
        scheduler,
        denoise,
        guide_size: preset.guideSize,
        // "bbox": the guide size is the size of the *face*, not of the crop —
        // so a distant face and a close one both get re-rendered at guideSize
        // and the setting means the same thing whatever the composition.
        guide_size_for: true,
        max_size: preset.maxSize,
        // Two different feathers, both wanted, and together they are what makes
        // a rectangular mask invisible. `feather` softens the pixel composite at
        // the end; `noise_mask_feather` switches Impact to differential
        // diffusion and softens the mask the sampler itself works under, which
        // is what stops the edge of the repaired area from reading as a
        // different exposure. The old graph had 5 and none.
        feather: 12,
        noise_mask_feather: 24,
        noise_mask: true,
        // Never skip a face for being large already: without this a close-up
        // portrait falls through the detailer untouched.
        force_inpaint: true,
        // 0.45 rather than the 0.5 default: profile and partly-occluded faces
        // score lower, and those are the ones most likely to need the pass. Not
        // lower than that — on a street scene yolov9c returned the real face at
        // 0.875 and five background false positives between 0.087 and 0.218, so
        // there is a wide gap here and no reason to walk into it.
        bbox_threshold: 0.45,
        bbox_dilation: 12,
        bbox_crop_factor: preset.cropFactor,
        // Required inputs, and every one of them is inert: they only take
        // effect when `sam_model_opt` is connected, which it is not. Left at
        // "none" rather than the node's "center-1" default so the graph does not
        // read as though SAM were refining anything — the old one did.
        sam_detection_hint: "none",
        sam_dilation: 0,
        sam_threshold: 0.93,
        sam_bbox_expansion: 0,
        sam_mask_hint_threshold: 0.7,
        sam_mask_hint_use_negative: "False",
        drop_size: 10,
        wildcard: "",
        cycle: 1,
      },
    },
  };

  let lastImage: [string, number] = ["31", 0];

  if (params.refineEyes) {
    workflow["33"] = {
      class_type: "UltralyticsDetectorProvider",
      inputs: { model_name: FACE_FIX_MODELS.eyeSegm },
    };
    workflow["34"] = {
      class_type: "FaceDetailer",
      inputs: {
        image: lastImage,
        model: ["4", 0],
        clip: ["4", 1],
        vae: ["4", 2],
        positive: ["6", 0],
        negative: ["7", 0],
        bbox_detector: ["33", 0],
        // Both detectors are the *same* model, which is what makes the
        // intersection safe here and not where it was removed above: whatever
        // the box detector finds, the segmentation half of the same model finds
        // too, at the same threshold. The result is an eye-shaped mask rather
        // than a rectangle over the eye, and it can never come out empty while
        // the box half found something.
        segm_detector_opt: ["33", 1],
        // A different seed from the face pass: the same one re-rolls the same
        // noise over an area that has just changed underneath it.
        seed: seed + 1,
        steps: 20,
        cfg,
        sampler_name: sampler,
        scheduler,
        // Deliberately gentler than the face pass. An eye given as much freedom
        // as a face comes back looking at something else.
        denoise: clamp(params.eyeDenoise, 0.05, 0.6, FACE_FIX_DEFAULTS.eyeDenoise),
        guide_size: 320,
        guide_size_for: true,
        max_size: 1024,
        feather: 8,
        noise_mask_feather: 16,
        noise_mask: true,
        force_inpaint: true,
        bbox_threshold: 0.5,
        bbox_dilation: 6,
        bbox_crop_factor: 3.0,
        sam_detection_hint: "none",
        sam_dilation: 0,
        sam_threshold: 0.93,
        sam_bbox_expansion: 0,
        sam_mask_hint_threshold: 0.7,
        sam_mask_hint_use_negative: "False",
        drop_size: 6,
        wildcard: "",
        cycle: 1,
      },
    };
    lastImage = ["34", 0];
  }

  workflow["9"] = {
    class_type: "SaveImage",
    inputs: { filename_prefix: "ArtSnack_facefix", images: lastImage },
  };

  applyLoraChain(workflow, params.loras ?? [], { model: ["31", "34"], clip: ["6", "7"] });

  return workflow;
}
