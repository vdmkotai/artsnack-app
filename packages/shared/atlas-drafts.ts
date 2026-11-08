/**
 * Seedance 2.5 drafts: a cheap 480p preview that can be finished at 1080p
 * without re-running it.
 *
 * Seedance 2.5's three endpoints take `draft: true`, which renders at 480p and
 * bills as a normal 480p clip. The draft's own prediction id is then its
 * `draft_id`, and `bytedance/seedance-2.5/draft-complete` renders the final at
 * 1080p "from the draft's own prompt, inputs, duration, aspect ratio, seed and
 * audio settings" — anything sent again is ignored — any number of times
 * within seven days. We store the prediction id on every Atlas row (in the
 * misnamed `falRequestId`), so a finished draft carries everything the
 * completion needs.
 *
 * Shared by the web results grid and the native one, so both offer the same
 * action on the same rows.
 */

import { getAtlasModel, isAtlasModelId, type AtlasParamValue } from "./atlas-models";
import { ATLAS_MIN_BILLED_SECONDS } from "./atlas-price";

export const SEEDANCE_DRAFT_COMPLETE_MODEL = "bytedance/seedance-2.5/draft-complete";

/** How long Atlas keeps a draft completable. */
export const SEEDANCE_DRAFT_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;

const DRAFT_SOURCES = /^bytedance\/seedance-2\.5\/(?:text|image|reference)-to-video$/;

/** The fields of a result row this reads; a Convex `grokGenerations` row fits. */
export type AtlasDraftRow = {
  provider?: string;
  apiModel?: string;
  atlasParams?: Record<string, AtlasParamValue>;
  falRequestId?: string;
  status?: string;
  prompt?: string;
  _creationTime: number;
};

/** Whether the row is a Seedance 2.5 draft, finished or not. */
export function isAtlasDraft(row: AtlasDraftRow): boolean {
  return (
    row.provider === "atlas" &&
    typeof row.apiModel === "string" &&
    DRAFT_SOURCES.test(row.apiModel) &&
    row.atlasParams?.draft === true
  );
}

/**
 * Whether the row is a finished draft the completion endpoint can be pointed
 * at. Says nothing about its age, so it is safe to call while rendering; the
 * seven-day limit is checked by `atlasDraftCompletion` when the action runs.
 */
export function isCompletableDraft(row: AtlasDraftRow): boolean {
  return isAtlasDraft(row) && row.status === "completed" && Boolean(row.falRequestId);
}

/**
 * The completion request for a finished draft still inside its seven days, or
 * null.
 */
export function atlasDraftCompletion(
  row: AtlasDraftRow,
  now: number,
): { model: string; prompt: string; params: { draft_id: string } } | null {
  if (!isCompletableDraft(row) || !row.falRequestId) return null;
  if (now - row._creationTime > SEEDANCE_DRAFT_LIFETIME_MS) return null;
  if (!isAtlasModelId(SEEDANCE_DRAFT_COMPLETE_MODEL)) return null;
  if (getAtlasModel(SEEDANCE_DRAFT_COMPLETE_MODEL).retired) return null;
  return {
    model: SEEDANCE_DRAFT_COMPLETE_MODEL,
    // Not sent — the completion has no prompt field — but it names the new
    // row in the grid, Search and History the way the draft did.
    prompt: row.prompt ?? "",
    params: { draft_id: row.falRequestId },
  };
}

/**
 * What finishing the draft will cost: the completion's per-second rate over
 * the draft's own length. The completion endpoint has no duration of its own,
 * so the catalogue alone cannot price it.
 */
export function atlasDraftCompletionUsd(row: AtlasDraftRow): number | null {
  const duration = row.atlasParams?.duration;
  if (typeof duration !== "number" || duration <= 0) return null;
  const model = getAtlasModel(SEEDANCE_DRAFT_COMPLETE_MODEL);
  if (model.basePrice === null) return null;
  return model.basePrice * Math.max(ATLAS_MIN_BILLED_SECONDS, duration);
}
