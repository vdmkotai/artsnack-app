import { OUTPUT_PREFIXES } from "../../shared/image-key";
/**
 * Constants for the Higgsfield integration.
 *
 * Higgsfield publishes a CLI and an MCP server rather than a documented REST
 * API, so generations go through a small container that runs that CLI (see
 * worker/). Convex talks to the worker over HTTP; the worker talks to
 * Higgsfield. Nothing here touches the Grok or fal credentials.
 */

export const HIGGSFIELD_WORKER_TIMEOUT_MS = 180_000;
/*
 * Every poll is a full worker invocation that writes the credentials file and
 * runs the CLI, and each run may rotate the refresh token. Polling hard would
 * mean a hundred rotations per video and a real chance of racing two
 * generations into a lost token — which costs a manual re-login.
 */
export const HIGGSFIELD_POLL_INTERVAL_MS = 8_000;
export const HIGGSFIELD_POLL_REQUEST_TIMEOUT_MS = 60_000;
/** Measured from the action start, inside Convex's 10-minute ceiling. */
export const HIGGSFIELD_IMAGE_DEADLINE_MS = 4 * 60_000;
export const HIGGSFIELD_VIDEO_DEADLINE_MS = 6 * 60_000;
export const HIGGSFIELD_DOWNLOAD_TIMEOUT_MS = 120_000;
/**
 * Hard wall for a whole action, comfortably inside Convex's 10-minute ceiling.
 * Everything after the poll loop — downloads, uploads, the balance refresh —
 * is measured against this, because an isolate killed at the ceiling runs no
 * catch block and strands the row in `processing`.
 */
export const HIGGSFIELD_ACTION_BUDGET_MS = 8 * 60_000;
export const HIGGSFIELD_MAX_DOWNLOAD_BYTES = 400 * 1024 * 1024;

/**
 * How many of one user's Higgsfield jobs may be in flight at once.
 *
 * Higgsfield has no batch parameter, so four images is four jobs — and nothing
 * stopped a second click from adding four more on top. Sixteen at once is what
 * broke: their side failed most of the batch, and every worker call re-reads and
 * may rotate the same shared refresh token, so the more of them overlap the
 * likelier one is presenting a token a sibling has already replaced. Four is one
 * click's worth, which has never failed; eight has been observed to work, so the
 * env var is there to raise it without a deploy.
 */
export const HIGGSFIELD_DEFAULT_MAX_CONCURRENT = 4;

export function higgsfieldMaxConcurrent(): number {
  const raw = Number(process.env.HIGGSFIELD_MAX_CONCURRENT);
  // A zero or a typo would wedge the queue outright, so only a sane figure wins.
  return Number.isFinite(raw) && raw >= 1 ? Math.floor(raw) : HIGGSFIELD_DEFAULT_MAX_CONCURRENT;
}

/**
 * How long a job may sit waiting for a slot before the sweeper gives up on it.
 *
 * Waiting is not stalling, so a queued row is exempt from the ordinary stalled
 * window — otherwise a long queue would be culled the moment it passed fifteen
 * minutes. This is the backstop for the case the ordinary window cannot cover:
 * a dispatcher that never runs again would otherwise strand its queue forever.
 */
export const HIGGSFIELD_QUEUE_CEILING_MS = 2 * 60 * 60_000;

/** B2 prefix for Higgsfield outputs. Re-exported from the proxy's allowlist so
 *  a folder the media route refuses can never be uploaded to. */
export const HIGGSFIELD_OUTPUT_PREFIX = OUTPUT_PREFIXES.higgsfield;

/** How long a cached credit quote stays fresh before it is re-fetched. */
export const HIGGSFIELD_COST_TTL_MS = 24 * 60 * 60_000;
/** Balance is cheap to read and changes with every generation. */
export const HIGGSFIELD_BALANCE_TTL_MS = 60_000;

export const HIGGSFIELD_MISSING_WORKER_ERROR =
  "Higgsfield worker is not configured. Set HIGGSFIELD_WORKER_URL and HIGGSFIELD_WORKER_SECRET in the Convex environment.";

export const HIGGSFIELD_MISSING_CREDENTIALS_ERROR =
  "Higgsfield is not connected. Run `higgsfield auth login` locally, then store the credentials file with: cat ~/Library/Application\\ Support/higgsfield/credentials.json | bunx convex env set HIGGSFIELD_CREDENTIALS";

export function requireWorker(): { url: string; secret: string } {
  const url = process.env.HIGGSFIELD_WORKER_URL;
  const secret = process.env.HIGGSFIELD_WORKER_SECRET;
  if (!url || !secret) throw new Error(HIGGSFIELD_MISSING_WORKER_ERROR);
  return { url: url.replace(/\/+$/, ""), secret };
}

/** Optional: pins the billing workspace when an account has more than one. */
export function higgsfieldWorkspaceId(): string | undefined {
  return process.env.HIGGSFIELD_WORKSPACE_ID || undefined;
}
