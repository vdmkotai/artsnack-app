"use node";

import { randomUUID } from "node:crypto";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { internalAction, type ActionCtx } from "./_generated/server";
import { resolveVideoPods, type ComfyuiTarget, type VideoPodTarget } from "./comfyuiTarget";
import {
  fetchComfyQueueState,
  watchComfyProgress,
  type ComfyProgressWatcher,
} from "./comfyuiProgressReporter";
import { loadReferenceImages, persistReferenceImages, uploadMediaUrlToB2 } from "./mediaPipeline";
import { comfyNodeLabelsForWorkflow, comfyQueueState } from "../../shared/comfyui-progress";
import {
  comfyHistoryTimes,
  comfySystemInfo,
  type ComfyRunStats,
} from "../../shared/comfy-run-stats";
import { buildH3VideoWorkflow, normalizeH3Settings, type H3Inputs } from "../../shared/h3-video";
import { buildLtxVideoWorkflow, normalizeLtxSettings } from "../../shared/ltx-video";
import { noCacheFetch } from "../../shared/no-cdn-cache";
import { graphModelFiles, type GraphModelFile } from "../../shared/video-graph-files";

/**
 * Drives one self-hosted H3 job — see comfyVideo.ts for the lifecycle.
 *
 * One run = claim the lease, submit (first run only), poll /history for at most
 * POLL_BUDGET_MS, then either save the clip or hand off to a fresh run. The
 * Convex action ceiling is 10 minutes; the budget leaves room for the upload.
 */

const POLL_BUDGET_MS = 7 * 60_000;
const POLL_INTERVAL_MS = 3_000;
/** /history is served from the event loop that is busy loading a 20 GB model
 *  on the first job after boot — a slow answer then is normal, not a fault. */
const HISTORY_TIMEOUT_MS = 60_000;
/** A prompt absent from both history and queue this many polls in a row was
 *  lost — the pod restarted, or someone cleared its queue. */
const MISSING_POLLS_BEFORE_FAILING = 4;
/** H3 at 768p is ~0.7 MB/s of output; 2 GB is far beyond any 20-second clip. */
const MAX_OUTPUT_BYTES = 2 * 1024 ** 3;
/** Well inside COMFY_LEASE_RENEW_BELOW_MS: input uploads and the B2 copy can
 *  each outlast one lease, and a lapsed lease lets the rescue cron start a
 *  second owner. `claim` writes only once the lease is due, so a beat between
 *  renewals costs a read; at 30 s a lease is renewed with a minute or more
 *  left, and three beats in a row must fail before it can lapse. */
const HEARTBEAT_MS = 30_000;

class JobFailure extends Error {}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function extensionFor(contentType: string | null): string {
  if (contentType?.includes("png")) return "png";
  if (contentType?.includes("webp")) return "webp";
  return "jpg";
}

/** Puts every input image in the pod's input/ folder and maps them by role. */
async function uploadInputs(
  ctx: ActionCtx,
  target: ComfyuiTarget,
  row: Doc<"grokGenerations">,
): Promise<H3Inputs> {
  const storageIds = row.referenceStorageIds ?? [];
  const roles = row.h3InputRoles ?? [];
  const inputs: H3Inputs = {};
  for (let index = 0; index < storageIds.length; index++) {
    const blob = await ctx.storage.get(storageIds[index]);
    if (!blob) throw new JobFailure("An input image is no longer in storage — attach it again");
    const filename = `artsnack_${row._id}_${index}.${extensionFor(blob.type)}`;
    const form = new FormData();
    form.append("image", blob, filename);
    form.append("type", "input");
    form.append("overwrite", "true");
    const response = await fetch(`${target.url}/upload/image`, {
      method: "POST",
      headers: target.headers,
      body: form,
      signal: AbortSignal.timeout(120_000),
    });
    if (!response.ok) {
      throw new JobFailure(`The pod refused an input image (HTTP ${response.status})`);
    }
    const stored = ((await response.json()) as { name?: string }).name ?? filename;
    const role = roles[index] ?? "reference";
    if (role === "first") inputs.firstFrame = stored;
    else if (role === "last") inputs.lastFrame = stored;
    else (inputs.references ??= []).push(stored);
  }
  return inputs;
}

/** ComfyUI's validation answer, turned into one line a person can act on. */
function describeRejection(body: unknown): string {
  const record = (body ?? {}) as {
    error?: { message?: string };
    node_errors?: Record<string, { errors?: { details?: string; message?: string }[] }>;
  };
  const details = Object.values(record.node_errors ?? {})
    .flatMap((node) => node.errors ?? [])
    .map((error) => error.details || error.message)
    .filter(Boolean);
  if (details.some((detail) => /not in \[/.test(String(detail)))) {
    return `The pod does not have a file this job needs (${details[0]}). Is the download finished?`;
  }
  return details[0] ?? record.error?.message ?? "The pod rejected the workflow";
}

/**
 * Queues the graph under a prompt id chosen here (ComfyUI ≥0.18 accepts one)
 * and already recorded on the row, so a job whose answer is lost is found by
 * polling instead of being submitted twice. Only an explicit refusal throws;
 * a dropped connection is left for the poll loop to resolve.
 */
async function submit(
  target: ComfyuiTarget,
  graph: Record<string, unknown>,
  clientId: string,
  promptId: string,
): Promise<void> {
  let response: Response;
  try {
    response = await fetch(`${target.url}/prompt`, {
      method: "POST",
      headers: { ...target.headers, "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: graph, client_id: clientId, prompt_id: promptId }),
      signal: AbortSignal.timeout(60_000),
    });
  } catch {
    return;
  }
  if (response.status >= 500) return;
  const body = (await response.json().catch(() => null)) as { prompt_id?: string } | null;
  if (!response.ok) throw new JobFailure(describeRejection(body));
}

/** Like fetchComfyQueueState, but an unreachable pod is "unknown", not
 *  "missing" — a proxy hiccup must not count towards losing the job. */
async function queueState(
  target: ComfyuiTarget,
  promptId: string,
): Promise<ReturnType<typeof comfyQueueState> | { state: "unknown" }> {
  try {
    const response = await noCacheFetch(`${target.url}/queue`, {
      headers: target.headers,
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) return { state: "unknown" };
    return comfyQueueState(await response.json(), promptId);
  } catch {
    return { state: "unknown" };
  }
}

/** Takes a prompt off the pod: dequeued if waiting, interrupted if running. */
async function cancelPrompt(target: ComfyuiTarget, promptId: string): Promise<void> {
  const queue = await fetchComfyQueueState({
    baseUrl: target.url,
    headers: target.headers,
    promptId,
  });
  const headers = { ...target.headers, "Content-Type": "application/json" };
  if (queue.state === "queued") {
    await fetch(`${target.url}/queue`, {
      method: "POST",
      headers,
      body: JSON.stringify({ delete: [promptId] }),
      signal: AbortSignal.timeout(20_000),
    }).catch(() => {});
  } else if (queue.state === "running") {
    await fetch(`${target.url}/interrupt`, {
      method: "POST",
      headers,
      body: JSON.stringify({ prompt_id: promptId }),
      signal: AbortSignal.timeout(20_000),
    }).catch(() => {});
  }
}

/** Copies the input images to B2 for Reproduce. Retried because the row's
 *  Convex blobs are released on completion — a lost copy cannot be redone. */
async function persistInputs(
  ctx: ActionCtx,
  storageIds: Id<"_storage">[],
): Promise<string[] | undefined> {
  if (storageIds.length === 0) return undefined;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await persistReferenceImages(await loadReferenceImages(ctx, storageIds));
    } catch {
      await sleep(2_000 * (attempt + 1));
    }
  }
  return undefined;
}

/** The GPU and ComfyUI version, for the details panel. Optional: a pod too
 *  busy to answer in time costs the panel a line, never the job. */
async function readSystemInfo(target: ComfyuiTarget): Promise<ComfyRunStats> {
  try {
    const response = await noCacheFetch(`${target.url}/system_stats`, {
      headers: target.headers,
      signal: AbortSignal.timeout(8_000),
    });
    return response.ok ? comfySystemInfo(await response.json()) : {};
  } catch {
    return {};
  }
}

type HistoryEntry = {
  status?: {
    status_str?: string;
    completed?: boolean;
    messages?: [string, Record<string, unknown>][];
  };
  outputs?: Record<string, Record<string, unknown>>;
};

async function readHistory(target: ComfyuiTarget, promptId: string): Promise<HistoryEntry | null> {
  const response = await noCacheFetch(`${target.url}/history/${encodeURIComponent(promptId)}`, {
    headers: target.headers,
    signal: AbortSignal.timeout(HISTORY_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`History returned ${response.status}`);
  const body = (await response.json()) as Record<string, HistoryEntry>;
  return body[promptId] ?? null;
}

/** SaveVideo reports its file under `images` (with `animated`), older nodes
 *  under `videos` or `gifs` — take the first video-looking file anywhere. */
function outputFile(
  entry: HistoryEntry,
): { filename: string; subfolder: string; type: string } | null {
  for (const node of Object.values(entry.outputs ?? {})) {
    for (const value of Object.values(node)) {
      if (!Array.isArray(value)) continue;
      for (const item of value) {
        const file = item as { filename?: unknown; subfolder?: unknown; type?: unknown };
        if (typeof file?.filename === "string" && /\.(mp4|webm|mov|mkv)$/i.test(file.filename)) {
          return {
            filename: file.filename,
            subfolder: typeof file.subfolder === "string" ? file.subfolder : "",
            type: typeof file.type === "string" ? file.type : "output",
          };
        }
      }
    }
  }
  return null;
}

function executionError(entry: HistoryEntry): string {
  const error = (entry.status?.messages ?? []).find(([kind]) => kind === "execution_error")?.[1];
  const text = String(error?.exception_message ?? "").trim();
  if (/out of memory|OutOfMemory/i.test(text)) {
    return "The GPU ran out of memory — lower the resolution or the duration";
  }
  return text ? `ComfyUI: ${text.slice(0, 400)}` : "ComfyUI reported an error for this job";
}

/** A loader's choices on one pod, or null when the pod did not answer. */
async function loaderChoices(
  pod: VideoPodTarget,
  node: string,
  input: string,
): Promise<string[] | null> {
  try {
    const response = await noCacheFetch(`${pod.url}/object_info/${node}`, {
      headers: pod.headers,
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) return null;
    const spec = (
      (await response.json()) as Record<
        string,
        { input?: { required?: Record<string, unknown[]> } }
      >
    )[node]?.input?.required?.[input];
    const listed = Array.isArray(spec?.[0])
      ? spec[0]
      : ((spec?.[1] as { options?: unknown } | undefined)?.options ?? []);
    return Array.isArray(listed)
      ? listed.filter((item): item is string => typeof item === "string")
      : [];
  } catch {
    return null;
  }
}

/**
 * The pods that list every file a job's graph loads — checkpoint, LoRAs, text
 * encoders, VAEs, upscalers, RIFE (graphModelFiles). A pod that does not
 * answer is kept rather than dropped: a busy event loop is not a missing
 * model, and the submit's own validation will name anything really absent.
 */
async function podsWithModels(
  pods: VideoPodTarget[],
  need: GraphModelFile[],
): Promise<VideoPodTarget[]> {
  if (pods.length <= 1) return pods;
  const lists = [...new Set(need.map((entry) => `${entry.node}\u0000${entry.input}`))];
  const checks = await Promise.all(
    pods.map(async (pod) => {
      const choices = new Map(
        await Promise.all(
          lists.map(async (key) => {
            const [node, input] = key.split("\u0000");
            return [key, await loaderChoices(pod, node, input)] as const;
          }),
        ),
      );
      return need.every((entry) => {
        const list = choices.get(`${entry.node}\u0000${entry.input}`);
        return list === null || list === undefined || list.includes(entry.file);
      });
    }),
  );
  return pods.filter((_, index) => checks[index]);
}

export const run = internalAction({
  args: { generationId: v.id("grokGenerations"), leaseId: v.string() },
  handler: async (ctx, args) => {
    const startedAt = Date.now();
    const row = await ctx.runMutation(internal.comfyVideo.claim, {
      id: args.generationId,
      leaseId: args.leaseId,
    });
    if (!row?.h3Settings && !row?.ltxSettings) return;
    const fail = (error: string) =>
      ctx.runMutation(internal.grokGenerations.markFailed, {
        id: row._id,
        error,
        leaseId: args.leaseId,
      });
    // Timings and GPU are for display only; failing to store them never
    // fails the job.
    const saveStats = async (stats: ComfyRunStats) => {
      if (Object.values(stats).every((value) => value === undefined)) return;
      await ctx.runMutation(internal.comfyVideo.recordRun, { id: row._id, stats }).catch(() => {});
    };

    const watch = (
      target: ComfyuiTarget,
      clientId: string,
      promptId: string,
      graph: Record<string, unknown>,
    ) =>
      watchComfyProgress({
        baseUrl: target.url,
        headers: target.headers,
        clientId,
        promptId,
        nodeLabels: comfyNodeLabelsForWorkflow(graph, "video"),
        media: "video",
        report: async (update) => {
          await ctx.runMutation(internal.grokGenerations.updateProgress, {
            id: row._id,
            stage: update.stage,
            message: update.message,
            current: update.current,
            total: update.total,
          });
        },
      });
    let watcher: ComfyProgressWatcher | null = null;
    let entry: HistoryEntry | null = null;
    // What this run saw, kept whether it finishes, hands off or loses the
    // lease — even straight after submitting: a 15-second clip outlives one
    // run, and the next run's socket only sees the nodes after it. Called from
    // both finally blocks; only the first call does anything.
    let flushed = false;
    const flushStats = async () => {
      if (!watcher || flushed) return;
      flushed = true;
      await watcher.close();
      const seen = watcher.timeline();
      await saveStats({
        nodes: seen.nodes.length > 0 ? seen.nodes : undefined,
        nodesEndedAt: seen.endedAt,
        clockOffset: seen.clockOffset,
        ...(entry ? comfyHistoryTimes(entry.status?.messages) : {}),
      });
    };

    // Keeps the lease alive through every slow step, not just the poll loop;
    // `owned` turns false once the row is deleted, settled or taken over.
    let owned = true;
    const heartbeat = setInterval(() => {
      void ctx
        .runMutation(internal.comfyVideo.claim, { id: row._id, leaseId: args.leaseId })
        .then((renewed) => {
          if (!renewed) owned = false;
        })
        .catch(() => {});
    }, HEARTBEAT_MS);

    try {
      // Several video pods may run at once. A job picked a pod in the form, or
      // was assigned one on its first run; either way it stays there.
      const pods = await resolveVideoPods(ctx);
      if (pods.length === 0) {
        // Not yet submitted: nothing is lost, but nothing can run either.
        throw new JobFailure(
          row.falRequestId
            ? "The video pod this job ran on was destroyed; the clip was lost"
            : "The video pod is not running — start it in the Self-hosted video tab",
        );
      }
      const pinned = row.comfyBackendId
        ? pods.find((candidate) => candidate.backendId === row.comfyBackendId)
        : undefined;
      if (row.comfyBackendId && !pinned) {
        throw new JobFailure(
          row.falRequestId
            ? "The video pod this job ran on was destroyed; the clip was lost"
            : "The video pod picked for this job is no longer running",
        );
      }
      let pod: VideoPodTarget = pinned ?? pods[0];
      // The ComfyUI this job talks to: on a multi-GPU pod each GPU has its own,
      // and a submitted job stays with the one it was queued on.
      let target: ComfyuiTarget = {
        ...pod,
        url:
          row.falRequestId && row.endpoint && pod.instanceUrls.includes(row.endpoint)
            ? row.endpoint
            : pod.url,
      };

      // One processor for both families on the video pod: the row says which
      // graph to build, everything around it — lease, upload, poll — is shared.
      const ltx = row.ltxSettings ? normalizeLtxSettings(row.ltxSettings) : null;
      const h3 = row.h3Settings ? normalizeH3Settings(row.h3Settings) : null;
      const seed = (row.ltxSettings ?? row.h3Settings)!.seed;
      const buildGraph = (inputs: H3Inputs, filenamePrefix: string): Record<string, unknown> =>
        ltx
          ? buildLtxVideoWorkflow(ltx, inputs, { seed, filenamePrefix })
          : buildH3VideoWorkflow(h3!, inputs, { seed, filenamePrefix });
      let promptId = row.falRequestId;
      let clientId = row.comfyClientId ?? randomUUID();
      // Rebuilt on every run for the progress labels; the ids are fixed.
      let graph = buildGraph({}, "");

      if (!promptId) {
        await ctx.runMutation(internal.grokGenerations.markProcessing, { id: row._id });
        await ctx.runMutation(internal.grokGenerations.updateProgress, {
          id: row._id,
          stage: "preparing",
          message: "Sending the job to the video pod…",
        });
        // Auto: only pods that hold this job's checkpoint, LoRAs and (LTX) base
        // set — each pod has its own disk, so models can differ between them.
        const eligible = pinned
          ? [pinned]
          : await podsWithModels(
              pods,
              graphModelFiles(graph as Parameters<typeof graphModelFiles>[0]),
            );
        if (eligible.length === 0) {
          throw new JobFailure(
            "No running video pod has the models this job needs — add them to the pod or pick another one",
          );
        }
        const assigned = await ctx.runMutation(internal.comfyVideo.assignInstance, {
          id: row._id,
          leaseId: args.leaseId,
          candidates: eligible.flatMap((candidate) =>
            candidate.instanceUrls.map((url) => ({ backendId: candidate.backendId, url })),
          ),
        });
        if (!assigned) return; // dismissed or taken over meanwhile
        pod = eligible.find((candidate) => candidate.backendId === assigned.backendId) ?? pod;
        target = { ...pod, url: assigned.url };
        const inputs = await uploadInputs(ctx, target, row);
        graph = buildGraph(inputs, `artsnack/${row._id}`);
        clientId = randomUUID();
        promptId = randomUUID();
        // Listening before the prompt exists: an idle pod starts it at once,
        // and the nodes that run first — model loading — would go unseen.
        // `ready` gives up after two seconds, so a refused socket costs that.
        watcher = watch(target, clientId, promptId, graph);
        await watcher.ready;
        // Recorded before the POST: from here on every owner polls this id and
        // none submits again, whatever happens to this action.
        const recorded = await ctx.runMutation(internal.comfyVideo.recordSubmit, {
          id: row._id,
          leaseId: args.leaseId,
          promptId,
          clientId,
          backendId: pod.backendId,
          endpoint: target.url,
        });
        if (!recorded) return; // dismissed or taken over meanwhile
        await submit(target, graph, clientId, promptId);
        // Deleted while the POST was in flight: the delete's own cancel may have
        // run before the prompt existed, so take it off the pod from here.
        const stillOwned = await ctx.runMutation(internal.comfyVideo.claim, {
          id: row._id,
          leaseId: args.leaseId,
        });
        if (!stillOwned) {
          if (!(await ctx.runQuery(internal.comfyVideo.exists, { id: row._id }))) {
            await cancelPrompt(target, promptId);
          }
          return;
        }
      }

      const active = (watcher ??= watch(target, clientId, promptId, graph));
      // The GPU is read once per job, from the ComfyUI the job was sent to —
      // on a multi-GPU pod each GPU has its own.
      const [, system] = await Promise.all([
        active.ready,
        row.comfyRun?.gpuName ? null : readSystemInfo(target),
      ]);
      if (system) await saveStats(system);

      let missing = 0;
      // The queue line last written by this run. A clip behind others is
      // polled every few seconds for up to two hours; only a move in the queue
      // is news, and every write re-renders each grid that lists the row.
      let lastQueueReport = "";
      try {
        while (Date.now() - startedAt < POLL_BUDGET_MS) {
          let historyAnswered = true;
          try {
            entry = await readHistory(target, promptId);
          } catch {
            entry = null; // busy event loop or proxy hiccup — keep waiting
            historyAnswered = false;
          }
          if (entry?.status?.status_str === "error") throw new JobFailure(executionError(entry));
          if (entry && (entry.status?.completed || outputFile(entry))) break;
          entry = null;

          const queue = await queueState(target, promptId);
          if (queue.state === "unknown" || !historyAnswered) {
            // Only answers from a reachable pod count towards "lost".
          } else if (queue.state === "queued") {
            missing = 0;
            const report = `queued|${queue.position}`;
            if (report !== lastQueueReport) {
              await ctx.runMutation(internal.grokGenerations.updateProgress, {
                id: row._id,
                stage: "queued",
                message:
                  queue.position === 0
                    ? "Next in the video pod's queue…"
                    : `${queue.position} job${queue.position === 1 ? "" : "s"} ahead on the video pod…`,
                queuePosition: queue.position,
              });
              lastQueueReport = report;
            }
          } else if (queue.state === "running") {
            missing = 0;
            // The socket reports from here on; a later "queued" is written again.
            lastQueueReport = "";
          } else if (++missing >= MISSING_POLLS_BEFORE_FAILING) {
            throw new JobFailure("The video pod lost this job (was it restarted?)");
          }

          // Ownership is checked every pass but written only when the lease is
          // due (comfyVideo.comfyLeaseDecision): the check is a read, so the
          // row — and every grid listing it — is untouched between renewals.
          const lease = await ctx.runQuery(internal.comfyVideo.leaseStatus, {
            id: row._id,
            leaseId: args.leaseId,
          });
          const renewed =
            lease === "held" ||
            (lease === "renew" &&
              (await ctx.runMutation(internal.comfyVideo.claim, {
                id: row._id,
                leaseId: args.leaseId,
              })) !== null);
          if (!renewed || !owned) return; // deleted, failed elsewhere, or taken over
          await sleep(POLL_INTERVAL_MS);
        }
      } finally {
        // Before the upload, not after: an action killed mid-copy runs no
        // finally block, and the timeline would go with it.
        await flushStats();
      }

      if (!entry) {
        if (Date.now() > (row.atlasWaitEndsAt ?? 0)) {
          throw new JobFailure("The video pod did not finish this job within two hours");
        }
        await ctx.runMutation(internal.comfyVideo.resume, { id: row._id, leaseId: args.leaseId });
        return;
      }

      const file = outputFile(entry);
      if (!file) throw new JobFailure("The job finished but the pod saved no video");
      if (!owned) return;
      await ctx.runMutation(internal.grokGenerations.updateProgress, {
        id: row._id,
        stage: "finalizing",
        message: "Saving the clip…",
      });
      const view = new URL(`${target.url}/view`);
      view.searchParams.set("filename", file.filename);
      view.searchParams.set("subfolder", file.subfolder);
      view.searchParams.set("type", file.type);
      const key = await uploadMediaUrlToB2(view.toString(), "video/mp4", "videos/h3", {
        maxBytes: MAX_OUTPUT_BYTES,
        inactivityTimeoutMs: 120_000,
      });
      // The input images live in Convex storage only until the row settles;
      // copied to B2 (content-addressed, so a reused frame is stored once)
      // they let "Reproduce" put the same frames and references back.
      const referenceB2Keys = await persistInputs(ctx, row.referenceStorageIds ?? []);
      await ctx.runMutation(internal.grokGenerations.markCompleted, {
        id: row._id,
        b2Keys: [key],
        referenceB2Keys,
        leaseId: args.leaseId,
      });
    } catch (error) {
      await fail(message(error));
    } finally {
      clearInterval(heartbeat);
      // Covers the returns and throws between opening the socket and the loop.
      await flushStats();
    }
  },
});

/**
 * Takes a job off the pod when its row is deleted mid-flight: pending prompts
 * are removed from the queue, the running one is interrupted. Best effort —
 * the row is already gone, so a failure here costs GPU time, nothing else.
 */
export const cancelOnPod = internalAction({
  args: { promptId: v.string(), endpoint: v.optional(v.string()) },
  handler: async (ctx, args) => {
    // The pod that owns the endpoint; an old row without one cancels on each pod.
    const pods = await resolveVideoPods(ctx);
    const owner = args.endpoint
      ? pods.find((pod) => pod.instanceUrls.includes(args.endpoint as string))
      : undefined;
    if (owner) {
      await cancelPrompt({ ...owner, url: args.endpoint as string }, args.promptId);
      return;
    }
    for (const pod of pods) await cancelPrompt(pod, args.promptId);
  },
});
