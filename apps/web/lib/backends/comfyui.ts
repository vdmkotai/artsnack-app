import { BaseBackend } from "./base";
import type {
  GenerationResult,
  GenerationStatus,
  GenerationWorkflow,
  HealthCheckResult,
} from "./types";
import { generateImageKey, uploadImage } from "@/lib/b2";
import { mediaUrl } from "@/lib/media-url";
import { addCacheBust, noCacheFetch, withNoCacheHeaders } from "@/lib/no-cdn-cache";
import { getComfyuiUrl } from "@/lib/comfyui-url";
import { comfyAuthHeadersForUrl } from "@/lib/comfyui-auth";

type ComfyUIPromptResponse = {
  prompt_id?: string;
};

type ComfyUIHistoryStatus = {
  completed?: boolean;
  status_str?: string;
  messages?: unknown;
};

type ComfyUIImage = {
  filename: string;
  subfolder?: string;
  type?: string;
};

type ComfyUIOutput = {
  images?: ComfyUIImage[];
  gifs?: ComfyUIImage[];
  videos?: ComfyUIImage[];
};

type ComfyUIHistoryItem = {
  status?: ComfyUIHistoryStatus;
  outputs?: Record<string, ComfyUIOutput>;
};

type ComfyUIHistoryResponse = Record<string, ComfyUIHistoryItem>;

const HEALTH_CHECK_TIMEOUT_MS = 5000;
const RESULT_POLL_DELAY_MS = 2000;
/** 110 x 2s stays inside the 300s `maxDuration` that /api/enhance declares. The
 *  B2 upload happens after the poll observes completion, so a poll that outlives
 *  its function loses the finished image outright. */
const RESULT_MAX_ATTEMPTS = 110;
/** A failed poll can cost far more than RESULT_POLL_DELAY_MS, so the attempt
 *  count alone no longer bounds the wall clock. Stop short of /api/enhance's
 *  300s maxDuration so the route reports a timeout instead of being killed. */
const RESULT_POLL_BUDGET_MS = 270_000;
/** ComfyUI serves /history from the same asyncio loop it blocks while loading a
 *  multi-GB checkpoint, so the first poll after a cold pod start routinely takes
 *  far longer than noCacheFetch's default. Answering slowly is not a failure. */
const HISTORY_TIMEOUT_MS = 90_000;
/** How many polls in a row may fail before the run is called off. A cold load is
 *  absorbed by HISTORY_TIMEOUT_MS above; a pod that refuses the connection fails
 *  fast, so this still surfaces a genuinely broken backend within seconds. */
const MAX_CONSECUTIVE_POLL_FAILURES = 3;
/** /view streams whole images and MP4s, so it gets its own leash instead of the
 *  short default noCacheFetch applies to JSON GETs. */
const MEDIA_DOWNLOAD_TIMEOUT_MS = 120_000;

class ComfyUIBackend extends BaseBackend {
  async healthCheck(): Promise<HealthCheckResult> {
    const baseUrl = await getComfyuiUrl();
    if (!baseUrl) {
      return {
        online: false,
        error: "ComfyUI base URL is not configured",
      };
    }

    const { signal, clear } = this.createTimeoutSignal(HEALTH_CHECK_TIMEOUT_MS);
    const start = Date.now();

    try {
      const response = await fetch(addCacheBust(`${baseUrl}/system_stats`), {
        method: "GET",
        cache: "no-store",
        headers: withNoCacheHeaders(this.buildHeaders(baseUrl)),
        signal,
      });

      if (!response.ok) {
        return {
          online: false,
          error: `Health check failed (${response.status})`,
        };
      }

      if (!response.headers.get("content-type")?.includes("application/json")) {
        return { online: false, error: "Health check returned a non-JSON response" };
      }
      const stats = (await response.json()) as unknown;
      if (!stats || typeof stats !== "object" || Array.isArray(stats)) {
        return { online: false, error: "Health check returned invalid system stats" };
      }
      const record = stats as Record<string, unknown>;
      if (
        !(
          (record.system !== null && typeof record.system === "object") ||
          Array.isArray(record.devices)
        )
      ) {
        return { online: false, error: "Health check did not return ComfyUI system stats" };
      }

      return {
        online: true,
        latency: Date.now() - start,
      };
    } catch (error) {
      return {
        online: false,
        error: error instanceof Error ? error.message : "Health check failed",
      };
    } finally {
      clear();
    }
  }

  async generate(workflow: GenerationWorkflow, clientId?: string): Promise<{ promptId: string }> {
    const baseUrl = await this.resolveBaseUrl();
    const promptData = await this.fetchJson<ComfyUIPromptResponse>(`${baseUrl}/prompt`, {
      method: "POST",
      headers: this.buildHeaders(baseUrl),
      body: JSON.stringify({
        prompt: workflow,
        client_id: clientId ?? crypto.randomUUID(),
      }),
    });

    if (!promptData.prompt_id) {
      throw new Error("No prompt ID returned from ComfyUI");
    }

    return { promptId: promptData.prompt_id };
  }

  async checkStatus(promptId: string): Promise<GenerationStatus> {
    const promptHistory = await this.fetchHistory(promptId);
    const status = promptHistory?.status;

    if (status?.status_str === "error") {
      return {
        completed: true,
        error: this.formatStatusError(status),
      };
    }

    return {
      completed: Boolean(status?.completed),
    };
  }

  async getResult(promptId: string): Promise<GenerationResult> {
    let attempts = 0;
    let consecutiveFailures = 0;
    const deadline = Date.now() + RESULT_POLL_BUDGET_MS;

    while (attempts < RESULT_MAX_ATTEMPTS && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, RESULT_POLL_DELAY_MS));

      let promptHistory: ComfyUIHistoryItem | undefined;
      try {
        promptHistory = await this.fetchHistory(promptId);
        consecutiveFailures = 0;
      } catch (error) {
        // One bad tick is not a failed generation: the pod may still be loading
        // the checkpoint, and the B2 upload happens inside collectImages below,
        // so throwing here abandons an image the pod goes on to produce.
        consecutiveFailures++;
        if (consecutiveFailures >= MAX_CONSECUTIVE_POLL_FAILURES) {
          throw error;
        }
        attempts++;
        continue;
      }

      const status = promptHistory?.status;

      if (status?.status_str === "error") {
        return {
          success: false,
          promptId,
          error: this.formatStatusError(status) || "Generation failed",
        };
      }

      if (status?.completed) {
        const result = await this.collectImages(promptHistory);
        if (result.images.length === 0) {
          return {
            success: false,
            promptId,
            error: "Generation completed with no images",
          };
        }

        return {
          success: true,
          promptId,
          images: result.images,
          b2Keys: result.b2Keys,
        };
      }

      attempts++;
    }

    return {
      success: false,
      promptId,
      error: "Generation timed out",
    };
  }

  private buildHeaders(baseUrl: string): HeadersInit {
    return {
      ...comfyAuthHeadersForUrl(process.env, baseUrl),
      "Content-Type": "application/json",
    };
  }

  private async resolveBaseUrl(): Promise<string> {
    const baseUrl = await getComfyuiUrl();
    if (!baseUrl) {
      throw new Error("ComfyUI base URL is not configured");
    }
    return baseUrl;
  }

  private async fetchHistory(promptId: string): Promise<ComfyUIHistoryItem> {
    const baseUrl = await this.resolveBaseUrl();
    const response = await noCacheFetch(`${baseUrl}/history/${promptId}`, {
      headers: this.buildHeaders(baseUrl),
      signal: AbortSignal.timeout(HISTORY_TIMEOUT_MS),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Request failed (${response.status}): ${errorText || "Unknown error"}`);
    }

    const history = (await response.json()) as ComfyUIHistoryResponse;
    return history[promptId];
  }

  private formatStatusError(status: ComfyUIHistoryStatus): string | undefined {
    if (!status.messages) {
      return undefined;
    }

    return typeof status.messages === "string" ? status.messages : JSON.stringify(status.messages);
  }

  private async collectImages(promptHistory?: ComfyUIHistoryItem): Promise<{
    images: Array<{ url: string; filename: string }>;
    b2Keys: string[];
  }> {
    const baseUrl = await this.resolveBaseUrl();
    const outputs = promptHistory?.outputs;
    const images: Array<{ url: string; filename: string }> = [];
    const b2Keys: string[] = [];

    if (!outputs) {
      return { images, b2Keys };
    }

    let imageIndex = 0;

    for (const nodeId of Object.keys(outputs)) {
      const nodeOutput = outputs[nodeId];

      if (nodeOutput?.images) {
        for (const img of nodeOutput.images) {
          const directUrl = `${baseUrl}/view?filename=${encodeURIComponent(
            img.filename,
          )}&subfolder=${encodeURIComponent(
            img.subfolder || "",
          )}&type=${encodeURIComponent(img.type || "output")}`;

          const imageResponse = await noCacheFetch(directUrl, {
            headers: this.buildHeaders(baseUrl),
            signal: AbortSignal.timeout(MEDIA_DOWNLOAD_TIMEOUT_MS),
          });
          if (!imageResponse.ok) {
            continue;
          }

          const imageBuffer = Buffer.from(await imageResponse.arrayBuffer());
          const contentType = imageResponse.headers.get("content-type") || "image/png";
          const key = generateImageKey(imageIndex);

          await uploadImage(imageBuffer, key, contentType);

          b2Keys.push(key);
          images.push({
            url: mediaUrl(key),
            filename: key,
          });
          imageIndex++;
        }
      }

      // ComfyUI SaveVideo node outputs MP4s under the "gifs" key
      if (nodeOutput?.gifs) {
        for (const vid of nodeOutput.gifs) {
          const uploaded = await this.downloadAndUploadVideo(vid, imageIndex);
          if (uploaded) {
            images.push(uploaded.image);
            b2Keys.push(uploaded.key);
            imageIndex++;
          }
        }
      }

      if (nodeOutput?.videos) {
        for (const vid of nodeOutput.videos) {
          const uploaded = await this.downloadAndUploadVideo(vid, imageIndex);
          if (uploaded) {
            images.push(uploaded.image);
            b2Keys.push(uploaded.key);
            imageIndex++;
          }
        }
      }
    }

    return { images, b2Keys };
  }

  private async downloadAndUploadVideo(
    file: ComfyUIImage,
    index: number,
  ): Promise<{ image: { url: string; filename: string }; key: string } | null> {
    const baseUrl = await this.resolveBaseUrl();
    const viewUrl = `${baseUrl}/view?filename=${encodeURIComponent(
      file.filename,
    )}&subfolder=${encodeURIComponent(
      file.subfolder || "",
    )}&type=${encodeURIComponent(file.type || "output")}`;

    const response = await noCacheFetch(viewUrl, {
      headers: this.buildHeaders(baseUrl),
      signal: AbortSignal.timeout(MEDIA_DOWNLOAD_TIMEOUT_MS),
    });
    if (!response.ok) {
      return null;
    }

    const buffer = Buffer.from(await response.arrayBuffer());
    const timestamp = Date.now();
    const random = Math.random().toString(36).substring(2, 8);
    const key = `videos/${timestamp}_${random}_${index}.mp4`;

    await uploadImage(buffer, key, "video/mp4");

    return {
      image: {
        url: mediaUrl(key),
        filename: key,
      },
      key,
    };
  }
}

let comfyUIBackend: ComfyUIBackend | null = null;

export function getComfyUIBackend(): ComfyUIBackend {
  if (!comfyUIBackend) {
    comfyUIBackend = new ComfyUIBackend();
  }

  return comfyUIBackend;
}
