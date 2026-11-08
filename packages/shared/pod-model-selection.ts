/**
 * Choosing which models a new pod downloads.
 *
 * provision.sh downloads its whole manifest on every cold boot — on the image
 * pod, its checkpoints and LoRAs plus any rows added to the app's own manifest.
 * The launch dialog lists the lines a pod can do without and sends back the
 * ones the user unchecked; the launch action hands them to the pod as
 * ARTSNACK_SKIP_MODELS_B64, and provision.sh drops exactly those lines before
 * it downloads anything.
 *
 * A skip list rather than a pick list, on purpose: a model added to the
 * published script or the app's manifest after the dialog was opened was never
 * shown, so it was never unchecked — it downloads, as it always did.
 *
 * Which lines are optional is stated twice: here (what the dialog offers) and
 * in provision.sh's `without_skipped` calls (what the pod honours). Change one,
 * change both. The pod side is the one that matters — a stale or hand-made
 * skip list still cannot remove a Face Fix detector or the H3 base set.
 */

import { H3_EXTRA_FILES } from "./h3-video";
import { LTX_BASE_FILES } from "./ltx-video";
import type { PodProfile } from "./pod-model-downloads";

/** The pod's environment variable: base64 of one `dir|filename` per line. */
export const SKIP_MODELS_ENV = "ARTSNACK_SKIP_MODELS_B64";

/** A bound on the variable's size, far above any real manifest. */
export const MAX_SKIP_MODELS = 1000;

export interface PodModelOption {
  /** `dir|filename` — the identity provision.sh dedupes and skips on. */
  key: string;
  dir: string;
  filename: string;
  label: string;
  /** The manifest section it sits under, or where the row came from. */
  group: string;
}

export interface PodModelGroup {
  title: string;
  models: PodModelOption[];
}

/** A `podModels` row, as the dynamic manifest serves it. */
export interface PodManifestRow {
  dir: string;
  filename: string;
  modelName?: string;
}

export function podModelKey(dir: string, filename: string): string {
  return `${dir}|${filename}`;
}

/** Directories whose lines the image pod may skip — its checkpoints and LoRAs.
 *  Everything else in its manifest (upscaler, Face Fix detectors) is
 *  infrastructure. provision.sh: `without_skipped '^(checkpoints|loras|diffusion_models)$'`. */
const IMAGE_OPTIONAL_DIRS = new Set(["checkpoints", "loras", "diffusion_models"]);

/** The video pod's static set is the H3 base set, required by every graph,
 *  plus the two small community add-ons below. provision.sh:
 *  `without_skipped '^(frame_interpolation|latent_upscale_models)$'` on
 *  VIDEO_MODELS; H3_EXTRA_MODELS (the fp8 builds on B300-class GPUs), the LTX
 *  set and the app's own rows are optional whole. */
const VIDEO_OPTIONAL_STATIC_DIRS = new Set(["frame_interpolation", "latent_upscale_models"]);

const H3_EXTRA_LABELS: Record<string, string> = {
  [H3_EXTRA_FILES.rife]: "Smooth 48 fps — RIFE frame interpolation",
  [H3_EXTRA_FILES.latentUpscaler]: "Upscale 2× — H3 latent upscaler",
};

const LTX_LABELS: Record<string, string> = {
  [LTX_BASE_FILES.gemma]: "Gemma 3 12B text encoder (fp8)",
  [LTX_BASE_FILES.textProjection]: "LTX 2.3 text projection",
  [LTX_BASE_FILES.videoVae]: "LTX 2.3 video VAE",
  [LTX_BASE_FILES.audioVae]: "LTX 2.3 audio VAE",
  [LTX_BASE_FILES.spatialUpscaler]: "LTX 2.3 spatial upscaler ×2",
  [LTX_BASE_FILES.checkpoint]: "LTX 2.3 distilled — official checkpoint (fp8, 25 GB)",
  [LTX_BASE_FILES.ingredients]:
    "Ingredients IC-LoRA — Reference sheet mode (1.3 GB, needs HF_TOKEN)",
};

const COMMUNITY_GROUP = "Community add-ons";
const LTX_GROUP = "LTX 2.3 (after ready, ~45 GB)";
const APP_GROUP = "Added to the app's manifest";

/** The body of `read -r -d '' NAME <<'TAG'` … `TAG`, or "" when absent. */
function heredoc(script: string, name: string): string {
  const lines = script.split("\n");
  const opener = new RegExp(`^read -r -d '' ${name} <<'?([A-Za-z0-9_]+)'?`);
  const start = lines.findIndex((line) => opener.test(line));
  if (start < 0) return "";
  const tag = opener.exec(lines[start])![1];
  const end = lines.indexOf(tag, start + 1);
  return lines.slice(start + 1, end < 0 ? undefined : end).join("\n");
}

/**
 * A manifest section header — `# ── Style LoRAs — SDXL (added …) ──` or
 * `# --- detail loras (batch added) ---` — as a short title, or null for an
 * ordinary comment. Dates, prefixes and a trailing sentence are notes for
 * whoever edits the script, not for the dialog.
 */
export function manifestSectionTitle(line: string): string | null {
  const match = /^#\s*(?:──|---)\s*(.*)$/.exec(line.trim());
  if (!match) return null;
  const title = match[1]
    .replace(/\s*(?:─+|-{3,})\s*$/, "")
    .replace(/\.\s.*$/, "")
    .replace(/\([^)]*\)/g, "")
    .replace(/\s*—\s*ACTIVE\b/, "")
    .replace(/[\s,;—-]+$/, "")
    .replace(/\s{2,}/g, " ")
    .trim();
  return title ? title.charAt(0).toUpperCase() + title.slice(1) : null;
}

function manifestLines(
  body: string,
  optional: (dir: string) => boolean,
  defaultGroup: string,
  withSections: boolean,
): PodModelOption[] {
  const options: PodModelOption[] = [];
  let group = defaultGroup;
  for (const raw of body.split("\n")) {
    const line = raw.trim();
    if (line.startsWith("#")) {
      if (withSections) group = manifestSectionTitle(line) ?? group;
      continue;
    }
    const fields = line.split("|");
    if (fields.length < 3) continue;
    const dir = fields[0].replace(/\s/g, "");
    const filename = fields.slice(2).join("|");
    if (!dir || !filename || !optional(dir)) continue;
    options.push({
      key: podModelKey(dir, filename),
      dir,
      filename,
      label:
        H3_EXTRA_LABELS[filename] ??
        LTX_LABELS[filename] ??
        filename.replace(/\.(safetensors|ckpt|pt|pth)$/i, ""),
      group,
    });
  }
  return options;
}

/**
 * Every model a new pod of this profile would download that the user may
 * leave out, grouped as the script groups them: the static manifest of the
 * provision.sh the pod will run, then the app's own rows (`/pod-manifest`).
 * First occurrence wins, as in provision.sh's dedupe.
 */
export function launchModelGroups(
  script: string,
  profile: PodProfile,
  rows: readonly PodManifestRow[],
): PodModelGroup[] {
  const options =
    profile === "video"
      ? [
          ...manifestLines(
            heredoc(script, "VIDEO_MODELS"),
            (dir) => VIDEO_OPTIONAL_STATIC_DIRS.has(dir),
            COMMUNITY_GROUP,
            false,
          ),
          ...manifestLines(heredoc(script, "H3_EXTRA_MODELS"), () => true, COMMUNITY_GROUP, false),
          ...manifestLines(heredoc(script, "LTX_MODELS"), () => true, LTX_GROUP, false),
        ]
      : manifestLines(
          heredoc(script, "MODELS"),
          (dir) => IMAGE_OPTIONAL_DIRS.has(dir),
          "Models",
          true,
        );
  for (const row of rows) {
    options.push({
      key: podModelKey(row.dir, row.filename),
      dir: row.dir,
      filename: row.filename,
      label: row.modelName?.trim() || row.filename.replace(/\.(safetensors|ckpt|pt)$/i, ""),
      group: APP_GROUP,
    });
  }

  const seen = new Set<string>();
  const groups: PodModelGroup[] = [];
  for (const option of options) {
    if (seen.has(option.key)) continue;
    seen.add(option.key);
    let group = groups.find((candidate) => candidate.title === option.group);
    if (!group) {
      group = { title: option.group, models: [] };
      groups.push(group);
    }
    group.models.push(option);
  }
  return groups;
}

/** `dir|filename`, one line's worth: no newline, no second separator. */
export function isPodModelKey(key: string): boolean {
  return /^[a-z_]+(?:\/[a-z_]+)?\|[^|\r\n]{1,255}$/.test(key);
}

/**
 * The value of ARTSNACK_SKIP_MODELS_B64, or undefined when nothing is skipped —
 * so a launch that keeps every model sets no variable at all and boots exactly
 * like one from before the dialog. Base64 because Vast drops multiline values.
 */
export function encodeSkipModels(keys: readonly string[]): string | undefined {
  const lines = [...new Set(keys)].filter(isPodModelKey);
  if (lines.length === 0) return undefined;
  const bytes = new TextEncoder().encode(lines.join("\n"));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}
