"use node";

import { PutObjectCommand } from "@aws-sdk/client-s3";

import { noCacheFetch } from "../../shared/no-cdn-cache";
import { getS3Client } from "./mediaPipeline";
import type { ComfyuiTarget } from "./comfyuiTarget";

/**
 * Talking to a ComfyUI pod: submit a graph, wait for it, put the outputs in B2.
 *
 * `generationProcessor` has its own copy of this, deliberately left alone — it
 * carries a wall-clock budget shared with its poll loop and reports how many
 * files it missed, neither of which a synchronous enhancement needs. This is the
 * simpler shape, used by the paths that were Next routes until recently.
 */

const POLL_DELAY_MS = 2000;
/** Comfortably inside the 10-minute action ceiling, with room to collect. */
const POLL_BUDGET_MS = 7 * 60_000;
/** `/history` is served from the loop ComfyUI blocks while loading a checkpoint,
 *  so the first poll after a cold start is legitimately slow. */
const HISTORY_TIMEOUT_MS = 90_000;
const DOWNLOAD_TIMEOUT_MS = 120_000;

export async function submitToPod(
  workflow: Record<string, unknown>,
  target: ComfyuiTarget,
): Promise<string> {
  const response = await noCacheFetch(`${target.url}/prompt`, {
    method: "POST",
    headers: { ...target.headers, "Content-Type": "application/json" },
    body: JSON.stringify({ prompt: workflow }),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`Backend refused the job (${response.status}) ${detail}`.trim());
  }
  const { prompt_id: promptId } = (await response.json()) as { prompt_id?: string };
  if (!promptId) throw new Error("Backend accepted the job but returned no prompt id");
  return promptId;
}

type ComfyFile = { filename: string; subfolder?: string; type?: string };

/**
 * Poll until the job finishes, then put every output in B2 and return the keys.
 *
 * An empty result is not necessarily an error — face detection legitimately
 * produces nothing when there are no faces — so the caller decides what silence
 * means rather than this throwing on it.
 */
export async function collectComfyOutputs(
  promptId: string,
  target: ComfyuiTarget,
): Promise<string[]> {
  const base = target.url;
  const headers = target.headers;
  const deadline = Date.now() + POLL_BUDGET_MS;

  let outputs: Record<string, { images?: ComfyFile[] }> | undefined;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, POLL_DELAY_MS));
    const response = await noCacheFetch(`${base}/history/${promptId}`, {
      headers,
      signal: AbortSignal.timeout(HISTORY_TIMEOUT_MS),
    }).catch(() => null);
    if (!response?.ok) continue;

    const history = (await response.json()) as Record<
      string,
      { status?: { completed?: boolean; status_str?: string }; outputs?: typeof outputs }
    >;
    const entry = history?.[promptId];
    if (!entry?.status) continue;
    if (entry.status.status_str === "error") throw new Error("The backend reported an error");
    if (entry.status.completed) {
      outputs = entry.outputs;
      break;
    }
  }
  if (outputs === undefined) throw new Error("The backend stopped reporting before it finished");

  const bucket = process.env.B2_BUCKET_NAME;
  if (!bucket) throw new Error("B2_BUCKET_NAME not configured");
  const s3 = getS3Client();

  const keys: string[] = [];
  let index = 0;
  for (const node of Object.values(outputs)) {
    for (const file of node?.images ?? []) {
      const params = new URLSearchParams({
        filename: file.filename,
        subfolder: file.subfolder ?? "",
        type: file.type ?? "output",
      });
      // /view returns full-resolution PNGs, so it needs its own deadline rather
      // than noCacheFetch's default, which is sized for small JSON GETs.
      const download = await noCacheFetch(`${base}/view?${params}`, {
        headers,
        signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
      }).catch(() => null);
      if (!download?.ok) continue;

      const key = `enhancements/${Date.now()}_${Math.random().toString(36).slice(2, 8)}_${index}.png`;
      await s3.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: key,
          Body: Buffer.from(await download.arrayBuffer()),
          ContentType: download.headers.get("content-type") ?? "image/png",
        }),
      );
      keys.push(key);
      index++;
    }
  }
  return keys;
}
