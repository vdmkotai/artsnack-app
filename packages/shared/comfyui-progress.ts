import type { GenerationProgressStage } from "./generation-progress";

export type ComfyProgressUpdate = {
  stage: GenerationProgressStage;
  message: string;
  current?: number;
  total?: number;
};

export type ComfyQueueState =
  | { state: "running" }
  | { state: "queued"; position: number }
  | { state: "missing" };

function text(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

/** Friendly names for the node classes shipped in the image and video workflows. */
export function comfyNodeLabel(classType: string, media: "image" | "video"): string {
  const type = classType.toLowerCase();
  if (type.includes("loader") || type.includes("load")) return "Loading models...";
  if (type.includes("sampler") || type.includes("ksampler")) {
    return media === "video" ? "Generating video frames..." : "Sampling image...";
  }
  if (type.includes("interpolat") || type.includes("rife")) return "Interpolating frames...";
  if (type.includes("upscale")) return "Upscaling frames...";
  if (type.includes("vaedecode") || (type.includes("vae") && type.includes("decode"))) {
    return media === "video" ? "Decoding frames..." : "Decoding image...";
  }
  if (type.includes("video") && (type.includes("combine") || type.includes("save"))) {
    return "Encoding video...";
  }
  if (type.includes("save")) return "Preparing output...";
  return "Running workflow...";
}

export function comfyNodeLabelsForWorkflow(
  workflow: Record<string, unknown>,
  media: "image" | "video",
): Record<string, string> {
  const labels: Record<string, string> = {};
  for (const [nodeId, raw] of Object.entries(workflow)) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const classType = text((raw as { class_type?: unknown }).class_type);
    if (classType) labels[nodeId] = comfyNodeLabel(classType, media);
  }
  return labels;
}

/** Parses only messages for this prompt. Unknown or binary messages are ignored. */
export function comfyProgressFromMessage(
  raw: unknown,
  promptId: string,
  nodeLabels: Record<string, string>,
  media: "image" | "video",
): ComfyProgressUpdate | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const envelope = raw as { type?: unknown; data?: unknown };
  const type = text(envelope.type);
  if (
    !type ||
    !envelope.data ||
    typeof envelope.data !== "object" ||
    Array.isArray(envelope.data)
  ) {
    return null;
  }
  const data = envelope.data as Record<string, unknown>;
  if (data.prompt_id !== promptId) return null;

  if (type === "execution_start") {
    return { stage: "generating", message: "Starting workflow..." };
  }
  if (type === "execution_success") {
    return { stage: "finalizing", message: "Collecting output..." };
  }
  if (type === "executing") {
    const node = text(data.node);
    if (!node) return null;
    return {
      stage: "generating",
      message: nodeLabels[node] ?? `Generating ${media}...`,
    };
  }
  if (type === "progress") {
    const node = text(data.node);
    const value = Number(data.value);
    const max = Number(data.max);
    if (!Number.isFinite(value) || !Number.isFinite(max) || max <= 0) return null;
    const current = Math.max(0, Math.min(max, value));
    const base =
      (node && nodeLabels[node]) ??
      (media === "video" ? "Generating video..." : "Sampling image...");
    return {
      stage: "generating",
      message: `${base.replace(/\.\.\.$/, "")} · ${Math.round(current)}/${Math.round(max)}`,
      current,
      total: max,
    };
  }
  return null;
}

/**
 * The progress columns a card renders, as `generations` and `grokGenerations`
 * both store them. Kept here rather than per table because the self-hosted
 * image and video pipelines write both through the same reporter.
 */
export type StoredProgress = {
  progressStage?: string;
  progressMessage?: string;
  progressCurrent?: number;
  progressTotal?: number;
  queuePosition?: number;
  providerStatus?: string;
};

const STORED_PROGRESS_FIELDS = [
  "progressStage",
  "progressMessage",
  "progressCurrent",
  "progressTotal",
  "queuePosition",
  "providerStatus",
] as const satisfies readonly (keyof StoredProgress)[];

/**
 * Whether writing `next` over `row` would change anything a card shows.
 *
 * A progress mutation replaces all six columns (an absent one is cleared), so
 * this compares all six: a report that drops the queue position or the step
 * counter is a change, the same report again is not. The timestamp written
 * beside them is deliberately not compared — see the progress mutations.
 */
export function progressChanged(row: StoredProgress, next: StoredProgress): boolean {
  return STORED_PROGRESS_FIELDS.some((field) => !Object.is(row[field], next[field]));
}

/** Least time between two progress writes from one WebSocket. */
export const COMFY_PROGRESS_MIN_INTERVAL_MS = 1_000;

function progressSignature(update: ComfyProgressUpdate): string {
  return `${update.stage}|${update.message}|${update.current ?? ""}|${update.total ?? ""}`;
}

/**
 * Updates that go out the moment they arrive: anything that is not a running
 * node (the finalizing hand-off) and a node's last step. The rest — sampler
 * steps and the per-node "executing" labels a graph emits as it walks its
 * loaders, encoders and decoders — are rate-limited.
 */
function isUrgent(update: ComfyProgressUpdate): boolean {
  if (update.stage !== "generating") return true;
  return (
    update.current !== undefined && update.total !== undefined && update.current >= update.total
  );
}

/**
 * Rate-limits one prompt's progress reports to one per
 * COMFY_PROGRESS_MIN_INTERVAL_MS, holding back the latest update rather than
 * dropping it: a node that starts within a second of the previous one and then
 * runs for a minute without a progress bar (a VAE decode, a video encode) must
 * still get its label onto the card. Pure — the caller owns the clock and the
 * timer, which it arms for `flushAt` and answers with `flush`.
 */
export class ComfyProgressGate {
  private lastSignature = "";
  private lastSentAt = Number.NEGATIVE_INFINITY;
  private pending: ComfyProgressUpdate | null = null;

  constructor(private readonly intervalMs = COMFY_PROGRESS_MIN_INTERVAL_MS) {}

  /** What to report now, if anything, and when to call `flush` for a held update. */
  offer(
    update: ComfyProgressUpdate,
    now: number,
  ): { send: ComfyProgressUpdate | null; flushAt: number | null } {
    const signature = progressSignature(update);
    if (signature === this.lastSignature) {
      // Back to what the card already shows: anything held is now stale.
      this.pending = null;
      return { send: null, flushAt: null };
    }
    if (isUrgent(update) || now - this.lastSentAt >= this.intervalMs) {
      this.pending = null;
      return { send: this.sent(update, signature, now), flushAt: null };
    }
    this.pending = update;
    return { send: null, flushAt: this.lastSentAt + this.intervalMs };
  }

  /**
   * The held update once its window has passed. Early — an urgent update went
   * out after the timer was armed and restarted the window — it stays held
   * and `flushAt` says when to try again.
   */
  flush(now: number): { send: ComfyProgressUpdate | null; flushAt: number | null } {
    const update = this.pending;
    if (!update) return { send: null, flushAt: null };
    const due = this.lastSentAt + this.intervalMs;
    if (now < due) return { send: null, flushAt: due };
    this.pending = null;
    return { send: this.sent(update, progressSignature(update), now), flushAt: null };
  }

  private sent(update: ComfyProgressUpdate, signature: string, now: number) {
    this.lastSignature = signature;
    this.lastSentAt = now;
    return update;
  }
}

function queuePromptId(entry: unknown): string | undefined {
  if (Array.isArray(entry)) return text(entry[1]);
  if (!entry || typeof entry !== "object") return undefined;
  const row = entry as Record<string, unknown>;
  return text(row.prompt_id) ?? text(row.promptId);
}

/** Reads both the documented tuple format and object-shaped proxy responses. */
export function comfyQueueState(raw: unknown, promptId: string): ComfyQueueState {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { state: "missing" };
  const queue = raw as { queue_running?: unknown; queue_pending?: unknown };
  const running = Array.isArray(queue.queue_running) ? queue.queue_running : [];
  if (running.some((entry) => queuePromptId(entry) === promptId)) return { state: "running" };

  const pending = Array.isArray(queue.queue_pending) ? queue.queue_pending : [];
  const index = pending.findIndex((entry) => queuePromptId(entry) === promptId);
  return index >= 0 ? { state: "queued", position: index } : { state: "missing" };
}
