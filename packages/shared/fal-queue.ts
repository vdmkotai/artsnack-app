/**
 * Thin REST client for fal's queue (https://queue.fal.run).
 *
 * Deliberately dependency-free so it can be imported from a Convex action and
 * exercised in plain unit tests. Retry policy lives with the caller — this
 * module only speaks the protocol and classifies failures.
 *
 * Note that submit returns the URLs to poll. We use those verbatim instead of
 * rebuilding them: the path for a nested endpoint like
 * `bytedance/seedance-2.0/mini/image-to-video` is not derivable by a rule that
 * holds across every model family.
 */

export const FAL_QUEUE_BASE_URL = "https://queue.fal.run";

export type FalErrorKind =
  | "auth"
  | "billing"
  | "validation"
  | "moderation"
  | "rate_limit"
  | "server"
  | "timeout";

export class FalError extends Error {
  readonly kind: FalErrorKind;
  readonly status?: number;

  constructor(message: string, kind: FalErrorKind, status?: number) {
    super(message);
    this.name = "FalError";
    this.kind = kind;
    this.status = status;
  }
}

export type FalSubmission = {
  requestId: string;
  statusUrl: string;
  responseUrl: string;
  cancelUrl?: string;
  queuePosition?: number;
};

export type FalQueueStatus = {
  status: string;
  queuePosition?: number;
  error?: string;
  logs: Array<{ message: string; timestamp?: string }>;
};

export type FalImage = {
  url: string;
  width?: number;
  height?: number;
  content_type?: string;
  file_name?: string;
};

export type FalImageResult = { images?: FalImage[]; seed?: number };
export type FalVideoResult = {
  video?: { url?: string; content_type?: string; file_name?: string };
  seed?: number;
};

const MODERATION_HINTS = [
  "content policy",
  "content_policy",
  "moderation",
  "sensitive",
  "nsfw",
  "prohibited",
  "not allowed",
  "safety",
];

const BILLING_HINTS = [
  "balance",
  "insufficient",
  "billing",
  "payment",
  "credit",
  "exhausted",
  "quota",
];

function includesAny(haystack: string, needles: string[]): boolean {
  const lower = haystack.toLowerCase();
  return needles.some((needle) => lower.includes(needle));
}

/**
 * Maps an HTTP failure onto something the UI can act on. The distinction that
 * matters most is billing: "top up your fal balance" must never surface as a
 * generic "generation failed".
 */
export function classifyFalFailure(status: number, body: string): FalError {
  const detail = body.slice(0, 300).trim();
  const suffix = detail ? `: ${detail}` : "";

  if (status === 401) {
    return new FalError(`fal rejected the API key (HTTP 401)${suffix}`, "auth", status);
  }
  if (status === 402) {
    return new FalError(
      `fal account is out of balance — top it up to keep generating${suffix}`,
      "billing",
      status,
    );
  }
  if (status === 403) {
    const kind = includesAny(detail, BILLING_HINTS) ? "billing" : "auth";
    const message =
      kind === "billing"
        ? `fal account is out of balance — top it up to keep generating${suffix}`
        : `fal denied the request (HTTP 403)${suffix}`;
    return new FalError(message, kind, status);
  }
  if (status === 429) {
    return new FalError(`fal rate limit reached${suffix}`, "rate_limit", status);
  }
  if (status === 400 || status === 422) {
    if (includesAny(detail, MODERATION_HINTS)) {
      return new FalError(`Prompt rejected by ByteDance moderation${suffix}`, "moderation", status);
    }
    return new FalError(`fal rejected the request (HTTP ${status})${suffix}`, "validation", status);
  }
  if (includesAny(detail, BILLING_HINTS)) {
    return new FalError(
      `fal account is out of balance — top it up to keep generating${suffix}`,
      "billing",
      status,
    );
  }
  return new FalError(`fal request failed (HTTP ${status})${suffix}`, "server", status);
}

async function falFetch(
  url: string,
  apiKey: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      ...init,
      signal: controller.signal,
      headers: {
        ...(init.headers as Record<string, string> | undefined),
        Authorization: `Key ${apiKey}`,
      },
    });
  } finally {
    clearTimeout(timer);
  }
}

export async function falSubmit(
  endpoint: string,
  payload: Record<string, unknown>,
  apiKey: string,
  timeoutMs: number,
): Promise<FalSubmission> {
  const response = await falFetch(
    `${FAL_QUEUE_BASE_URL}/${endpoint}`,
    apiKey,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    },
    timeoutMs,
  );

  if (!response.ok) {
    throw classifyFalFailure(response.status, await response.text().catch(() => ""));
  }

  const data = (await response.json()) as {
    request_id?: string;
    status_url?: string;
    response_url?: string;
    cancel_url?: string;
    queue_position?: number;
  };

  if (!data.request_id || !data.status_url || !data.response_url) {
    throw new FalError("fal accepted the job but returned no tracking URLs", "server");
  }

  return {
    requestId: data.request_id,
    statusUrl: data.status_url,
    responseUrl: data.response_url,
    cancelUrl: data.cancel_url,
    queuePosition: data.queue_position,
  };
}

export async function falStatus(
  statusUrl: string,
  apiKey: string,
  timeoutMs: number,
): Promise<FalQueueStatus> {
  const response = await falFetch(falStatusUrl(statusUrl), apiKey, {}, timeoutMs);
  if (!response.ok) {
    throw classifyFalFailure(response.status, await response.text().catch(() => ""));
  }
  return parseFalQueueStatus(await response.json());
}

export function falStatusUrl(statusUrl: string): string {
  const url = new URL(statusUrl);
  // fal only includes runner messages when explicitly requested. These are the
  // provider's supported user-facing progress channel, not deployment logs.
  url.searchParams.set("logs", "1");
  return url.toString();
}

export function parseFalQueueStatus(data: unknown): FalQueueStatus {
  const status =
    typeof data === "object" && data !== null
      ? (data as {
          status?: string;
          queue_position?: number;
          error?: string;
          logs?: unknown;
        })
      : {};
  const logs = Array.isArray(status.logs) ? status.logs : [];
  return {
    status: status.status ?? "IN_PROGRESS",
    queuePosition: status.queue_position,
    error: status.error,
    logs: logs.flatMap((entry) =>
      typeof entry === "object" &&
      entry !== null &&
      typeof (entry as { message?: unknown }).message === "string" &&
      (entry as { message: string }).message
        ? [
            {
              message: (entry as { message: string }).message,
              ...(typeof (entry as { timestamp?: unknown }).timestamp === "string"
                ? { timestamp: (entry as { timestamp: string }).timestamp }
                : {}),
            },
          ]
        : [],
    ),
  };
}

export async function falResult<T>(
  responseUrl: string,
  apiKey: string,
  timeoutMs: number,
): Promise<T> {
  const response = await falFetch(responseUrl, apiKey, {}, timeoutMs);
  if (!response.ok) {
    throw classifyFalFailure(response.status, await response.text().catch(() => ""));
  }
  return (await response.json()) as T;
}

/** Best-effort abandonment of a job we have stopped waiting for. Never throws:
 *  the caller is already on a failure path and a live job left running would
 *  keep billing regardless of what we report. */
export async function falCancel(
  cancelUrl: string,
  apiKey: string,
  timeoutMs: number,
): Promise<void> {
  try {
    await falFetch(cancelUrl, apiKey, { method: "PUT" }, timeoutMs);
  } catch {
    // Nothing useful to do — the deadline error is the one worth surfacing.
  }
}

/**
 * Failures that mean the job will never run, so retrying is pointless and
 * nothing was billed. Everything else — rate limits, 5xx, aborted polls — is
 * worth waiting out, because the job itself may still be running and charging.
 */
const FATAL_KINDS: FalErrorKind[] = ["auth", "billing", "validation", "moderation"];

export function isFatalFalError(error: unknown): boolean {
  return error instanceof FalError && FATAL_KINDS.includes(error.kind);
}

/** True when the vendor never executed the job, so no charge was incurred. */
export function isUnbilledFailure(errorKind: string | undefined): boolean {
  return errorKind !== undefined && (FATAL_KINDS as string[]).includes(errorKind);
}

/** Terminal states reported by the queue. */
export function isQueueSettled(status: string): boolean {
  return status === "COMPLETED" || status === "OK";
}

export function isQueueFailed(status: string): boolean {
  return status === "FAILED" || status === "ERROR" || status === "CANCELLED";
}
