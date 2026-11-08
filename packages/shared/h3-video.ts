/**
 * MiniMax H3 on the self-hosted video pod: the settings the tab offers, their
 * bounds, and the ComfyUI graph they turn into.
 *
 * The graph is the official Comfy-Org template (`video_minimax_h3_t2v`,
 * `_i2v`, `_r2v` in comfyui_workflow_templates_json, ComfyUI v0.39.2) with the
 * subgraph flattened into API format. It was run end to end on an RTX PRO 6000
 * on 2026-10-11 — see docs/research/minimax-h3-custom-models.md for the
 * measurements behind every default here.
 *
 * Everything is core ComfyUI: no custom node pack is needed for H3, which is
 * why provision.sh's video profile installs none.
 */

import { sanitizePodFilename } from "./pod-model-downloads";

/** Files provision.sh's video profile puts on every pod. The text encoder is
 *  saved under a neutral name because the quantisation depends on the GPU. */
export const H3_BASE_FILES = {
  fl2va: "minimax_h3_fl2va_pruned_int8_convrot.safetensors",
  ref2va: "minimax_h3_ref2va_pruned_int8_convrot.safetensors",
  textEncoder: "minimax_h3_text_encoder.safetensors",
  videoVae: "minimax_h3_video_vae_fp16.safetensors",
  audioVae: "minimax_h3_audio_vae_fp32.safetensors",
  turboFl2v: "minimax_h3_fl2v_turbo_8step_v1.0_comfyui_bf16.safetensors",
  turboRef2v: "minimax_h3_ref2v_turbo_4step_v0.1_comfyui_bf16.safetensors",
} as const;

/**
 * Community add-ons behind the form's "Community" options. Both ride with the
 * boot set. Each option stays disabled until the pod lists its file. Filenames
 * are a contract with provision.sh (VIDEO_MODELS).
 */
export const H3_EXTRA_FILES = {
  /** Comfy-Org's RIFE 4.26 for ComfyUI's built-in FrameInterpolate. */
  rife: "rife_v4.26.safetensors",
  /** LBH-123's trained 3D latent upscaler (MIT), with its custom node. */
  latentUpscaler: "minimax_h3_latent_upscaler_3d_conv_v1_fp16.safetensors",
} as const;

/** The official turbo LoRAs are infrastructure, not something to stack by hand —
 *  the "Turbo" switch adds the right one for the mode. */
export const H3_TURBO_LORAS: readonly string[] = [
  H3_BASE_FILES.turboFl2v,
  H3_BASE_FILES.turboRef2v,
];

/** H3 renders at 24 fps; it is not a setting. */
export const H3_FPS = 24;

export type H3Mode = "text" | "frames" | "reference";

export const H3_MODES: readonly { value: H3Mode; label: string; hint: string }[] = [
  { value: "text", label: "Text → video", hint: "Prompt only." },
  {
    value: "frames",
    label: "Image → video",
    hint: "A first frame, a last frame, or both. Hybrid community checkpoints prefer Reference.",
  },
  {
    value: "reference",
    label: "Reference → video",
    hint: "Up to 9 reference images; name them in the prompt as <Picture 1>, <Picture 2>…",
  },
];

export const H3_SAMPLERS = [
  "res_multistep",
  "euler",
  "er_sde",
  "lcm",
  "euler_ancestral",
  "res_multistep_ancestral",
  "dpmpp_2m",
  "dpmpp_2m_sde",
  "dpmpp_sde",
  "dpmpp_3m_sde",
  "uni_pc",
  "uni_pc_bh2",
  "deis",
  "ddim",
  "heun",
  "gradient_estimation",
  "sa_solver",
  "seeds_2",
  "seeds_3",
] as const;

export const H3_SCHEDULERS = [
  "simple",
  "beta",
  "normal",
  "karras",
  "exponential",
  "sgm_uniform",
  "ddim_uniform",
  "linear_quadratic",
  "kl_optimal",
] as const;

export const H3_ASPECTS = ["16:9", "9:16", "1:1", "4:3", "3:4", "21:9", "9:21"] as const;
export type H3Aspect = (typeof H3_ASPECTS)[number];

/** Short-edge presets. 768 is H3's native ceiling (768×1344). */
export const H3_SHORT_EDGES = [480, 576, 640, 720, 768] as const;

export const H3_LIMITS = {
  /** Width/height snap to 32, like the template's ResolutionSelector. */
  dimension: { min: 256, max: 1920, step: 32 },
  /** The model's trained range is ~5–15 s; longer works but drifts. */
  durationSeconds: { min: 1, max: 20 },
  steps: { min: 1, max: 60 },
  shift: { min: 0.01, max: 100 },
  loraStrength: { min: -5, max: 5 },
  loras: 10,
  references: 9,
  sparseTau: { min: 0, max: 4 },
  sparseKeepPercent: { min: 0.5, max: 95 },
  easyCacheThreshold: { min: 0, max: 3 },
} as const;

export type H3Lora = { name: string; strength: number };

export type H3SparseAttention = "off" | "sol-attn" | "vsa";

export type H3VideoSettings = {
  mode: H3Mode;
  prompt: string;
  /** A file in the pod's models/diffusion_models. */
  checkpoint: string;
  loras: H3Lora[];
  /** Adds the official turbo LoRA for the mode. */
  turbo: boolean;
  width: number;
  height: number;
  durationSeconds: number;
  steps: number;
  sampler: string;
  scheduler: string;
  /** MiniMaxH3SigmaShift. Off = the model's built-in schedule (the official
   *  template); community checkpoints mostly ask for 10–12 video / 3–5 audio. */
  shiftEnabled: boolean;
  shiftVideo: number;
  shiftAudio: number;
  /** "Comfy Kitchen" INT8 attention: −27% time at no visible cost (measured). */
  fastAttention: boolean;
  sparseAttention: H3SparseAttention;
  /** sol-attn: tau. vsa: keep percent (FastH3-trained weights only). */
  sparseValue: number;
  easyCache: boolean;
  easyCacheThreshold: number;
  /** -1 = random; resolved before submit so a result can be reproduced. */
  seed: number;
  /** Off drops the soundtrack from the file. H3 still denoises audio jointly,
   *  so it does not make generation faster. */
  audio: boolean;
  /** Reference mode: "max" keeps refs at 2048 px for identity, and is slower. */
  referenceSize: "match" | "max";
  /** Community: RIFE doubles the frame rate to 48 fps after decoding. */
  interpolate: boolean;
  /** Community: render at half size, upscale the latent 2× (LBH-123's
   *  trained upscaler), then refine 3 steps at full size. */
  upscale: boolean;
};

export const H3_TURBO_STEPS: Record<H3Mode, number> = { text: 8, frames: 8, reference: 4 };
export const H3_FULL_STEPS = 20;

export function defaultCheckpointFor(mode: H3Mode): string {
  return mode === "reference" ? H3_BASE_FILES.ref2va : H3_BASE_FILES.fl2va;
}

export const DEFAULT_H3_SETTINGS: H3VideoSettings = {
  mode: "text",
  prompt: "",
  checkpoint: H3_BASE_FILES.fl2va,
  loras: [],
  turbo: true,
  width: 1344,
  height: 768,
  durationSeconds: 5,
  steps: H3_TURBO_STEPS.text,
  sampler: "res_multistep",
  scheduler: "simple",
  shiftEnabled: false,
  shiftVideo: 10,
  shiftAudio: 3,
  fastAttention: true,
  sparseAttention: "off",
  sparseValue: 1.3,
  easyCache: false,
  easyCacheThreshold: 0.2,
  seed: -1,
  audio: true,
  referenceSize: "match",
  interpolate: false,
  upscale: false,
};

/** Frame count for a duration: H3 works on a 17k+5 grid (124 ≈ 5 s), and this
 *  is the template's own ComfyMathExpression, evaluated here instead. */
export function h3FrameCount(durationSeconds: number): number {
  const raw = Math.max(5, Math.round(durationSeconds * H3_FPS));
  return raw + ((5 - (raw % 17) + 17) % 17);
}

function snap32(value: number): number {
  return Math.round(value / 32) * 32;
}

export function aspectRatioValue(aspect: H3Aspect): number {
  const [w, h] = aspect.split(":").map(Number);
  return w / h;
}

/**
 * Width and height for a short edge and an aspect, snapped to 32. The long edge
 * is capped at 1344 so the 768 preset lands on the model's native 768×1344
 * instead of an untrained 1376.
 */
export function h3Dimensions(
  shortEdge: number,
  aspect: H3Aspect,
): { width: number; height: number } {
  const ratio = aspectRatioValue(aspect);
  const landscape = ratio >= 1;
  const longEdge = Math.min(1344, snap32(shortEdge * (landscape ? ratio : 1 / ratio)));
  const short = snap32(shortEdge);
  return landscape ? { width: longEdge, height: short } : { width: short, height: longEdge };
}

function clamp(value: unknown, min: number, max: number, fallback: number): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function pick<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === "string" && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : fallback;
}

/** A model filename as ComfyUI lists it — the same grammar the pod's downloader
 *  enforces, so nothing reaches a graph that the downloader could not have written. */
export function isSafeModelName(name: string): boolean {
  return sanitizePodFilename(name) === name;
}

/**
 * Coerce anything (a stored row, a form, a request) into settings the pod will
 * accept. Out-of-range numbers are clamped rather than rejected — the form's
 * controls are the real UX, this is the backstop that keeps a malformed request
 * from parking a $1.70/h pod on a 16384-pixel job.
 */
export function normalizeH3Settings(raw: Partial<H3VideoSettings>): H3VideoSettings {
  const d = DEFAULT_H3_SETTINGS;
  const L = H3_LIMITS;
  const mode = pick(raw.mode, ["text", "frames", "reference"] as const, d.mode);
  const checkpoint =
    typeof raw.checkpoint === "string" && isSafeModelName(raw.checkpoint)
      ? raw.checkpoint
      : defaultCheckpointFor(mode);
  const loras = (Array.isArray(raw.loras) ? raw.loras : [])
    .filter(
      (lora): lora is H3Lora =>
        Boolean(lora) && typeof lora.name === "string" && isSafeModelName(lora.name),
    )
    .slice(0, L.loras)
    .map((lora) => ({
      name: lora.name,
      strength: clamp(lora.strength, L.loraStrength.min, L.loraStrength.max, 1),
    }));
  const sparseAttention = pick(raw.sparseAttention, ["off", "sol-attn", "vsa"] as const, "off");
  return {
    mode,
    prompt: typeof raw.prompt === "string" ? raw.prompt.slice(0, 7000) : "",
    checkpoint,
    loras,
    turbo: raw.turbo ?? d.turbo,
    width: snap32(clamp(raw.width, L.dimension.min, L.dimension.max, d.width)),
    height: snap32(clamp(raw.height, L.dimension.min, L.dimension.max, d.height)),
    durationSeconds: clamp(
      raw.durationSeconds,
      L.durationSeconds.min,
      L.durationSeconds.max,
      d.durationSeconds,
    ),
    steps: Math.round(clamp(raw.steps, L.steps.min, L.steps.max, d.steps)),
    sampler: pick(raw.sampler, H3_SAMPLERS, d.sampler),
    scheduler: pick(raw.scheduler, H3_SCHEDULERS, d.scheduler),
    shiftEnabled: raw.shiftEnabled ?? d.shiftEnabled,
    shiftVideo: clamp(raw.shiftVideo, L.shift.min, L.shift.max, d.shiftVideo),
    shiftAudio: clamp(raw.shiftAudio, L.shift.min, L.shift.max, d.shiftAudio),
    fastAttention: raw.fastAttention ?? d.fastAttention,
    sparseAttention,
    sparseValue:
      sparseAttention === "vsa"
        ? clamp(raw.sparseValue, L.sparseKeepPercent.min, L.sparseKeepPercent.max, 10)
        : clamp(raw.sparseValue, L.sparseTau.min, L.sparseTau.max, d.sparseValue),
    easyCache: raw.easyCache ?? d.easyCache,
    easyCacheThreshold: clamp(
      raw.easyCacheThreshold,
      L.easyCacheThreshold.min,
      L.easyCacheThreshold.max,
      d.easyCacheThreshold,
    ),
    seed:
      typeof raw.seed === "number" && Number.isInteger(raw.seed) && raw.seed >= 0
        ? Math.min(raw.seed, Number.MAX_SAFE_INTEGER)
        : -1,
    audio: raw.audio ?? d.audio,
    referenceSize: pick(raw.referenceSize, ["match", "max"] as const, d.referenceSize),
    interpolate: raw.interpolate === true,
    upscale: raw.upscale === true,
  };
}

/**
 * The prompt H3 reads in reference mode. The composer tags references the way
 * the API tab does — `@image1`, inserted from a dropdown of thumbnails — and
 * H3's text encoder knows them as `<Picture 1>` (the official r2v template's
 * own wording). Translated here, at the graph, so the stored prompt keeps the
 * tags the user typed and Reproduce shows them highlighted again. A literal
 * `<Picture N>` typed by hand passes through untouched.
 */
export function h3ReferencePrompt(prompt: string): string {
  return prompt.replace(/@image\s?(\d+)\b/gi, (_, n: string) => `<Picture ${Number(n)}>`);
}

/**
 * Why a reference-mode prompt cannot run, or null. A tag past the attached
 * references (`@image3` with two) is refused rather than renumbered — the
 * same rule as the API tab (see grok-prompt.ts): silently re-pointing part of
 * someone's prompt is worse than refusing to run it.
 */
export function h3ReferenceTagProblem(prompt: string, referenceCount: number): string | null {
  const bad = [...prompt.matchAll(/@image\s?(\d+)\b/gi)]
    .map((match) => Number(match[1]))
    .filter((n) => n < 1 || n > referenceCount);
  if (bad.length === 0) return null;
  return `@image${bad[0]} has no matching reference (${referenceCount} attached)`;
}

/** Images already uploaded to the pod's input/ folder, by ComfyUI filename. */
export type H3Inputs = {
  firstFrame?: string;
  lastFrame?: string;
  references?: string[];
};

type Node = { class_type: string; inputs: Record<string, unknown> };

/**
 * The API-format prompt for one H3 job. `seed` must already be resolved
 * (not -1): the caller stores it on the row so the result can be reproduced.
 */
export function buildH3VideoWorkflow(
  settings: H3VideoSettings,
  inputs: H3Inputs,
  options: { seed: number; filenamePrefix: string },
): Record<string, Node> {
  const s = settings;
  const graph: Record<string, Node> = {};
  graph.unet = {
    class_type: "UNETLoader",
    inputs: { unet_name: s.checkpoint, weight_dtype: "default" },
  };
  let model: [string, number] = ["unet", 0];

  const loras = [...s.loras];
  if (s.turbo) {
    loras.unshift({
      name: s.mode === "reference" ? H3_BASE_FILES.turboRef2v : H3_BASE_FILES.turboFl2v,
      strength: 1,
    });
  }
  loras.forEach((lora, index) => {
    const id = `lora_${index}`;
    graph[id] = {
      class_type: "LoraLoaderModelOnly",
      inputs: { model, lora_name: lora.name, strength_model: lora.strength },
    };
    model = [id, 0];
  });

  if (s.shiftEnabled) {
    graph.shift = {
      class_type: "MiniMaxH3SigmaShift",
      inputs: { model, shift_video: s.shiftVideo, shift_audio: s.shiftAudio },
    };
    model = ["shift", 0];
  }
  if (s.fastAttention) {
    graph.attention = {
      class_type: "ModelAttentionBackend",
      inputs: { model, attention: "comfy kitchen attention" },
    };
    model = ["attention", 0];
  }
  if (s.sparseAttention !== "off") {
    const valueKey = s.sparseAttention === "vsa" ? "keep_percent" : "tau";
    graph.sparse = {
      class_type: "BlockSparseAttention",
      inputs: {
        model,
        selection: s.sparseAttention,
        [`selection.${valueKey}`]: s.sparseValue,
        start_percent: 0.2,
        end_percent: 1,
        dense_blocks: "",
        min_tokens: 12288,
        extra_tokens: 256,
        sink_conditioning: "exact_kv_and_rows",
        verbose: false,
      },
    };
    model = ["sparse", 0];
  }
  if (s.easyCache) {
    graph.easy_cache = {
      class_type: "EasyCache",
      inputs: {
        model,
        reuse_threshold: s.easyCacheThreshold,
        start_percent: 0.15,
        end_percent: 0.95,
        verbose: false,
      },
    };
    model = ["easy_cache", 0];
  }

  graph.clip = {
    class_type: "CLIPLoader",
    inputs: {
      clip_name: H3_BASE_FILES.textEncoder,
      type: "minimax",
      device: "default",
    },
  };
  graph.video_vae = { class_type: "VAELoader", inputs: { vae_name: H3_BASE_FILES.videoVae } };
  graph.audio_vae = { class_type: "VAELoader", inputs: { vae_name: H3_BASE_FILES.audioVae } };

  const length = h3FrameCount(s.durationSeconds);
  // The mode's conditioning node at a given size. Upscale builds it twice —
  // once at half size for the first pass, once at full size for the refine —
  // because a frame guide or a reference is encoded at the latent's size.
  const conditioningAt = (id: string, width: number, height: number) => {
    if (s.mode === "reference") {
      const conditioning: Record<string, unknown> = {
        clip: ["clip", 0],
        vae: ["video_vae", 0],
        audio_vae: ["audio_vae", 0],
        prompt: h3ReferencePrompt(s.prompt),
        width,
        height,
        length,
        ref_image_size: s.referenceSize,
      };
      (inputs.references ?? []).slice(0, H3_LIMITS.references).forEach((filename, index) => {
        graph[`reference_${index}`] = { class_type: "LoadImage", inputs: { image: filename } };
        conditioning[`ref_images.ref_image_${index}`] = [`reference_${index}`, 0];
      });
      graph[id] = { class_type: "MiniMaxH3ReferenceToVideo", inputs: conditioning };
      return;
    }
    const conditioning: Record<string, unknown> = {
      clip: ["clip", 0],
      vae: ["video_vae", 0],
      prompt: s.prompt,
      width,
      height,
      length,
    };
    if (s.mode === "frames") {
      for (const key of ["firstFrame", "lastFrame"] as const) {
        const filename = inputs[key];
        if (!filename) continue;
        const frameId = key === "firstFrame" ? "first_frame" : "last_frame";
        graph[frameId] = { class_type: "LoadImage", inputs: { image: filename } };
        conditioning[frameId] = [frameId, 0];
      }
    }
    graph[id] = { class_type: "MiniMaxH3ImageToVideo", inputs: conditioning };
  };
  const half = (value: number) => Math.max(256, Math.round(value / 2 / 32) * 32);
  conditioningAt(
    "conditioning",
    s.upscale ? half(s.width) : s.width,
    s.upscale ? half(s.height) : s.height,
  );

  graph.noise = { class_type: "RandomNoise", inputs: { noise_seed: options.seed } };
  graph.sampler = { class_type: "KSamplerSelect", inputs: { sampler_name: s.sampler } };
  graph.scheduler = {
    class_type: "BasicScheduler",
    inputs: { model, scheduler: s.scheduler, steps: s.steps, denoise: 1 },
  };
  // H3 is guidance-free: the official graphs use BasicGuider, not CFG.
  graph.guider = {
    class_type: "BasicGuider",
    inputs: { model, conditioning: ["conditioning", 0] },
  };
  graph.sample = {
    class_type: "SamplerCustomAdvanced",
    inputs: {
      noise: ["noise", 0],
      guider: ["guider", 0],
      sampler: ["sampler", 0],
      sigmas: ["scheduler", 0],
      latent_image: ["conditioning", 1],
    },
  };
  let final: [string, number] = ["sample", 0];
  if (s.upscale) {
    // LBH-123's two-pass recipe (their i2v example workflow): split the A/V
    // latent, upscale the video half with the trained 3D model, rejoin the
    // audio, and re-denoise the top of the schedule at full size.
    graph.split_av = { class_type: "LTXVSeparateAVLatent", inputs: { av_latent: ["sample", 0] } };
    graph.upscale_latent = {
      class_type: "MinimaxH3LatentUpscaler3D",
      inputs: {
        latent: ["split_av", 0],
        model_name: H3_EXTRA_FILES.latentUpscaler,
        mode: "target dimensions",
        "mode.width": s.width,
        "mode.height": s.height,
        align: 32,
        enable_temporal_chunking: true,
        force_unload: true,
        device: "cuda",
        precision: "fp16",
      },
    };
    graph.join_av = {
      class_type: "LTXVConcatAVLatent",
      inputs: { video_latent: ["upscale_latent", 0], audio_latent: ["split_av", 1] },
    };
    conditioningAt("conditioning_full", s.width, s.height);
    graph.guider_full = {
      class_type: "BasicGuider",
      inputs: { model, conditioning: ["conditioning_full", 0] },
    };
    graph.sigmas_refine = {
      class_type: "ManualSigmas",
      inputs: { sigmas: "0.9035, 0.6316, 0.3158, 0.0000" },
    };
    graph.sample_refine = {
      class_type: "SamplerCustomAdvanced",
      inputs: {
        noise: ["noise", 0],
        guider: ["guider_full", 0],
        sampler: ["sampler", 0],
        sigmas: ["sigmas_refine", 0],
        latent_image: ["join_av", 0],
      },
    };
    final = ["sample_refine", 0];
  }
  graph.decode = {
    class_type: "VAEDecode",
    inputs: { samples: final, vae: ["video_vae", 0] },
  };
  let frames: [string, number] = ["decode", 0];
  if (s.interpolate) {
    graph.interp_model = {
      class_type: "FrameInterpolationModelLoader",
      inputs: { model_name: H3_EXTRA_FILES.rife },
    };
    graph.interpolate = {
      class_type: "FrameInterpolate",
      inputs: { interp_model: ["interp_model", 0], images: frames, multiplier: 2 },
    };
    frames = ["interpolate", 0];
  }
  const video: Record<string, unknown> = {
    images: frames,
    fps: s.interpolate ? H3_FPS * 2 : H3_FPS,
  };
  if (s.audio) {
    graph.decode_audio = {
      class_type: "VAEDecodeAudio",
      inputs: { samples: final, vae: ["audio_vae", 0] },
    };
    video.audio = ["decode_audio", 0];
  }
  graph.video = { class_type: "CreateVideo", inputs: video };
  graph.save = {
    class_type: "SaveVideo",
    inputs: {
      video: ["video", 0],
      filename_prefix: options.filenamePrefix,
      format: "mp4",
      "format.codec": "h264",
    },
  };
  return graph;
}

/**
 * Which part of the job a node of {@link buildH3VideoWorkflow} belongs to, for
 * the lightbox's "where the time went" breakdown. Keyed by the node ids above,
 * which are fixed — rename one there and its time lands in "Other" here.
 *
 * ComfyUI loads weights lazily: the loaders only read files, and moving them
 * onto the GPU happens in the first node that uses them — the text encoder in
 * conditioning, the diffusion model in sampling.
 */
export function h3NodeStage(nodeId: string): { key: string; label: string } {
  if (/^(unet|lora_\d+|clip|video_vae|audio_vae|interp_model)$/.test(nodeId)) {
    return { key: "load", label: "Loading model files" };
  }
  if (
    /^(shift|attention|sparse|easy_cache|noise|sampler|scheduler|guider|guider_full|sigmas_refine)$/.test(
      nodeId,
    )
  ) {
    return { key: "setup", label: "Model patches and sampler setup" };
  }
  if (/^(conditioning|conditioning_full|reference_\d+|first_frame|last_frame)$/.test(nodeId)) {
    return { key: "encode", label: "Encoding the prompt and images" };
  }
  if (nodeId === "sample") return { key: "sample", label: "Sampling" };
  if (/^(split_av|upscale_latent|join_av)$/.test(nodeId)) {
    return { key: "upscale", label: "Latent upscale 2×" };
  }
  if (nodeId === "sample_refine") return { key: "refine", label: "Refine pass" };
  if (nodeId === "decode") return { key: "decode", label: "Decoding frames (VAE)" };
  if (nodeId === "decode_audio") return { key: "decode_audio", label: "Decoding audio" };
  if (nodeId === "interpolate") return { key: "interpolate", label: "Frame interpolation (RIFE)" };
  if (nodeId === "video" || nodeId === "save") return { key: "mux", label: "Writing the MP4" };
  return { key: "other", label: "Other" };
}
