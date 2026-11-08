/**
 * Shared constants for the Atlas Cloud integration.
 *
 * Like fal, Atlas bills one account-level key from the Convex environment
 * rather than a per-user subscription, so nothing here touches Grok's
 * credentials or Higgsfield's rotating ones.
 *
 * The deadlines are the one place Atlas needs different numbers from fal, and
 * for a reason worth stating: **Atlas publishes no cancel endpoint.** When fal
 * hits its deadline we cancel the job and the reservation goes away; here the
 * job keeps running and keeps billing no matter what we do. So the budget is
 * set as high as the Convex action ceiling allows rather than as tight as the
 * common case needs — giving up early costs real money and buys nothing.
 */

import { OUTPUT_PREFIXES } from "../../shared/image-key";
import { AtlasError } from "../../shared/atlas-queue";
export { ATLAS_TOTAL_WAIT_MS } from "../../shared/atlas-lifecycle";

export const ATLAS_SUBMIT_TIMEOUT_MS = 60_000;
/*
 * A job is noticed as finished on average half an interval after Atlas settles
 * it, so the interval is pure added latency: at 3s it cost ~1.5s on a ~57s
 * Seedream edit. Atlas publishes no request-rate figure, only 429s counted per
 * account and model — the same bucket a submit draws from. So polling is fast
 * while Atlas answers cleanly and drops back to the old 3s for the rest of the
 * action after the first rate limit, 5xx or timeout.
 */
export const ATLAS_POLL_INTERVAL_MS = 1_000;
export const ATLAS_POLL_BACKOFF_MS = 3_000;
export const ATLAS_POLL_REQUEST_TIMEOUT_MS = 30_000;

/*
 * Waiting is split across actions, because one action cannot wait long enough.
 *
 * A Convex action is killed at ten minutes, and a killed isolate runs no catch
 * block — the row is then stranded in `processing` until the sweeper, which is
 * the worst outcome available. So a single action can never poll for more than
 * a few minutes without risking that, and the first version's five-minute video
 * budget was giving up on jobs that were still running and still being charged
 * for: a 15-second clip at 1080p regularly takes longer than that.
 *
 * Atlas returns a prediction id and polling it is free and idempotent, so the
 * wait can simply continue in a fresh action. `ATLAS_POLL_WINDOW_MS` is how long
 * one action polls before handing the id to the next; `ATLAS_TOTAL_WAIT_MS` is
 * the whole budget across the chain, measured from the first submission.
 *
 * The window leaves room for the tail inside the ceiling: 1 min submit + 4 min
 * polling + up to 3 min of download retries + the B2 upload is comfortably under
 * ten. The total was 16 minutes when 15 seconds was the longest clip on offer;
 * Seedance 2.5 sells a 30-second single pass at $4.02, and timing out on one
 * abandons a job Atlas finishes and bills anyway — so the budget doubled with
 * the clip length. It is bounded by the stalled-job sweeper, which marks a row
 * failed once it has been processing too long — see crons.ts, whose window had
 * to grow with this or it would have killed jobs that were healthy.
 */
export const ATLAS_POLL_WINDOW_MS = 4 * 60_000;
/** Per attempt, and withTransientRetry makes up to three of them. */
export const ATLAS_DOWNLOAD_TIMEOUT_MS = 60_000;

/** Refuse a download this large rather than buffering it inside the isolate. */
export const ATLAS_MAX_DOWNLOAD_BYTES = 400 * 1024 * 1024;

/**
 * Cap for inlining references as base64 when no public media URL is set. Atlas
 * accepts data URIs, but nine 4MB references would make a ~50MB request body.
 */
export const ATLAS_MAX_INLINE_REFERENCE_BYTES = 8 * 1024 * 1024;

/** B2 prefix for Atlas outputs, re-exported from the proxy's allowlist so the
 *  two cannot drift apart. */
export const ATLAS_OUTPUT_PREFIX = OUTPUT_PREFIXES.atlas;

export const ATLAS_MISSING_KEY_ERROR =
  "Atlas Cloud API key is not configured. Set ATLASCLOUD_API_KEY in the Convex environment " +
  "(bunx convex env set ATLASCLOUD_API_KEY …).";

export function requireAtlasKey(): string {
  const key = process.env.ATLASCLOUD_API_KEY;
  // Classified as auth so the failure is recorded as "nothing was billed".
  if (!key) throw new AtlasError(ATLAS_MISSING_KEY_ERROR, "auth");
  return key;
}
