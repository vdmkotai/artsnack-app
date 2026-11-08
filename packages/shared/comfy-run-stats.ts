/**
 * Where a self-hosted clip's time went, and what it ran on.
 *
 * Three sources, two clocks. Convex stamps `submittedAt` and the moment each
 * node starts — ComfyUI's "executing" WebSocket message carries no time of its
 * own, so the receive time stands in for it. The pod stamps execution start and
 * end in /history. A duration is taken between two readings of one clock
 * wherever possible; where the phases (queue → render → save) cross from one
 * clock to the other, the pod's readings are moved by `clockOffset`, measured
 * off a WebSocket message that carries the pod's own timestamp. Without one,
 * the clocks are taken as equal (RunPod hosts keep NTP time), and the odd
 * negative gap is clamped to zero rather than shown.
 *
 * The node breakdown is best effort: the WebSocket is optional (a proxy may
 * refuse it) and the processor reconnects every ~7 minutes, so a node that
 * starts in that gap is folded into the one before it.
 */

export type ComfyRunNode = {
  /** The node id in the submitted graph — `sample`, `decode`… for H3. */
  id: string;
  /** Convex time the node was reported as executing. */
  startedAt: number;
  /** Largest progress denominator the node reported: steps, for a sampler. */
  total?: number;
};

/** Stored on the row as `comfyRun`; every field is optional and filled as the
 *  job reaches it. Kept field for field in step with comfyRunValidator. */
export type ComfyRunStats = {
  submittedAt?: number;
  executionStartedAt?: number;
  executionEndedAt?: number;
  /** Nodes ComfyUI reused from the previous prompt instead of running. */
  cachedNodes?: string[];
  nodes?: ComfyRunNode[];
  /** Convex time the WebSocket reported the prompt finished. */
  nodesEndedAt?: number;
  /** Convex clock minus the pod's, from a message carrying the pod's own
   *  timestamp (plus the one-way network delay, which only shrinks it). */
  clockOffset?: number;
  gpuName?: string;
  vramBytes?: number;
  comfyuiVersion?: string;
  pytorchVersion?: string;
};

export type ComfyRunTimeline = { nodes: ComfyRunNode[]; endedAt?: number; clockOffset?: number };

/** A graph has a few dozen nodes; this only bounds a misbehaving pod. */
const MAX_NODES = 200;

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function finite(value: unknown): number | undefined {
  const number = typeof value === "number" ? value : Number(value);
  return typeof value !== "boolean" && value !== null && Number.isFinite(number)
    ? number
    : undefined;
}

/**
 * Folds one WebSocket message for this prompt into the timeline. Returns
 * whether anything changed. Messages for other prompts — the pod's other
 * clients share the socket — are ignored.
 */
export function applyComfyTimelineMessage(
  timeline: ComfyRunTimeline,
  raw: unknown,
  promptId: string,
  now: number,
): boolean {
  const envelope = record(raw);
  const data = record(envelope?.data);
  if (!envelope || !data || data.prompt_id !== promptId) return false;
  const node = typeof data.node === "string" && data.node ? data.node : null;
  // execution_start/cached/success carry the pod's clock; the smallest gap
  // seen is the one with the least network delay in it.
  const podTime = finite(data.timestamp);
  let offsetChanged = false;
  if (podTime !== undefined && String(envelope.type).startsWith("execution_")) {
    const offset = now - podTime;
    if (timeline.clockOffset === undefined || offset < timeline.clockOffset) {
      timeline.clockOffset = offset;
      offsetChanged = true;
    }
  }
  switch (envelope.type) {
    case "executing": {
      if (node === null) {
        // Pre-0.3 servers end a prompt with `executing: null` instead.
        if ("node" in data && data.node === null && timeline.endedAt === undefined) {
          timeline.endedAt = now;
          return true;
        }
        return false;
      }
      if (timeline.nodes.some((entry) => entry.id === node)) return false;
      if (timeline.nodes.length >= MAX_NODES) return false;
      timeline.nodes.push({ id: node, startedAt: now });
      return true;
    }
    case "progress": {
      const max = finite(data.max);
      if (!node || max === undefined || max <= 0) return false;
      const entry = timeline.nodes.find((candidate) => candidate.id === node);
      if (!entry) {
        // Joined mid-node (a reconnect): its start is unknown, so it starts now.
        if (timeline.nodes.length >= MAX_NODES) return false;
        timeline.nodes.push({ id: node, startedAt: now, total: max });
        return true;
      }
      if ((entry.total ?? 0) >= max) return false;
      entry.total = max;
      return true;
    }
    case "execution_success":
      if (timeline.endedAt !== undefined) return offsetChanged;
      timeline.endedAt = now;
      return true;
    default:
      return offsetChanged;
  }
}

/** Execution start/end and cached nodes, from /history's `status.messages`. */
export function comfyHistoryTimes(
  messages: unknown,
): Pick<ComfyRunStats, "executionStartedAt" | "executionEndedAt" | "cachedNodes"> {
  const result: Pick<ComfyRunStats, "executionStartedAt" | "executionEndedAt" | "cachedNodes"> = {};
  if (!Array.isArray(messages)) return result;
  for (const message of messages) {
    if (!Array.isArray(message)) continue;
    const [kind, payload] = message as [unknown, unknown];
    const data = record(payload);
    if (!data) continue;
    const timestamp = finite(data.timestamp);
    if (kind === "execution_start" && timestamp !== undefined) {
      result.executionStartedAt = timestamp;
    } else if (kind === "execution_success" && timestamp !== undefined) {
      result.executionEndedAt = timestamp;
    } else if (kind === "execution_cached" && Array.isArray(data.nodes)) {
      const nodes = data.nodes.filter((id): id is string => typeof id === "string");
      if (nodes.length > 0) result.cachedNodes = nodes.slice(0, MAX_NODES);
    }
  }
  return result;
}

/**
 * The GPU and software of one ComfyUI, from its /system_stats. On a multi-GPU
 * video pod each GPU runs its own ComfyUI, so the first device is the one the
 * job rendered on.
 */
export function comfySystemInfo(
  body: unknown,
): Pick<ComfyRunStats, "gpuName" | "vramBytes" | "comfyuiVersion" | "pytorchVersion"> {
  const result: Pick<ComfyRunStats, "gpuName" | "vramBytes" | "comfyuiVersion" | "pytorchVersion"> =
    {};
  const root = record(body);
  if (!root) return result;
  const device = Array.isArray(root.devices) ? record(root.devices[0]) : null;
  if (device && typeof device.name === "string") {
    // "cuda:0 NVIDIA RTX PRO 6000 Blackwell Server Edition : cudaMallocAsync"
    const name = device.name
      .replace(/^\s*cuda:\d+\s+/i, "")
      .replace(/\s*:\s*[A-Za-z]+$/, "")
      .trim();
    if (name) result.gpuName = name.slice(0, 120);
    const vram = finite(device.vram_total);
    if (vram !== undefined && vram > 0) result.vramBytes = vram;
  }
  const system = record(root.system);
  if (typeof system?.comfyui_version === "string" && system.comfyui_version) {
    result.comfyuiVersion = system.comfyui_version.slice(0, 40);
  }
  if (typeof system?.pytorch_version === "string" && system.pytorch_version) {
    result.pytorchVersion = system.pytorch_version.slice(0, 40);
  }
  return result;
}

/**
 * Adds what one processor run learned to what earlier runs stored. A node seen
 * by two runs keeps its earliest start; scalars from the newer run win.
 */
export function mergeComfyRunStats(
  existing: ComfyRunStats | undefined,
  patch: ComfyRunStats,
): ComfyRunStats {
  const merged: ComfyRunStats = { ...existing };
  for (const [key, value] of Object.entries(patch) as [keyof ComfyRunStats, unknown][]) {
    if (value === undefined || key === "nodes") continue;
    (merged as Record<string, unknown>)[key] = value;
  }
  // Each run measures the offset afresh; the smallest has the least delay in it.
  if (existing?.clockOffset !== undefined && patch.clockOffset !== undefined) {
    merged.clockOffset = Math.min(existing.clockOffset, patch.clockOffset);
  }
  if (patch.nodes && patch.nodes.length > 0) {
    const byId = new Map((existing?.nodes ?? []).map((node) => [node.id, { ...node }]));
    for (const node of patch.nodes) {
      const known = byId.get(node.id);
      if (!known) {
        byId.set(node.id, { ...node });
        continue;
      }
      known.startedAt = Math.min(known.startedAt, node.startedAt);
      const total = Math.max(known.total ?? 0, node.total ?? 0);
      if (total > 0) known.total = total;
    }
    merged.nodes = [...byId.values()].sort((a, b) => a.startedAt - b.startedAt).slice(0, MAX_NODES);
  }
  return merged;
}

export type ComfyRunPhase = {
  key: "prepare" | "queue" | "render" | "save";
  label: string;
  ms: number;
};

export type ComfyRunStage = { key: string; label: string; ms: number; steps?: number };

export type ComfyRunSummary = {
  /** Click to clip in storage; absent when the end was never recorded. */
  totalMs?: number;
  phases: ComfyRunPhase[];
  /** The render phase, by stage of the graph, in the order they ran. */
  stages: ComfyRunStage[];
};

const PHASE_LABELS: Record<ComfyRunPhase["key"], string> = {
  prepare: "Preparing and uploading inputs",
  queue: "Waiting in the pod's queue",
  render: "Rendering on the GPU",
  save: "Saving the clip",
};

/** Shorter than this, a stage is bookkeeping and only clutters the list. */
const MIN_STAGE_MS = 100;

export function summarizeComfyRun(
  input: { createdAt: number; completedAt?: number; stats?: ComfyRunStats },
  stageOf: (nodeId: string) => { key: string; label: string },
): ComfyRunSummary {
  const stats = input.stats ?? {};
  const between = (from?: number, to?: number) =>
    from === undefined || to === undefined ? undefined : Math.max(0, to - from);

  const phases: ComfyRunPhase[] = [];
  const phase = (key: ComfyRunPhase["key"], ms: number | undefined) => {
    if (ms !== undefined) phases.push({ key, label: PHASE_LABELS[key], ms });
  };
  // The pod's two readings, moved onto Convex time where they meet Convex's.
  const offset = stats.clockOffset ?? 0;
  const podToConvex = (time?: number) => (time === undefined ? undefined : time + offset);
  phase("prepare", between(input.createdAt, stats.submittedAt));
  phase("queue", between(stats.submittedAt, podToConvex(stats.executionStartedAt)));
  phase("render", between(stats.executionStartedAt, stats.executionEndedAt));
  phase("save", between(podToConvex(stats.executionEndedAt), input.completedAt));

  const nodes = [...(stats.nodes ?? [])].sort((a, b) => a.startedAt - b.startedAt);
  // The last node runs until the prompt ends: the WebSocket's own reading when
  // it saw the end, else the pod's, moved onto Convex time by the measured
  // clock offset (none measured: RunPod hosts keep NTP time, so assume none).
  let end = stats.nodesEndedAt;
  if (end === undefined) end = podToConvex(stats.executionEndedAt);
  const stages: ComfyRunStage[] = [];
  nodes.forEach((node, index) => {
    const until = index + 1 < nodes.length ? nodes[index + 1].startedAt : end;
    if (until === undefined) return;
    const ms = Math.max(0, until - node.startedAt);
    const { key, label } = stageOf(node.id);
    const stage = stages.find((candidate) => candidate.key === key);
    if (stage) {
      stage.ms += ms;
      if (node.total) stage.steps = (stage.steps ?? 0) + node.total;
    } else {
      stages.push({ key, label, ms, ...(node.total ? { steps: node.total } : {}) });
    }
  });

  return {
    totalMs: between(input.createdAt, input.completedAt),
    phases,
    stages: stages.filter((stage) => stage.ms >= MIN_STAGE_MS),
  };
}

/**
 * When an output was written, read off its B2 key — uploads are named
 * `<prefix>/<Date.now()>_<random>.<ext>` (mediaPipeline.ts). The only finish
 * time a row from before `completedAt` existed has.
 */
export function outputKeyTimestamp(b2Key: string | undefined): number | undefined {
  const match = b2Key?.match(/(?:^|\/)(\d{13})_[^/]*$/);
  return match ? Number(match[1]) : undefined;
}

/** "0.4 s", "12 s", "4 min 05 s", "1 h 02 min". */
export function formatDurationMs(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  if (ms < 10_000) return `${(ms / 1000).toFixed(1)} s`;
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min ${String(seconds % 60).padStart(2, "0")} s`;
  return `${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, "0")} min`;
}
