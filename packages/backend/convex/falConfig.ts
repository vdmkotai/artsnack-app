import { OUTPUT_PREFIXES } from "../../shared/image-key";
/**
 * Shared constants for the fal.ai queue integration.
 *
 * Unlike Grok — which authenticates per user through a device-authorization
 * flow and bills against that person's SuperGrok subscription — fal uses one
 * account-level key held in the Convex environment and bills the account's
 * prepaid balance. Nothing here touches the Grok credentials.
 */

import { FalError } from "../../shared/fal-queue";

export const FAL_SUBMIT_TIMEOUT_MS = 60_000;
export const FAL_POLL_INTERVAL_MS = 2_000;
export const FAL_POLL_REQUEST_TIMEOUT_MS = 30_000;
export const FAL_CANCEL_TIMEOUT_MS = 10_000;

/*
 * Deadlines are measured from the moment the action starts, not from the moment
 * the job is accepted, and the whole budget has to fit inside Convex's
 * 10-minute action ceiling. If the isolate is killed instead, the catch block
 * never runs and the row is stranded in `processing` — recoverable only by the
 * sweeper in crons.ts, which is a far worse outcome than failing cleanly.
 *
 * Video worst case: 360s polling + 30s result fetch + 120s download ≈ 8.5 min,
 * leaving room for the B2 upload.
 */
export const FAL_IMAGE_DEADLINE_MS = 4 * 60_000;
export const FAL_VIDEO_DEADLINE_MS = 6 * 60_000;
export const FAL_DOWNLOAD_TIMEOUT_MS = 120_000;

/** Refuse a download this large rather than buffering it inside the isolate. */
export const FAL_MAX_DOWNLOAD_BYTES = 400 * 1024 * 1024;

/**
 * Cap for inlining references as base64 when no public media URL is configured.
 * Ten 4MB references would otherwise produce a ~55MB request body.
 */
export const FAL_MAX_INLINE_REFERENCE_BYTES = 8 * 1024 * 1024;

/** B2 prefix for fal outputs, kept separate from Grok's for traceability.
 *  Re-exported from the proxy's allowlist so the two cannot drift apart. */
export const FAL_OUTPUT_PREFIX = OUTPUT_PREFIXES.fal;

export const FAL_MISSING_KEY_ERROR =
  "fal API key is not configured. Set FAL_KEY in the Convex environment (bunx convex env set FAL_KEY …).";

export function requireFalKey(): string {
  const key = process.env.FAL_KEY;
  // Classified as auth so the failure is recorded as "nothing was billed".
  if (!key) throw new FalError(FAL_MISSING_KEY_ERROR, "auth");
  return key;
}
