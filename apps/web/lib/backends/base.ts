import type {
  GenerationBackend,
  GenerationResult,
  GenerationStatus,
  HealthCheckResult,
} from "./types";

const FETCH_JSON_TIMEOUT_MS = 30_000;

export abstract class BaseBackend implements GenerationBackend {
  abstract healthCheck(): Promise<HealthCheckResult>;
  abstract generate(
    workflow: Record<string, unknown>,
    clientId?: string,
  ): Promise<{ promptId: string }>;
  abstract checkStatus(promptId: string): Promise<GenerationStatus>;
  abstract getResult(promptId: string): Promise<GenerationResult>;

  protected createTimeoutSignal(timeoutMs: number): {
    signal: AbortSignal;
    clear: () => void;
  } {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    return {
      signal: controller.signal,
      clear: () => clearTimeout(timeoutId),
    };
  }

  protected async fetchJson<T>(input: RequestInfo | URL, init?: RequestInit): Promise<T> {
    const response = await fetch(input, {
      ...init,
      // ComfyUI's /prompt validates and queues, then answers — it never waits on
      // the GPU — so a request still open after this is a hung pod, not a slow
      // job. Callers can still supply their own signal.
      signal: init?.signal ?? AbortSignal.timeout(FETCH_JSON_TIMEOUT_MS),
    });
    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Request failed (${response.status}): ${errorText || "Unknown error"}`);
    }

    return (await response.json()) as T;
  }
}
