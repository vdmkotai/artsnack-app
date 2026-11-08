/**
 * Thin REST client for Atlas Cloud's prediction API.
 *
 * Dependency-free for the same reason fal-queue.ts is: it runs inside a Convex
 * action and is exercised in plain unit tests. Retry policy lives with the
 * caller; this module speaks the protocol and classifies failures.
 *
 * Two things differ from fal in ways the caller has to know about.
 *
 * First, Atlas returns only an id — not a set of tracking URLs — so the poll
 * URL is built from the model's own `pollPath`. That path is *not* the same for
 * every model (`/model/prediction/{id}` and `/model/result/{id}` are both in
 * use), which is why it travels with the model descriptor rather than being a
 * constant here.
 *
 * Second, there is no cancel endpoint. A job we stop waiting for keeps running
 * and keeps billing, and nothing we send can stop it. The deadline therefore
 * has to be generous enough that hitting it means something is genuinely wrong,
 * because it is a real loss rather than an abandoned reservation.
 */

export const ATLAS_BASE_URL = "https://api.atlascloud.ai";

export type AtlasErrorKind =
  | "auth"
  | "billing"
  | "validation"
  | "moderation"
  | "rate_limit"
  | "server"
  | "timeout";

export class AtlasError extends Error {
  readonly kind: AtlasErrorKind;
  readonly status?: number;

  constructor(message: string, kind: AtlasErrorKind, status?: number) {
    super(message);
    this.name = "AtlasError";
    this.kind = kind;
    this.status = status;
  }
}

export type AtlasPrediction = {
  id: string;
  status: string;
  /** URLs to the generated media. Empty until the job completes. */
  outputs: string[];
  error?: string;
  /**
   * What Atlas actually charged, in USD. Present on settled predictions and
   * authoritative where our pre-flight estimate is a guess: token-billed
   * models (Seedance) charge by pixels × frames, which the published
   * per-second figure understates at anything above 480p.
   */
  priceUsd?: number;
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
  "violat",
];

const BILLING_HINTS = [
  "balance",
  "insufficient",
  "billing",
  "payment",
  "credit",
  "exhausted",
  "quota",
  "top up",
];

function includesAny(haystack: string, needles: string[]): boolean {
  const lower = haystack.toLowerCase();
  return needles.some((needle) => lower.includes(needle));
}

/**
 * Maps an HTTP failure onto something the UI can act on.
 *
 * The billing case is the one that must not be swallowed into a generic
 * failure: "your Atlas balance is empty" is a thing the user can fix, and
 * "generation failed" is not.
 */
export function classifyAtlasFailure(status: number, body: string): AtlasError {
  const detail = body.slice(0, 300).trim();
  const suffix = detail ? `: ${detail}` : "";

  if (status === 401) {
    return new AtlasError(`Atlas rejected the API key (HTTP 401)${suffix}`, "auth", status);
  }
  if (status === 402) {
    return new AtlasError(
      `Atlas account is out of balance — top it up to keep generating${suffix}`,
      "billing",
      status,
    );
  }
  if (status === 403) {
    const kind = includesAny(detail, BILLING_HINTS) ? "billing" : "auth";
    return new AtlasError(
      kind === "billing"
        ? `Atlas account is out of balance — top it up to keep generating${suffix}`
        : `Atlas denied the request (HTTP 403)${suffix}`,
      kind,
      status,
    );
  }
  if (status === 429) {
    return new AtlasError(`Atlas rate limit reached${suffix}`, "rate_limit", status);
  }
  if (status === 400 || status === 422) {
    if (includesAny(detail, MODERATION_HINTS)) {
      return new AtlasError(`Request rejected by moderation${suffix}`, "moderation", status);
    }
    return new AtlasError(
      `Atlas rejected the request (HTTP ${status})${suffix}`,
      "validation",
      status,
    );
  }
  if (includesAny(detail, BILLING_HINTS)) {
    return new AtlasError(
      `Atlas account is out of balance — top it up to keep generating${suffix}`,
      "billing",
      status,
    );
  }
  return new AtlasError(`Atlas request failed (HTTP ${status})${suffix}`, "server", status);
}

async function atlasFetch(
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
        Authorization: `Bearer ${apiKey}`,
      },
    });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Atlas wraps every reply in `{code, data, msg}` and does not always use the
 * HTTP status to say no — a 200 carrying `{"code":401}` has been observed. So
 * the envelope is checked even on a 2xx, and an in-band code is routed through
 * the same classifier as a real status.
 */
function unwrap(status: number, raw: string): Record<string, unknown> {
  let parsed: { code?: string | number; data?: unknown; msg?: string; message?: string };
  try {
    parsed = JSON.parse(raw) as typeof parsed;
  } catch {
    throw classifyAtlasFailure(status, raw);
  }

  const data =
    parsed.data && typeof parsed.data === "object"
      ? (parsed.data as Record<string, unknown>)
      : null;

  /*
   * A verdict inside `data` outranks the envelope's code.
   *
   * Atlas reports a *dead prediction* as an envelope failure: a job whose
   * upstream refused it comes back as `{code: 500, message: "api node returned
   * 401", data: {status: "failed", …}}`. Reading the code first turned that
   * into a transient server error, which the poll loop is built to swallow —
   * correctly, for a real blip — so a job that had been dead for fifty
   * milliseconds was polled for the full sixteen minutes and then recorded as a
   * timeout that had reached the vendor, keeping its estimated cost as spent.
   *
   * When `data` carries a terminal status it is the answer, not the transport.
   */
  if (data && typeof data.status === "string" && isAtlasFailed(data.status)) return data;

  const code = Number(parsed.code);
  if (Number.isFinite(code) && code !== 200 && code !== 0) {
    // Both spellings: the models list answers with `msg`, the prediction API
    // with `message`, and reading only one of them lost the reason.
    throw classifyAtlasFailure(code, parsed.message ?? parsed.msg ?? raw);
  }
  if (!data) {
    throw new AtlasError("Atlas returned a reply with no data object", "server", status);
  }
  return data;
}

/**
 * Outputs arrive as bare URL strings on most models and as `{url}` objects on a
 * few — the two response schemas differ on `outputs.items.type`. Normalised
 * here so the processor only ever sees strings.
 */
function readOutputs(data: Record<string, unknown>): string[] {
  // Ten schemas declare `output` rather than `outputs`, among them the default
  // image model. Reading only the plural would have completed and billed those
  // jobs and then thrown "returned no output", losing the result.
  const raw = data.outputs ?? data.output;
  if (!Array.isArray(raw)) return [];
  const urls: string[] = [];
  for (const entry of raw) {
    if (typeof entry === "string" && entry) urls.push(entry);
    else if (entry && typeof entry === "object") {
      const url = (entry as { url?: unknown }).url;
      if (typeof url === "string" && url) urls.push(url);
    }
  }
  return urls;
}

/**
 * A verdict read straight out of the body, whatever the HTTP status was.
 *
 * Atlas answers a *dead* prediction with an error status and the verdict in the
 * payload: `HTTP 500 {code: 500, message: "api node returned 401", data:
 * {status: "failed", …}}`. Both the status line and the envelope code say
 * "server error", which the poll loop swallows by design — so the answer has to
 * be taken from `data` before either of them is consulted, or a job that died in
 * fifty milliseconds is polled until the budget runs out.
 *
 * Returns null when the body carries no terminal status, which is the ordinary
 * case for a real transport error and leaves the existing handling alone.
 */
function terminalPrediction(raw: string): AtlasPrediction | null {
  let parsed: { data?: unknown };
  try {
    parsed = JSON.parse(raw) as typeof parsed;
  } catch {
    return null;
  }
  const data = parsed.data && typeof parsed.data === "object" ? parsed.data : null;
  if (!data) return null;
  const status = (data as { status?: unknown }).status;
  if (typeof status !== "string") return null;
  if (!isAtlasFailed(status) && !isAtlasSettled(status)) return null;
  return readPrediction(data as Record<string, unknown>);
}

function readPrediction(data: Record<string, unknown>): AtlasPrediction {
  const id = typeof data.id === "string" ? data.id : "";
  const status = typeof data.status === "string" ? data.status : "processing";
  const error = typeof data.error === "string" && data.error ? data.error : undefined;
  // Undocumented in their OpenAPI schemas but present on real predictions.
  // Zero is not a price — some models report 0 while the account is charged.
  const priceUsd = readAtlasPrice(data.price);
  return { id, status, outputs: readOutputs(data), error, priceUsd };
}

/** Atlas documents a number but returns a decimal string on real video jobs. */
export function readAtlasPrice(value: unknown): number | undefined {
  const parsed =
    typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

/**
 * Queues a job. Never retried by the caller: a socket dropped after Atlas
 * accepted the request would queue — and bill — a second one.
 */
export async function atlasSubmit(
  submitPath: string,
  payload: Record<string, unknown>,
  apiKey: string,
  timeoutMs: number,
): Promise<string> {
  const response = await atlasFetch(
    `${ATLAS_BASE_URL}${submitPath}`,
    apiKey,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    },
    timeoutMs,
  );

  const raw = await response.text().catch(() => "");
  if (!response.ok) throw classifyAtlasFailure(response.status, raw);

  const data = unwrap(response.status, raw);
  const id = data.id;
  if (typeof id !== "string" || !id) {
    throw new AtlasError("Atlas accepted the job but returned no prediction id", "server");
  }
  return id;
}

/** Builds the poll URL for a model. The template differs per model. */
export function atlasPollUrl(pollPath: string, requestId: string): string {
  return `${ATLAS_BASE_URL}${pollPath.replace("{request_id}", encodeURIComponent(requestId))}`;
}

export async function atlasPoll(
  pollPath: string,
  requestId: string,
  apiKey: string,
  timeoutMs: number,
): Promise<AtlasPrediction> {
  const response = await atlasFetch(atlasPollUrl(pollPath, requestId), apiKey, {}, timeoutMs);
  const raw = await response.text().catch(() => "");
  // Before the status line is judged: a dead prediction arrives as an HTTP 500
  // carrying `data.status: "failed"`, and treating that as a transport error is
  // what left jobs on a loader for sixteen minutes.
  const terminal = terminalPrediction(raw);
  if (terminal) return terminal;
  if (!response.ok) throw classifyAtlasFailure(response.status, raw);
  return readPrediction(unwrap(response.status, raw));
}

/**
 * Failures that mean the job will never run, so retrying is pointless and
 * nothing was billed. Everything else — rate limits, 5xx, aborted polls — is
 * worth waiting out, because the job may still be running and charging.
 */
const FATAL_KINDS: AtlasErrorKind[] = ["auth", "billing", "validation", "moderation"];

export function isFatalAtlasError(error: unknown): boolean {
  return error instanceof AtlasError && FATAL_KINDS.includes(error.kind);
}

/** Terminal states. Atlas reports both "completed" and "succeeded" for success. */
export function isAtlasSettled(status: string): boolean {
  const value = status.toLowerCase();
  return value === "completed" || value === "succeeded" || value === "success";
}

export function isAtlasFailed(status: string): boolean {
  const value = status.toLowerCase();
  return value === "failed" || value === "error" || value === "timeout" || value === "cancelled";
}
