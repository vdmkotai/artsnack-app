"use node";

import { v } from "convex/values";
import { internalAction } from "./_generated/server";
import { internal } from "./_generated/api";
import { PutObjectCommand } from "@aws-sdk/client-s3";
import { noCacheFetch } from "../../shared/no-cdn-cache";
import { resolveComfyuiTarget } from "./comfyuiTarget";
import { getS3Client } from "./mediaPipeline";
import {
  fetchComfyQueueState,
  watchComfyProgress,
  type ComfyProgressWatcher,
} from "./comfyuiProgressReporter";
import type { ComfyProgressUpdate } from "../../shared/comfyui-progress";

const POLL_DELAY_MS = 2000;
const MAX_ATTEMPTS = 150;
/**
 * Wall clock, not attempts. A failed attempt costs a request timeout rather
 * than a tick, so 150 attempts is not 300 seconds — and an isolate killed at
 * the 10-minute ceiling runs no catch block, leaving the row in `processing`
 * with nothing to sweep it.
 */
const POLL_BUDGET_MS = 7 * 60_000;
/**
 * The whole action, poll plus collection, measured from its own start:
 *
 *   600s ceiling − 60s for the closing mutation and for the PutObject already
 *   in flight when the deadline passes = 540s.
 *
 * The collection phase needs its own bound because a completion detected at
 * 6:59 still has N images to pull at DOWNLOAD_TIMEOUT_MS each, which could push
 * the action past the ceiling. Overrunning now costs a row swept to `failed` by
 * generations.failStalled rather than a permanent spinner, but a batch that
 * saves most of its images beats one killed mid-upload either way.
 */
const ACTION_BUDGET_MS = 9 * 60_000;
/** /view returns full-resolution PNGs, so it needs its own deadline rather
 *  than noCacheFetch's default, which is sized for small JSON GETs. */
const DOWNLOAD_TIMEOUT_MS = 120_000;

/** ComfyUI serves /history from the same asyncio loop it blocks while loading a
 *  multi-GB checkpoint, so a poll that outlives noCacheFetch's 15s default is
 *  normal on the first job after a cold pod start — not a fault. The backends in
 *  lib/backends already pass this; without it here, a cold pod turns into a
 *  retry storm that burns POLL_BUDGET_MS instead of waiting out the load. */
const HISTORY_TIMEOUT_MS = 90_000;

type ComfyUIMediaFile = {
  filename: string;
  subfolder?: string;
  type?: string;
};

type ComfyUINodeOutput = {
  images?: ComfyUIMediaFile[];
  gifs?: ComfyUIMediaFile[];
  videos?: ComfyUIMediaFile[];
};

type ComfyUIHistoryItem = {
  status?: {
    completed?: boolean;
    status_str?: string;
    messages?: unknown;
  };
  outputs?: Record<string, ComfyUINodeOutput>;
};

function generateImageKey(index: number): string {
  const timestamp = Date.now();
  const random = Math.random().toString(36).substring(2, 8);
  return `generations/${timestamp}_${random}_${index}.png`;
}

async function collectAndUploadOutputs(
  baseUrl: string,
  headers: Record<string, string>,
  /** Wall clock shared with the poll loop: what is downloaded by then is saved,
   *  the rest is reported as missed rather than risking the action ceiling. */
  deadline: number,
  outputs?: Record<string, ComfyUINodeOutput>,
  onProgress?: (stage: string, message: string) => Promise<void>,
): Promise<{ b2Keys: string[]; missed: number }> {
  const b2Keys: string[] = [];
  let missed = 0;
  if (!outputs) return { b2Keys, missed };

  const bucketName = process.env.B2_BUCKET_NAME;
  if (!bucketName) throw new Error("B2_BUCKET_NAME not configured");

  const s3 = getS3Client();
  const allFiles: Array<ComfyUIMediaFile & { mediaType: "image" | "video" }> = Object.values(
    outputs,
  ).flatMap((nodeOutput) => [
    ...(nodeOutput?.images || []).map((f) => ({
      ...f,
      mediaType: "image" as const,
    })),
    ...(nodeOutput?.gifs || []).map((f) => ({
      ...f,
      mediaType: "video" as const,
    })),
    ...(nodeOutput?.videos || []).map((f) => ({
      ...f,
      mediaType: "video" as const,
    })),
  ]);
  let fileIndex = 0;

  for (const [outputIndex, file] of allFiles.entries()) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      console.error(`[SelfHosted] out of time before fetching ${file.filename}`);
      missed++;
      continue;
    }

    const viewUrl = `${baseUrl}/view?filename=${encodeURIComponent(file.filename)}&subfolder=${encodeURIComponent(file.subfolder || "")}&type=${encodeURIComponent(file.type || "output")}`;

    let response: Response;
    try {
      await onProgress?.(
        "downloading-output",
        `Downloading output ${outputIndex + 1} of ${allFiles.length}...`,
      );
      response = await noCacheFetch(viewUrl, {
        headers,
        // Whichever runs out first: a single slow file must not eat the budget
        // its siblings need, and it must not push the action past the ceiling.
        signal: AbortSignal.timeout(Math.min(DOWNLOAD_TIMEOUT_MS, remaining)),
      });
    } catch (error) {
      // An aborted or refused download is one lost file, not a lost batch:
      // whatever already went to B2 is still worth handing back. A batch that
      // loses every file ends up with no keys, which the caller fails on.
      console.error(`[SelfHosted] output ${file.filename} download failed`, error);
      missed++;
      continue;
    }
    if (!response.ok) {
      // Skipped, not failed — the rest of the batch is still worth saving.
      // Logged because a silently short batch is otherwise undiagnosable:
      // the generation reports success with fewer images than it produced.
      console.error(
        `[SelfHosted] output ${file.filename} could not be fetched (HTTP ${response.status})`,
      );
      missed++;
      continue;
    }

    const buffer = Buffer.from(await response.arrayBuffer());

    let key: string;
    let contentType: string;
    if (file.mediaType === "video") {
      const timestamp = Date.now();
      const random = Math.random().toString(36).substring(2, 8);
      key = `videos/${timestamp}_${random}_${fileIndex}.mp4`;
      contentType = "video/mp4";
    } else {
      key = generateImageKey(fileIndex);
      contentType = response.headers.get("content-type") || "image/png";
    }

    await onProgress?.(
      "uploading-output",
      `Uploading output ${outputIndex + 1} of ${allFiles.length} to media storage...`,
    );
    await s3.send(
      new PutObjectCommand({
        Bucket: bucketName,
        Key: key,
        Body: buffer,
        ContentType: contentType,
      }),
    );

    b2Keys.push(key);
    fileIndex++;
  }

  return { b2Keys, missed };
}

export const processGeneration = internalAction({
  args: {
    generationId: v.id("generations"),
    promptId: v.string(),
    backendType: v.string(),
    clientId: v.optional(v.string()),
    nodeLabels: v.optional(v.record(v.string(), v.string())),
  },
  handler: async (ctx, args) => {
    let watcher: ComfyProgressWatcher | undefined;
    try {
      const target = await resolveComfyuiTarget(ctx, args.backendType);
      const baseUrl = target.url;
      const headers = target.headers;

      await ctx.runMutation(internal.generations.updateGenerationStatus, {
        generationId: args.generationId,
        status: "processing",
      });

      const reportProgress = async (
        update: ComfyProgressUpdate & { queuePosition?: number; providerStatus?: string },
      ): Promise<void> => {
        try {
          await ctx.runMutation(internal.generations.updateGenerationProgress, {
            generationId: args.generationId,
            stage: update.stage,
            message: update.message,
            current: update.current,
            total: update.total,
            queuePosition: update.queuePosition,
            providerStatus: update.providerStatus,
          });
        } catch (error) {
          console.warn("[SelfHosted] could not publish progress", error);
        }
      };
      if (args.clientId) {
        watcher = watchComfyProgress({
          baseUrl,
          headers,
          clientId: args.clientId,
          promptId: args.promptId,
          nodeLabels: args.nodeLabels ?? {},
          media: "image",
          report: reportProgress,
        });
      }

      let attempts = 0;
      let lastQueueSignature = "";
      const startedAt = Date.now();
      const deadline = startedAt + POLL_BUDGET_MS;

      while (attempts < MAX_ATTEMPTS && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, POLL_DELAY_MS));

        let item: ComfyUIHistoryItem | undefined;
        try {
          const historyRes = await noCacheFetch(`${baseUrl}/history/${args.promptId}`, {
            headers,
            signal: AbortSignal.timeout(HISTORY_TIMEOUT_MS),
          });
          if (!historyRes.ok) {
            attempts++;
            continue;
          }
          const history: Record<string, ComfyUIHistoryItem> = await historyRes.json();
          item = history[args.promptId];
        } catch {
          attempts++;
          continue;
        }

        if (!item) {
          const queue = await fetchComfyQueueState({ baseUrl, headers, promptId: args.promptId });
          const signature = `${queue.state}|${queue.state === "queued" ? queue.position : ""}`;
          if (signature !== lastQueueSignature && queue.state !== "missing") {
            lastQueueSignature = signature;
            if (queue.state === "queued") {
              await reportProgress({
                stage: "provider-queued",
                message:
                  queue.position === 0
                    ? "Next on self-hosted backend..."
                    : `${queue.position} ${queue.position === 1 ? "job" : "jobs"} ahead on self-hosted backend...`,
                queuePosition: queue.position,
                providerStatus: "queued",
              });
            } else {
              await reportProgress({
                stage: "generating",
                message: "Running workflow on self-hosted backend...",
                providerStatus: "running",
              });
            }
          }
          attempts++;
          continue;
        }

        if (item.status?.status_str === "error") {
          const errorMsg = item.status.messages
            ? typeof item.status.messages === "string"
              ? item.status.messages
              : JSON.stringify(item.status.messages)
            : "Generation failed on backend";

          await ctx.runMutation(internal.generations.updateGenerationStatus, {
            generationId: args.generationId,
            status: "failed",
            error: errorMsg,
          });
          return;
        }

        if (item.status?.completed) {
          await watcher?.close();
          watcher = undefined;
          const { b2Keys, missed } = await collectAndUploadOutputs(
            baseUrl,
            headers,
            startedAt + ACTION_BUDGET_MS,
            item.outputs,
            async (stage, message) => {
              await reportProgress({ stage: stage as ComfyProgressUpdate["stage"], message });
            },
          );
          if (missed > 0) {
            console.error(`[SelfHosted] ${missed} output(s) were lost for prompt ${args.promptId}`);
          }

          if (b2Keys.length === 0) {
            await ctx.runMutation(internal.generations.updateGenerationStatus, {
              generationId: args.generationId,
              status: "failed",
              error: "Generation completed with no outputs",
            });
            return;
          }

          await reportProgress({
            stage: "finalizing",
            message: "Finalizing generation record...",
          });

          await ctx.runMutation(internal.generations.updateGenerationStatus, {
            generationId: args.generationId,
            status: "completed",
            b2Keys,
          });
          return;
        }

        attempts++;
      }

      await ctx.runMutation(internal.generations.updateGenerationStatus, {
        generationId: args.generationId,
        status: "failed",
        error: "Generation timed out",
      });
    } catch (error) {
      await ctx.runMutation(internal.generations.updateGenerationStatus, {
        generationId: args.generationId,
        status: "failed",
        error: error instanceof Error ? error.message : "Unknown error",
      });
    } finally {
      await watcher?.close();
    }
  },
});
