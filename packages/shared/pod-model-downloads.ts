/**
 * Model files on a ComfyUI pod: where they live, what they may be called, and
 * what the pod's downloader reports about them.
 *
 * Three parties have to agree on these rules: the web UI, the Convex actions
 * that read the pod, and the downloader on the pod itself (which re-validates
 * everything, because it is reachable over the public RunPod proxy). This
 * module is the agreement — the directory names, the filename grammar and the
 * manifest line format live here once, and the pod's Python re-states the same
 * rules by hand (see infra/provision.sh, install_artsnack_downloader).
 */

/** The only model directories a pod will write into. `diffusion_models` holds
 *  UNet-only checkpoints (MiniMax H3), whose text encoder and VAE are separate
 *  files, so CheckpointLoaderSimple cannot load them from `checkpoints/`. */
export type PodModelDir = "checkpoints" | "loras" | "diffusion_models";

/** Which pod a model belongs on. Image is today's SDXL pod; video is the
 *  MiniMax H3 pod provision.sh builds under ARTSNACK_PROFILE=video. */
export type PodProfile = "image" | "video";

/** The two model families the video pod runs. */
export type VideoFamily = "h3" | "ltx";

/**
 * Best guess from a filename alone, for files the app has no record of (put on
 * the pod by hand, or by an older build). Null = unknown: listed for both.
 */
export function guessVideoFamily(filename: string): VideoFamily | null {
  if (/ltx/i.test(filename)) return "ltx";
  if (/minimax|\bh3|_h3|h3_|mmh3/i.test(filename)) return "h3";
  return null;
}

/**
 * A filename the pod will accept: a single path segment with a model-weights
 * extension, made of the characters the existing manifest already uses (spaces,
 * dots, brackets, parentheses included). The first character must be a word
 * character so ".hidden" and "-flag" shapes are impossible. Everything else —
 * slashes, backslashes, control characters, `..` tricks — parses as null here
 * and is rejected again on the pod.
 */
const FILENAME_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9 ._()[\]-]{0,190}\.(safetensors|ckpt|pt)$/;

export function sanitizePodFilename(name: string): string | null {
  const trimmed = name.trim();
  if (!FILENAME_PATTERN.test(trimmed)) return null;
  if (trimmed.includes("..")) return null;
  return trimmed;
}

/** One provisioning-manifest line: `dir|url|filename`. */
export function podManifestLine(dir: PodModelDir, url: string, filename: string): string {
  return `${dir}|${url}|${filename}`;
}

/**
 * What the pod's downloader reports about one job. These live here — not in
 * the Convex module — because they are wire shapes of the pod node's JSON, i.e.
 * part of the three-party agreement, and because the web app should not import
 * server modules for types (`_generated` is its contract with the backend; this
 * module is its contract with the pod).
 */
export interface PodDownloadJob {
  filename: string;
  dir: string;
  status: "downloading" | "done" | "error";
  bytes: number;
  expected_bytes: number | null;
  error: string | null;
  started_at: number;
}

export interface PodDownloadsStatus {
  jobs: PodDownloadJob[];
  disk: { free_gb: number; total_gb: number } | null;
  /** Reported by downloader v4+; absent means an image pod. */
  profile?: PodProfile;
}
