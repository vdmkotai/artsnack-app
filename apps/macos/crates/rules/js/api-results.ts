/**
 * The API results grid's reading of a `grokGenerations` row, for the native app.
 *
 * On the web the grid and its lightbox read rows through
 * apps/web/components/api/generation-meta.ts (badge, price, provider) and
 * generation-details.tsx (the details sidebar); the rules underneath are all in
 * packages/shared. This module calls the same helpers and returns plain JSON —
 * labels, prices and rows of details — which the native side draws and caches
 * per row. It needs the Atlas catalogue (an Atlas row's badge is its catalogue
 * label, and an estimate is re-priced by the current formula), so it is bundled
 * into the composer's worker (composer.ts), not the UI-thread bundle.
 */
import {
  badgeOf,
  effectiveCostUsd,
  grokImageWireOf,
  isSelfHostedVideo,
  outputKeys,
  priceOf,
  priceOfGeneration,
  providerOf,
  qualityLabelOf,
  type GenerationDoc,
} from "../../../../web/components/api/generation-meta";
import { API_MODELS } from "../../../../../packages/shared/api-models";
import {
  SEEDANCE_DRAFT_LIFETIME_MS,
  atlasDraftCompletion,
  atlasDraftCompletionUsd,
  isCompletableDraft,
} from "../../../../../packages/shared/atlas-drafts";
import { formatPrice, formatUsd } from "../../../../../packages/shared/api-pricing";
import {
  formatDurationMs,
  outputKeyTimestamp,
  summarizeComfyRun,
} from "../../../../../packages/shared/comfy-run-stats";
import { describeFailure } from "../../../../../packages/shared/failure-message";
import { isGrokSourceVideoKey } from "../../../../../packages/shared/image-key";
import {
  H3_FPS,
  H3_MODES,
  h3FrameCount,
  h3NodeStage,
  normalizeH3Settings,
} from "../../../../../packages/shared/h3-video";
import {
  LTX_KNOWN_CHECKPOINTS,
  ltxFrameCount,
  ltxUsesDistilledSigmas,
  normalizeLtxSettings,
} from "../../../../../packages/shared/ltx-video";

type Row = GenerationDoc;

/** `comfyVideo:runDetails`: what a self-hosted clip ran on. */
type RunDetails = {
  gpuType: string;
  gpuName?: string;
  gpuCount: number;
  gpuIndex?: number;
  cloudType: string;
  hourlyUsd: number;
  podId?: string;
};

/** One line of the details panel: label left, value right. */
type DetailRow = {
  label: string;
  value: string;
  /** Muted text after the value, e.g. "× 0.8". */
  note?: string;
  mono?: boolean;
  /** Offered with a Copy button, e.g. the seed. */
  copy?: string;
};

/** A row's tile labels: what the badge and the viewer show, and what it cost. */
function rowMeta(row: Row) {
  const provider = providerOf(row);
  const price = priceOf(row);
  const tag = priceOfGeneration(row);
  return {
    badge: badgeOf(row),
    // ResultBadge marks an estimate only for providers that bill per job.
    price: price === null ? null : `${provider !== "grok" && row.costEstimated ? "≈" : ""}${price}`,
    // The viewer's PriceTag marks any estimate that is not the subscription.
    priceTag:
      tag === null
        ? null
        : `${row.costEstimated && tag.currency !== "included" ? "≈" : ""}${formatPrice(tag)}`,
    costUsd: effectiveCostUsd(row) ?? null,
    failure: row.status === "failed" ? describeFailure(row.error) : null,
    draft: draftMeta(row),
    // "Edit/Extend with Grok" is offered on a finished clip Grok can fetch.
    grokSourceKey: grokSourceKeyOf(row),
  };
}

function grokSourceKeyOf(row: Row): string | null {
  if (row.mediaType !== "video" || row.status !== "completed") return null;
  const key = outputKeys(row)[0];
  return key && isGrokSourceVideoKey(key) ? key : null;
}

/**
 * "Finish in 1080p" for a Seedance 2.5 draft. The request is built against a
 * creation time far enough back to never expire here; the native side checks
 * `expiresAt` against its own clock when the action runs, since a row's labels
 * are cached for as long as the row does not change.
 */
function draftMeta(row: Row) {
  if (!isCompletableDraft(row)) return null;
  const request = atlasDraftCompletion(row, row._creationTime);
  if (!request) return null;
  return {
    ...request,
    usd: atlasDraftCompletionUsd(row),
    expiresAt: row._creationTime + SEEDANCE_DRAFT_LIFETIME_MS,
  };
}

/** `rowMeta` for many rows in one call: one message to the worker per page. */
export function rowsMeta(rows: Row[]) {
  return rows.map(rowMeta);
}

/** The registry's models in the web's chip order, with their badges. */
export function modelChips() {
  return Object.values(API_MODELS).map((model) => ({ id: model.id, badge: model.badge }));
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** `Intl.DateTimeFormat` medium date and short time, which QuickJS lacks. */
function formatCreated(millis: number): string {
  const date = new Date(millis);
  const hours = date.getHours();
  const minutes = String(date.getMinutes()).padStart(2, "0");
  return `${MONTHS[date.getMonth()]} ${date.getDate()}, ${date.getFullYear()}, ${hours % 12 || 12}:${minutes} ${hours < 12 ? "AM" : "PM"}`;
}

/**
 * `generationReferences` in reference-thumb.tsx: the input images and their
 * labels. `key` is the stored copy the image is shown from; `sourceKey` the
 * output it was taken from, when it was one — what finds its generation.
 */
function references(row: Row) {
  const roles = row.h3InputRoles;
  let picture = 0;
  return (row.referenceB2Keys ?? []).map((key, index) => {
    const role = roles?.[index];
    const label =
      role === "first"
        ? "First frame"
        : role === "last"
          ? "Last frame"
          : role === "reference"
            ? `Picture ${++picture}`
            : `Reference ${index + 1}`;
    return { key, sourceKey: row.referenceSourceKeys?.[index] ?? null, label };
  });
}

/** `TimingSection`: where the time went, click to file in storage. */
function timing(row: Row) {
  const stats = row.comfyRun;
  // Rows finished before `completedAt` existed still have the upload time in
  // their output key, which is close enough for a total.
  const completedAt = row.completedAt ?? outputKeyTimestamp(outputKeys(row)[0]);
  const summary = summarizeComfyRun({ createdAt: row.createdAt, completedAt, stats }, h3NodeStage);
  if (summary.totalMs === undefined && summary.phases.length === 0) return null;
  const approximate = row.completedAt === undefined;
  const phaseTotal = summary.phases.reduce((total, phase) => total + phase.ms, 0);
  const render = summary.phases.find((phase) => phase.key === "render");
  const stageTotal = summary.stages.reduce((total, stage) => total + stage.ms, 0);
  const stageScale = Math.max(render?.ms ?? 0, stageTotal, 1);
  const notes: string[] = [];
  if (stats?.cachedNodes?.includes("unet")) {
    notes.push("The model stayed loaded from the previous clip, so nothing was read from disk.");
  }
  if (isSelfHostedVideo(row) && !stats) {
    notes.push("A per-stage breakdown is recorded for clips rendered from this version on.");
  }
  return {
    totalLabel: approximate ? "Total, from the upload time" : "Total time",
    total:
      summary.totalMs === undefined
        ? null
        : `${approximate ? "≈ " : ""}${formatDurationMs(summary.totalMs)}`,
    phases: summary.phases.map((phase) => ({
      key: phase.key,
      label: phase.label,
      duration: formatDurationMs(phase.ms),
      share: phaseTotal > 0 ? phase.ms / phaseTotal : 0,
    })),
    stages: summary.stages.map((stage) => ({
      label: stage.label,
      detail: stage.steps
        ? `${stage.steps} steps · ${(stage.ms / stage.steps / 1000).toFixed(1)} s/step`
        : null,
      duration: formatDurationMs(stage.ms),
      share: stage.ms / stageScale,
    })),
    notes,
  };
}

/** `GpuSection`: the card, the pod and what the render cost on it. */
function gpuRows(row: Row, pod: RunDetails | null): DetailRow[] | null {
  const stats = row.comfyRun;
  const gpuName = stats?.gpuName ?? pod?.gpuType;
  if (!gpuName && !pod) return null;
  const rows: DetailRow[] = [];
  if (gpuName) rows.push({ label: "Card", value: gpuName });
  if (stats?.vramBytes !== undefined) {
    rows.push({ label: "VRAM", value: `${Math.round(stats.vramBytes / 1024 ** 3)} GB` });
  }
  if (pod && pod.gpuCount > 1) {
    rows.push({
      label: "On the pod",
      value:
        pod.gpuIndex !== undefined
          ? `GPU ${pod.gpuIndex + 1} of ${pod.gpuCount}`
          : `${pod.gpuCount} GPUs`,
    });
  }
  if (pod) {
    rows.push({
      label: "Pod",
      value: `RunPod · ${pod.cloudType === "SECURE" ? "Secure" : "Community"} · ${formatUsd(pod.hourlyUsd)}/h`,
    });
  }
  const renderMs =
    stats?.executionStartedAt !== undefined && stats.executionEndedAt !== undefined
      ? Math.max(0, stats.executionEndedAt - stats.executionStartedAt)
      : undefined;
  if (renderMs !== undefined && pod) {
    const perGpuHourly = pod.hourlyUsd / Math.max(1, pod.gpuCount);
    rows.push({
      label: "Render cost",
      value: `≈ ${formatUsd((renderMs / 3_600_000) * perGpuHourly)}`,
    });
  }
  const software = [
    stats?.comfyuiVersion && `ComfyUI ${stats.comfyuiVersion}`,
    stats?.pytorchVersion && `PyTorch ${stats.pytorchVersion}`,
  ].filter(Boolean);
  if (software.length > 0) rows.push({ label: "Software", value: software.join(" · ") });
  if (pod?.podId) rows.push({ label: "Pod id", value: pod.podId, mono: true });
  return rows;
}

function stripExtension(name: string): string {
  return name.replace(/\.safetensors$/, "");
}

function loraRows(loras: { name: string; strength: number }[]): DetailRow[] {
  return loras.map((lora, index) => ({
    label: index === 0 ? "LoRAs" : "",
    value: stripExtension(lora.name),
    note: `× ${lora.strength}`,
  }));
}

/** `H3SettingsSection`. */
function h3Rows(row: Row): DetailRow[] {
  if (!row.h3Settings) return [];
  const s = normalizeH3Settings(row.h3Settings);
  const seed = String(row.h3Settings.seed);
  const rows: DetailRow[] = [
    { label: "Mode", value: H3_MODES.find((mode) => mode.value === s.mode)?.label ?? s.mode },
    { label: "Model", value: stripExtension(s.checkpoint) },
    ...loraRows(s.loras),
    { label: "Turbo", value: s.turbo ? "On (official turbo LoRA)" : "Off" },
    {
      label: "Resolution",
      value: `${s.width}×${s.height}`,
      note: s.upscale ? "(rendered at half, upscaled 2×)" : undefined,
    },
    {
      label: "Duration",
      value: `${s.durationSeconds} s · ${h3FrameCount(s.durationSeconds)} frames · ${s.interpolate ? H3_FPS * 2 : H3_FPS} fps`,
    },
    { label: "Steps", value: String(s.steps) },
    { label: "Sampler", value: `${s.sampler} · ${s.scheduler}` },
    { label: "Seed", value: seed, copy: seed },
    {
      label: "Sigma shift",
      value: s.shiftEnabled ? `Video ${s.shiftVideo} · audio ${s.shiftAudio}` : "Model default",
    },
    {
      label: "Attention",
      value:
        (s.fastAttention ? "INT8 (Comfy Kitchen)" : "Standard") +
        (s.sparseAttention !== "off"
          ? ` · ${s.sparseAttention === "vsa" ? `VSA ${s.sparseValue}%` : `SOL τ ${s.sparseValue}`}`
          : ""),
    },
    { label: "EasyCache", value: s.easyCache ? `On · ${s.easyCacheThreshold}` : "Off" },
  ];
  if (s.mode === "reference") {
    rows.push({
      label: "Reference size",
      value: s.referenceSize === "max" ? "Max (2048 px)" : "Match",
    });
  }
  rows.push({ label: "Audio", value: s.audio ? "On" : "Off" });
  if (s.interpolate) rows.push({ label: "Interpolation", value: "RIFE · 48 fps" });
  if (s.upscale) rows.push({ label: "Upscale", value: "Latent 2× + 3-step refine" });
  return rows;
}

const LTX_MODE_LABELS = {
  text: "Text → video",
  frames: "Image → video",
  sheet: "Reference sheet",
} as const;

/** `LtxSettingsSection`. */
function ltxRows(row: Row): DetailRow[] {
  if (!row.ltxSettings) return [];
  const s = normalizeLtxSettings(row.ltxSettings);
  const seed = String(row.ltxSettings.seed);
  const sheet = s.mode === "sheet";
  const twoPass = s.twoPass && !sheet;
  const rows: DetailRow[] = [
    { label: "Model", value: `LTX 2.3 · ${LTX_MODE_LABELS[s.mode]}` },
    {
      label: "Checkpoint",
      value: LTX_KNOWN_CHECKPOINTS[s.checkpoint]?.label ?? stripExtension(s.checkpoint),
    },
    ...loraRows(s.loras),
  ];
  if (sheet) rows.push({ label: "Sheet strength", value: String(s.sheetStrength ?? 1) });
  rows.push(
    {
      label: "Resolution",
      value: `${s.width}×${s.height}`,
      note: twoPass ? "(rendered at half, upscaled 2×)" : undefined,
    },
    {
      label: "Duration",
      value: `${s.durationSeconds} s · ${ltxFrameCount(s.durationSeconds, s.fps)} frames · ${s.fps} fps`,
    },
    {
      label: "Steps",
      value:
        (ltxUsesDistilledSigmas(s) ? "8 · distilled schedule" : `${s.steps} · LTXV scheduler`) +
        (twoPass ? " + 3-step refine" : ""),
    },
    { label: "CFG", value: String(s.cfg) },
    { label: "Seed", value: seed, copy: seed },
  );
  if (s.mode === "frames") {
    rows.push({
      label: "Image",
      value: `Strength ${s.imageStrength} · compression ${s.imageCompression}`,
    });
  }
  rows.push({ label: "Audio", value: s.audio ? "On" : "Off" });
  if (s.cfg > 1 && s.negativePrompt.trim())
    rows.push({ label: "Negative", value: s.negativePrompt });
  return rows;
}

const PROVIDER_LABELS: Record<ReturnType<typeof providerOf>, string> = {
  grok: "Grok",
  fal: "fal.ai",
  higgsfield: "Higgsfield",
  atlas: "Atlas Cloud",
};

/** An Atlas parameter worth a line: short scalars, not prompts or image lists. */
function atlasValue(value: unknown): string | null {
  if (typeof value === "boolean") return value ? "On" : "Off";
  if (typeof value === "number") return String(value);
  if (typeof value === "string" && value && value.length <= 48 && !/^https?:/.test(value)) {
    return value;
  }
  return null;
}

/** `ApiSettingsSection`. */
function apiRows(row: Row): DetailRow[] {
  const rows: DetailRow[] = [
    { label: "Provider", value: PROVIDER_LABELS[providerOf(row)] },
    { label: "Model", value: badgeOf(row) },
  ];
  if (row.endpoint) rows.push({ label: "Endpoint", value: row.endpoint, mono: true });
  if (row.aspectRatio) rows.push({ label: "Aspect ratio", value: row.aspectRatio });
  const grokImageWire = grokImageWireOf(row);
  if (grokImageWire) rows.push({ label: "Image model", value: grokImageWire, mono: true });
  if (row.grokVideoModel)
    rows.push({ label: "Video model", value: row.grokVideoModel, mono: true });
  if (row.resolution) rows.push({ label: "Resolution", value: row.resolution });
  if (row.duration !== undefined) rows.push({ label: "Duration", value: `${row.duration} s` });
  const quality = qualityLabelOf(row);
  if (quality) rows.push({ label: "Quality", value: quality });
  if (row.videoTier) rows.push({ label: "Tier", value: row.videoTier });
  if (row.videoMode) rows.push({ label: "Mode", value: row.videoMode });
  if (row.videoJobType) rows.push({ label: "Job type", value: row.videoJobType });
  if (row.generateAudio !== undefined) {
    rows.push({ label: "Audio", value: row.generateAudio ? "On" : "Off" });
  }
  if ((row.count ?? 1) > 1) rows.push({ label: "Images", value: String(row.count) });
  for (const [key, raw] of Object.entries(row.atlasParams ?? {})) {
    if (/prompt/i.test(key)) continue;
    const value = atlasValue(raw);
    if (value !== null) rows.push({ label: key, value });
  }
  const price = priceOf(row);
  if (price !== null) {
    rows.push({
      label: "Cost",
      value: `${row.costEstimated && price.startsWith("$") ? "≈ " : ""}${price}`,
    });
  }
  return rows;
}

/**
 * `GenerationDetailsView`: everything the viewer's details panel shows for a
 * row but its prompt. `pod` is `comfyVideo:runDetails` (self-hosted rows only).
 */
export function details(row: Row, pod: RunDetails | null) {
  const selfHosted = isSelfHostedVideo(row);
  return {
    badge: badgeOf(row),
    created: formatCreated(row.createdAt),
    selfHosted,
    references: references(row),
    referencesMissing: !!row.hasReferenceImage && (row.referenceB2Keys ?? []).length === 0,
    timing: timing(row),
    gpu: selfHosted ? gpuRows(row, pod) : null,
    settings: selfHosted ? (row.ltxSettings ? ltxRows(row) : h3Rows(row)) : apiRows(row),
  };
}
