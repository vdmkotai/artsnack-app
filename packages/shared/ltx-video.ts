/**
 * Self-hosted LTX 2.3 on the video pod: the form's settings and the ComfyUI
 * graph built from them. Lives beside h3-video.ts — same pod, same job rows,
 * a second model family.
 *
 * The graph is a community LTX 2.3 image-to-video pipeline, read back out of
 * the workflows embedded in published example clips (2026-10-12): render at
 * half size for 8 distilled steps, upscale the latent 2× with Lightricks'
 * spatial upscaler, then refine 3 steps at full size. Core ComfyUI nodes plus
 * KJNodes' VAE loader, both already in the pod image.
 */

import { sanitizePodFilename } from "./pod-model-downloads";

/**
 * Files the video pod downloads for LTX — a contract with provision.sh's
 * LTX_MODELS. The official transformer is the fp8 build, not int8: int8
 * matmuls run several times slower on B300-class GPUs (measured 2026-10-12).
 */
export const LTX_BASE_FILES = {
  checkpoint: "ltx-2.3-22b-distilled-1.1_transformer_only_fp8_scaled.safetensors",
  gemma: "gemma_3_12B_it_fp8_scaled.safetensors",
  textProjection: "ltx-2.3_text_projection_bf16.safetensors",
  videoVae: "LTX23_video_vae_bf16.safetensors",
  audioVae: "LTX23_audio_vae_bf16.safetensors",
  spatialUpscaler: "ltx-2.3-spatial-upscaler-x2-1.1.safetensors",
  /** Lightricks' "Ingredients" IC-LoRA — the Reference sheet mode. Gated on
   *  Hugging Face: the pod only gets it with an HF_TOKEN whose account has
   *  accepted the LTX-2 Community License. */
  ingredients: "ltx-2.3-22b-ic-lora-ingredients-0.9.safetensors",
} as const;

/** Every file LTX needs before its first job (the official checkpoint aside). */
export const LTX_REQUIRED_FILES: readonly string[] = [
  LTX_BASE_FILES.gemma,
  LTX_BASE_FILES.textProjection,
  LTX_BASE_FILES.videoVae,
  LTX_BASE_FILES.audioVae,
  LTX_BASE_FILES.spatialUpscaler,
];

/**
 * Known checkpoints with the settings their authors recommend. The filename is
 * what provisioning saves; anything else in diffusion_models that is not an H3
 * file is treated as a generic LTX model.
 */
export const LTX_KNOWN_CHECKPOINTS: Record<string, { label: string; note: string }> = {
  [LTX_BASE_FILES.checkpoint]: {
    label: "LTX 2.3 distilled (official)",
    note: "Lightricks' 8-step distilled model",
  },
};

export const LTX_FPS_OPTIONS = [24, 30] as const;
export type LtxFps = (typeof LTX_FPS_OPTIONS)[number];

export const LTX_LIMITS = {
  dimension: { min: 256, max: 1920, step: 64 },
  durationSeconds: { min: 1, max: 20 },
  steps: { min: 4, max: 40 },
  imageStrength: { min: 0, max: 1 },
  imageCompression: { min: 0, max: 100 },
  cfg: { min: 1, max: 10 },
  loraStrength: { min: -5, max: 5 },
  loras: 10,
  sheetStrength: { min: 0.5, max: 2 },
} as const;

/**
 * text — prompt only; frames — first and/or last frame; sheet — a character or
 * product reference sheet the clip draws its subjects from (Ingredients IC-LoRA).
 */
export type LtxMode = "text" | "frames" | "sheet";
export type LtxLora = { name: string; strength: number };

export type LtxVideoSettings = {
  mode: LtxMode;
  prompt: string;
  /** Only read when cfg > 1 — distilled models run guidance-free. */
  negativePrompt: string;
  /** A file in the pod's models/diffusion_models. */
  checkpoint: string;
  loras: LtxLora[];
  /** Final size; the first pass runs at half of it when twoPass is on. */
  width: number;
  height: number;
  durationSeconds: number;
  fps: LtxFps;
  /** First-pass steps of the distilled schedule. */
  steps: number;
  /** How strongly the first/last frame holds (LTXVAddGuide). 0.7 lets it move. */
  imageStrength: number;
  /** LTXVPreprocess: JPEG-style compression that keeps an image frame from
   *  freezing the clip. 33 in every example workflow. */
  imageCompression: number;
  /** Half-size pass + 2× latent upscale + 3-step refine (the community pipeline). */
  twoPass: boolean;
  /** 1 = no negative prompt, fastest. Dev checkpoints without a distill LoRA want ~3. */
  cfg: number;
  seed: number;
  audio: boolean;
  /** Ingredients IC-LoRA strength in sheet mode; the model card says 1–1.4. */
  sheetStrength?: number;
};

export const DEFAULT_LTX_SETTINGS: LtxVideoSettings = {
  mode: "text",
  prompt: "",
  negativePrompt: "",
  checkpoint: LTX_BASE_FILES.checkpoint,
  loras: [],
  width: 768,
  height: 1344,
  durationSeconds: 5,
  fps: 24,
  steps: 8,
  imageStrength: 0.7,
  imageCompression: 33,
  twoPass: true,
  cfg: 1,
  seed: -1,
  audio: true,
  sheetStrength: 1,
};

/** LTX wants 8k+1 frames. */
export function ltxFrameCount(durationSeconds: number, fps: number): number {
  const raw = Math.max(9, Math.round(durationSeconds * fps));
  return Math.round((raw - 1) / 8) * 8 + 1;
}

function clamp(value: unknown, min: number, max: number, fallback: number): number {
  const n = typeof value === "number" && Number.isFinite(value) ? value : fallback;
  return Math.min(max, Math.max(min, n));
}

function roundTo(value: number, step: number): number {
  return Math.max(step, Math.round(value / step) * step);
}

export function normalizeLtxSettings(raw: Partial<LtxVideoSettings>): LtxVideoSettings {
  const d = DEFAULT_LTX_SETTINGS;
  const L = LTX_LIMITS;
  const checkpoint =
    typeof raw.checkpoint === "string" && sanitizePodFilename(raw.checkpoint) === raw.checkpoint
      ? raw.checkpoint
      : d.checkpoint;
  const loras = (Array.isArray(raw.loras) ? raw.loras : [])
    .filter(
      (lora): lora is LtxLora =>
        Boolean(lora) &&
        typeof lora.name === "string" &&
        sanitizePodFilename(lora.name) === lora.name,
    )
    .slice(0, L.loras)
    .map((lora) => ({
      name: lora.name,
      strength: clamp(lora.strength, L.loraStrength.min, L.loraStrength.max, 1),
    }));
  return {
    mode: raw.mode === "frames" || raw.mode === "sheet" ? raw.mode : "text",
    prompt: typeof raw.prompt === "string" ? raw.prompt.slice(0, 7000) : "",
    negativePrompt: typeof raw.negativePrompt === "string" ? raw.negativePrompt.slice(0, 2000) : "",
    checkpoint,
    loras,
    width: roundTo(clamp(raw.width, L.dimension.min, L.dimension.max, d.width), 64),
    height: roundTo(clamp(raw.height, L.dimension.min, L.dimension.max, d.height), 64),
    durationSeconds: Math.round(
      clamp(raw.durationSeconds, L.durationSeconds.min, L.durationSeconds.max, d.durationSeconds),
    ),
    fps: raw.fps === 30 ? 30 : 24,
    steps: Math.round(clamp(raw.steps, L.steps.min, L.steps.max, d.steps)),
    imageStrength: clamp(raw.imageStrength, 0, 1, d.imageStrength),
    imageCompression: Math.round(clamp(raw.imageCompression, 0, 100, d.imageCompression)),
    twoPass: raw.twoPass !== false,
    cfg: clamp(raw.cfg, L.cfg.min, L.cfg.max, d.cfg),
    seed: Math.round(clamp(raw.seed, -1, 2 ** 48, d.seed)),
    audio: raw.audio !== false,
    sheetStrength: clamp(
      raw.sheetStrength,
      L.sheetStrength.min,
      L.sheetStrength.max,
      d.sheetStrength ?? 1,
    ),
  };
}

/** Images already uploaded to the pod's input/ folder, by ComfyUI filename. */
export type LtxInputs = { firstFrame?: string; lastFrame?: string; references?: string[] };

type Node = { class_type: string; inputs: Record<string, unknown> };

/** The refine schedule every example workflow uses after the 2× upscale. */
const REFINE_SIGMAS = "0.909375, 0.725, 0.421875, 0.0";

/**
 * The schedule LTX 2.3's distilled models were trained on — eight fixed steps,
 * used by every Lightricks workflow (ComfyUI-LTXVideo example_workflows/2.3,
 * ltx_pipelines DISTILLED_SIGMA_VALUES). LTXVScheduler at 8 steps lands
 * elsewhere (second sigma 0.965 instead of 0.994, second-last 0.1 instead of
 * 0.42), so it only drives other step counts, e.g. a Dev model at ~30.
 */
const DISTILLED_SIGMAS = "1.0, 0.99375, 0.9875, 0.98125, 0.975, 0.909375, 0.725, 0.421875, 0.0";

/** Whether a job samples on the fixed distilled schedule (else LTXVScheduler). */
export function ltxUsesDistilledSigmas(
  settings: Pick<LtxVideoSettings, "mode" | "steps">,
): boolean {
  return settings.mode === "sheet" || settings.steps === 8;
}

export function buildLtxVideoWorkflow(
  settings: LtxVideoSettings,
  inputs: LtxInputs,
  options: { seed: number; filenamePrefix: string },
): Record<string, Node> {
  const s = settings;
  const g: Record<string, Node> = {};
  const length = ltxFrameCount(s.durationSeconds, s.fps);
  // Reference sheet: the sheet rides along as a second, full-length clip the
  // IC-LoRA was trained to read subjects from — so one stage at full size, as
  // in Lightricks' own workflow, with no upscale pass to lose the likeness in.
  const sheet = s.mode === "sheet" ? inputs.references?.[0] : undefined;
  const twoPass = s.twoPass && !sheet;
  const passWidth = twoPass ? s.width / 2 : s.width;
  const passHeight = twoPass ? s.height / 2 : s.height;

  g.unet = {
    class_type: "UNETLoader",
    inputs: { unet_name: s.checkpoint, weight_dtype: "default" },
  };
  let model: [string, number] = ["unet", 0];
  s.loras.forEach((lora, index) => {
    const id = `lora_${index}`;
    g[id] = {
      class_type: "LoraLoaderModelOnly",
      inputs: { model, lora_name: lora.name, strength_model: lora.strength },
    };
    model = [id, 0];
  });
  if (sheet) {
    g.ingredients = {
      class_type: "LoraLoaderModelOnly",
      inputs: {
        model,
        lora_name: LTX_BASE_FILES.ingredients,
        strength_model: s.sheetStrength ?? 1,
      },
    };
    model = ["ingredients", 0];
  }

  g.clip = {
    class_type: "DualCLIPLoader",
    inputs: {
      clip_name1: LTX_BASE_FILES.gemma,
      clip_name2: LTX_BASE_FILES.textProjection,
      type: "ltxv",
      device: "default",
    },
  };
  g.video_vae = {
    class_type: "VAELoaderKJ",
    inputs: { vae_name: LTX_BASE_FILES.videoVae, device: "main_device", weight_dtype: "bf16" },
  };
  g.audio_vae = {
    class_type: "VAELoaderKJ",
    inputs: { vae_name: LTX_BASE_FILES.audioVae, device: "main_device", weight_dtype: "bf16" },
  };
  g.positive = { class_type: "CLIPTextEncode", inputs: { text: s.prompt, clip: ["clip", 0] } };
  g.negative = {
    class_type: "CLIPTextEncode",
    inputs: { text: s.negativePrompt, clip: ["clip", 0] },
  };
  g.conditioning = {
    class_type: "LTXVConditioning",
    inputs: { positive: ["positive", 0], negative: ["negative", 0], frame_rate: s.fps },
  };

  g.empty_video = {
    class_type: "EmptyLTXVLatentVideo",
    inputs: { width: passWidth, height: passHeight, length, batch_size: 1 },
  };
  let positive: [string, number] = ["conditioning", 0];
  let negative: [string, number] = ["conditioning", 1];
  let videoLatent: [string, number] = ["empty_video", 0];

  // Frames: the image, cut to the clip's aspect, compressed a little so it
  // reads as a video frame rather than a still to freeze on, then pinned as a
  // guide at the first and/or last frame.
  let guideImage: [string, number] | null = null;
  const frameGuides: { file: string; frameIdx: number }[] = [];
  if (s.mode === "frames") {
    if (inputs.firstFrame) frameGuides.push({ file: inputs.firstFrame, frameIdx: 0 });
    if (inputs.lastFrame) frameGuides.push({ file: inputs.lastFrame, frameIdx: -1 });
  }
  frameGuides.forEach((frame, index) => {
    g[`frame_${index}`] = { class_type: "LoadImage", inputs: { image: frame.file } };
    g[`frame_fit_${index}`] = {
      class_type: "ImageResizeKJv2",
      inputs: {
        image: [`frame_${index}`, 0],
        width: s.width,
        height: s.height,
        upscale_method: "lanczos",
        keep_proportion: "crop",
        pad_color: "0, 0, 0",
        crop_position: "center",
        divisible_by: 32,
      },
    };
    g[`frame_prep_${index}`] = {
      class_type: "LTXVPreprocess",
      inputs: { image: [`frame_fit_${index}`, 0], img_compression: s.imageCompression },
    };
    g[`guide_${index}`] = {
      class_type: "LTXVAddGuide",
      inputs: {
        positive,
        negative,
        vae: ["video_vae", 0],
        latent: videoLatent,
        image: [`frame_prep_${index}`, 0],
        frame_idx: frame.frameIdx,
        strength: s.imageStrength,
      },
    };
    positive = [`guide_${index}`, 0];
    negative = [`guide_${index}`, 1];
    videoLatent = [`guide_${index}`, 2];
    if (frame.frameIdx === 0) guideImage = [`frame_prep_${index}`, 0];
  });

  // The Ingredients LoRA's reference_downscale_factor is 1, so core
  // LTXVAddGuide at frame 0 does what Lightricks' IC-LoRA guide node does: the
  // sheet, letterboxed on black (the card's advice) to the clip's size and
  // repeated to its length, appended as guide frames at full strength.
  if (sheet) {
    g.sheet = { class_type: "LoadImage", inputs: { image: sheet } };
    g.sheet_fit = {
      class_type: "ResizeAndPadImage",
      inputs: {
        image: ["sheet", 0],
        target_width: s.width,
        target_height: s.height,
        padding_color: "black",
        interpolation: "lanczos",
      },
    };
    g.sheet_clip = {
      class_type: "RepeatImageBatch",
      inputs: { image: ["sheet_fit", 0], amount: length },
    };
    g.sheet_guide = {
      class_type: "LTXVAddGuide",
      inputs: {
        positive,
        negative,
        vae: ["video_vae", 0],
        latent: videoLatent,
        image: ["sheet_clip", 0],
        frame_idx: 0,
        strength: 1,
      },
    };
    positive = ["sheet_guide", 0];
    negative = ["sheet_guide", 1];
    videoLatent = ["sheet_guide", 2];
  }

  g.empty_audio = {
    class_type: "LTXVEmptyLatentAudio",
    inputs: {
      frames_number: length,
      frame_rate: s.fps,
      batch_size: 1,
      audio_vae: ["audio_vae", 0],
    },
  };
  g.av = {
    class_type: "LTXVConcatAVLatent",
    inputs: { video_latent: videoLatent, audio_latent: ["empty_audio", 0] },
  };
  g.noise = { class_type: "RandomNoise", inputs: { noise_seed: options.seed } };
  g.schedule = ltxUsesDistilledSigmas(s)
    ? { class_type: "ManualSigmas", inputs: { sigmas: DISTILLED_SIGMAS } }
    : {
        class_type: "LTXVScheduler",
        inputs: {
          steps: s.steps,
          max_shift: 2.05,
          base_shift: 0.95,
          stretch: true,
          terminal: 0.1,
          latent: ["av", 0],
        },
      };
  g.sampler = {
    class_type: "KSamplerSelect",
    inputs: { sampler_name: sheet ? "euler_ancestral_cfg_pp" : "euler" },
  };
  g.guider = {
    class_type: "CFGGuider",
    inputs: { model, positive, negative, cfg: s.cfg },
  };
  g.sample = {
    class_type: "SamplerCustomAdvanced",
    inputs: {
      noise: ["noise", 0],
      guider: ["guider", 0],
      sampler: ["sampler", 0],
      sigmas: ["schedule", 0],
      latent_image: ["av", 0],
    },
  };
  let final: [string, number] = ["sample", 0];
  // The conditioning the decoded latent was last sampled with, and whether it
  // still carries guide frames that have to be cropped off before decoding.
  let finalPositive = positive;
  let finalNegative = negative;
  let guidedOutput = frameGuides.length > 0 || Boolean(sheet);

  if (twoPass) {
    g.split = { class_type: "LTXVSeparateAVLatent", inputs: { av_latent: ["sample", 0] } };
    // Guides were appended as extra latent frames; drop them before upscaling.
    g.crop = {
      class_type: "LTXVCropGuides",
      inputs: { positive, negative, latent: ["split", 0] },
    };
    g.upscaler = {
      class_type: "LatentUpscaleModelLoader",
      inputs: { model_name: LTX_BASE_FILES.spatialUpscaler },
    };
    g.upscale = {
      class_type: "LTXVLatentUpsampler",
      inputs: { samples: ["crop", 2], upscale_model: ["upscaler", 0], vae: ["video_vae", 0] },
    };
    let refineLatent: [string, number] = ["upscale", 0];
    if (guideImage) {
      g.reinforce = {
        class_type: "LTXVImgToVideoInplace",
        inputs: {
          vae: ["video_vae", 0],
          image: guideImage,
          latent: refineLatent,
          strength: 1,
          bypass: false,
        },
      };
      refineLatent = ["reinforce", 0];
    }
    // LTXVCropGuides dropped every guide with its conditioning; the first
    // frame is back in place above, a last frame is re-pinned here so the
    // refine does not drift off it.
    let refinePositive: [string, number] = ["crop", 0];
    let refineNegative: [string, number] = ["crop", 1];
    guidedOutput = false;
    frameGuides.forEach((frame, index) => {
      if (frame.frameIdx !== -1) return;
      const id = `refine_guide_${index}`;
      g[id] = {
        class_type: "LTXVAddGuide",
        inputs: {
          positive: refinePositive,
          negative: refineNegative,
          vae: ["video_vae", 0],
          latent: refineLatent,
          image: [`frame_prep_${index}`, 0],
          frame_idx: -1,
          strength: s.imageStrength,
        },
      };
      refinePositive = [id, 0];
      refineNegative = [id, 1];
      refineLatent = [id, 2];
      guidedOutput = true;
    });
    finalPositive = refinePositive;
    finalNegative = refineNegative;
    g.av_refine = {
      class_type: "LTXVConcatAVLatent",
      inputs: { video_latent: refineLatent, audio_latent: ["split", 1] },
    };
    g.guider_refine = {
      class_type: "CFGGuider",
      inputs: { model, positive: refinePositive, negative: refineNegative, cfg: s.cfg },
    };
    g.sampler_refine = {
      class_type: "KSamplerSelect",
      inputs: { sampler_name: "euler_ancestral" },
    };
    g.sigmas_refine = { class_type: "ManualSigmas", inputs: { sigmas: REFINE_SIGMAS } };
    g.sample_refine = {
      class_type: "SamplerCustomAdvanced",
      inputs: {
        noise: ["noise", 0],
        guider: ["guider_refine", 0],
        sampler: ["sampler_refine", 0],
        sigmas: ["sigmas_refine", 0],
        latent_image: ["av_refine", 0],
      },
    };
    final = ["sample_refine", 0];
  }

  g.split_out = { class_type: "LTXVSeparateAVLatent", inputs: { av_latent: final } };
  // Guide frames still on the latent — one pass, or a refine that re-pinned
  // the last frame — are cropped off before decoding.
  let decodeLatent: [string, number] = ["split_out", 0];
  if (guidedOutput) {
    g.crop_out = {
      class_type: "LTXVCropGuides",
      inputs: { positive: finalPositive, negative: finalNegative, latent: ["split_out", 0] },
    };
    decodeLatent = ["crop_out", 2];
  }
  g.decode = { class_type: "VAEDecode", inputs: { samples: decodeLatent, vae: ["video_vae", 0] } };
  const video: Record<string, unknown> = { images: ["decode", 0], fps: s.fps };
  if (s.audio) {
    g.decode_audio = {
      class_type: "LTXVAudioVAEDecode",
      inputs: { samples: ["split_out", 1], audio_vae: ["audio_vae", 0] },
    };
    video.audio = ["decode_audio", 0];
  }
  g.video = { class_type: "CreateVideo", inputs: video };
  g.save = {
    class_type: "SaveVideo",
    inputs: {
      video: ["video", 0],
      filename_prefix: options.filenamePrefix,
      format: "mp4",
      "format.codec": "h264",
    },
  };
  return g;
}

/** Short-edge presets. 768 is what the best examples use; 1088 is LTX's 1080p. */
export const LTX_SHORT_EDGES = [576, 704, 768, 960, 1088] as const;

const LTX_ASPECT_RATIOS: Record<string, number> = {
  "16:9": 16 / 9,
  "9:16": 9 / 16,
  "1:1": 1,
  "4:3": 4 / 3,
  "3:4": 3 / 4,
  "21:9": 21 / 9,
  "9:21": 9 / 21,
};

/** Size for a preset, snapped to 64 so the half-size first pass lands on 32. */
export function ltxDimensions(
  shortEdge: number,
  aspect: string,
): { width: number; height: number } {
  const ratio = LTX_ASPECT_RATIOS[aspect] ?? 16 / 9;
  const landscape = ratio >= 1;
  const snap = (value: number) => Math.max(256, Math.round(value / 64) * 64);
  const short = snap(shortEdge);
  const long = Math.min(
    LTX_LIMITS.dimension.max,
    snap(shortEdge * (landscape ? ratio : 1 / ratio)),
  );
  return landscape ? { width: long, height: short } : { width: short, height: long };
}

/** The settings the examples and the model authors recommend, per checkpoint. */
export function recommendedLtxSettings(): Pick<
  LtxVideoSettings,
  "steps" | "imageStrength" | "imageCompression" | "twoPass" | "cfg"
> {
  return { steps: 8, imageStrength: 0.7, imageCompression: 33, twoPass: true, cfg: 1 };
}

/**
 * LoRAs a checkpoint is built to run with, added by the form when the
 * checkpoint is picked — e.g. a DMD merge that pairs with its own DMD LoRA, or
 * a dev checkpoint that only samples in 8 steps with a distill LoRA. None of
 * the checkpoints provisioned by default needs one; add an entry here when a
 * custom checkpoint does.
 */
export const LTX_COMPANION_LORAS: readonly { checkpoint: RegExp; lora: LtxLora }[] = [];

export function ltxCompanionLora(checkpoint: string): LtxLora | null {
  return LTX_COMPANION_LORAS.find((entry) => entry.checkpoint.test(checkpoint))?.lora ?? null;
}
