/**
 * The two table shapes, and how each becomes tiles.
 *
 * A row with four outputs is four tiles, which is why these return arrays.
 * Shared by the feed and by search so a row can never render one way in one
 * place and differently in the other.
 */

import type { FailureRecord } from "@/convex/failures";

import { aspectFrom, type FeedItem } from "./types";

export type LocalRow = {
  _id: string;
  timestamp: number;
  status?: "pending" | "processing" | "completed" | "failed";
  b2Keys?: string[];
  error?: string;
  progressStage?: string;
  progressMessage?: string;
  progressCurrent?: number;
  progressTotal?: number;
  queuePosition?: number;
  providerStatus?: string;
  formState: { prompt: string; width: number; height: number };
};

export function fromLocalRow(row: LocalRow): FeedItem[] {
  const aspect = aspectFrom(undefined, row.formState.width, row.formState.height);
  const base = {
    source: "local" as const,
    rowId: row._id,
    createdAt: row.timestamp,
    kind: "image" as const,
    prompt: row.formState.prompt,
    aspect,
    error: row.error,
    progressStage: row.progressStage,
    progressMessage: row.progressMessage,
    progressCurrent: row.progressCurrent,
    progressTotal: row.progressTotal,
    queuePosition: row.queuePosition,
    providerStatus: row.providerStatus,
  };
  const keys = row.b2Keys ?? [];
  // Rows written by `save` carry no status at all — those are finished by
  // definition, which is why the fallback is "completed" and not "pending".
  const status = row.status ?? "completed";
  if (keys.length === 0) return [{ ...base, id: row._id, status }];
  return keys.map((key, index) => ({ ...base, id: `${row._id}:${index}`, mediaKey: key, status }));
}

export type HostedRow = {
  _id: string;
  createdAt: number;
  status: "pending" | "processing" | "completed" | "failed";
  mediaType: "image" | "video";
  prompt: string;
  aspectRatio?: string;
  count?: number;
  b2Key?: string;
  b2Keys?: string[];
  errorKind?: string;
  error?: string;
  progressStage?: string;
  progressMessage?: string;
  progressCurrent?: number;
  progressTotal?: number;
  queuePosition?: number;
  providerStatus?: string;
  dispatchedAt?: number;
};

export function fromHostedRow(row: HostedRow): FeedItem[] {
  const keys = row.b2Keys ?? (row.b2Key ? [row.b2Key] : []);
  const base = {
    source: "api" as const,
    rowId: row._id,
    createdAt: row.createdAt,
    kind: row.mediaType,
    prompt: row.prompt,
    aspect: aspectFrom(row.aspectRatio),
    status: row.status,
    errorKind: row.errorKind,
    error: row.error,
    progressStage: row.progressStage,
    progressMessage: row.progressMessage,
    progressCurrent: row.progressCurrent,
    progressTotal: row.progressTotal,
    queuePosition: row.queuePosition,
    providerStatus: row.providerStatus,
    dispatchedAt: row.dispatchedAt,
    // A completed image row can hold fewer outputs than were requested — Grok
    // returns moderation refusals as empty responses, so part of a fan-out can
    // vanish. Both numbers travel so the tile can say "1 of 4".
    requestedCount: row.count,
    producedCount: keys.length,
  };
  if (keys.length === 0) return [{ ...base, id: row._id }];
  return keys.map((key, index) => ({ ...base, id: `${row._id}:${index}`, mediaKey: key }));
}

/**
 * A self-hosted clip.
 *
 * Its own table and its own shape: one video per row rather than a fan-out, a
 * poster frame rendered separately because the file is too big to decode for a
 * thumbnail, and dimensions on the settings rather than the row.
 */
export type VideoRow = {
  _id: string;
  createdAt: number;
  /** The same four the grid draws — see convex/videoValidators.ts. */
  status: "pending" | "processing" | "completed" | "failed";
  videoKey?: string;
  thumbnailKey?: string;
  error?: string;
  progressStage?: string;
  progressMessage?: string;
  progressCurrent?: number;
  progressTotal?: number;
  queuePosition?: number;
  providerStatus?: string;
  settings: { prompt: string; width: number; height: number };
};

export function fromVideoRow(row: VideoRow): FeedItem[] {
  return [
    {
      id: row._id,
      source: "video",
      rowId: row._id,
      createdAt: row.createdAt,
      kind: "video",
      mediaKey: row.videoKey,
      // Rendered instead of the clip: one frame rather than megabytes, which is
      // what keeps the grid from pulling video over cellular. See feed/tile.tsx.
      thumbnailKey: row.thumbnailKey,
      status: row.status,
      prompt: row.settings.prompt,
      aspect: aspectFrom(undefined, row.settings.width, row.settings.height),
      error: row.error,
      progressStage: row.progressStage,
      progressMessage: row.progressMessage,
      progressCurrent: row.progressCurrent,
      progressTotal: row.progressTotal,
      queuePosition: row.queuePosition,
      providerStatus: row.providerStatus,
    },
  ];
}

/**
 * An enhanced picture.
 *
 * Its prompt is the one that made the original where there is one — an
 * enhancement is a second pass over somebody's image, not a new idea — so the
 * mode is what the tile has to say, and it says it through the row's own label
 * rather than a prompt it does not have.
 */
export type EnhancementRow = {
  _id: string;
  timestamp: number;
  mode: string;
  resultB2Key: string;
  params?: { prompt?: string; width?: number; height?: number } | null;
  warning?: string;
};

const ENHANCE_TITLES: Record<string, string> = {
  upscale: "Upscaled",
  facefix: "Face fixed",
  refine: "Refined",
  img2img: "Reimagined",
};

export function fromEnhancementRow(row: EnhancementRow): FeedItem[] {
  // A run that produced nothing still writes a row — `resultB2Key: outputs[0] ?? ""`
  // in enhanceProcessor — and it is the "no faces detected" case, which already
  // said so in an alert at the time. Rendered, an empty key is not a missing file
  // but a *pending* one to every grid in the app, so it would shimmer forever on a
  // tile that can never open.
  if (!row.resultB2Key) return [];
  /**
   * Only img2img takes a prompt, and only its dimensions were asked for.
   *
   * `runEnhancement` spreads the whole form state into `params` for every mode, so
   * an upscale carries whatever happened to be typed at the time and the size of a
   * generation nobody ran. Reading either for the other modes labels a picture with
   * text that had nothing to do with making it, and lays it out at a shape it is
   * not. The web guards the same field for the same reason — see `promptOf` in
   * app/enhance/page.tsx.
   */
  const params = row.mode === "img2img" ? (row.params ?? undefined) : undefined;
  return [
    {
      id: row._id,
      source: "enhance",
      rowId: row._id,
      createdAt: row.timestamp,
      kind: "image",
      mediaKey: row.resultB2Key,
      status: "completed",
      prompt: params?.prompt?.trim() || (ENHANCE_TITLES[row.mode] ?? row.mode),
      // Nothing records the output's dimensions — an upscale changes them and the
      // result is never measured back — so anything but img2img lays out square and
      // the image settles into it. Better than a stated ratio that is wrong.
      aspect: aspectFrom(undefined, params?.width, params?.height),
      // Not a failure: the detector found nothing to work on. The tile carries it
      // the way a short fan-out carries its shortfall note.
      error: row.warning,
    },
  ];
}

/**
 * A failure, from the projection `convex/failures.ts` returns.
 *
 * Its own shape because failures are read off the status indexes rather than the
 * feed's, and what a red tile and its sheet need is a fraction of a row: no
 * media, no settings, just what was asked for and what went wrong. The type is
 * the query's own — restating it here would be one more pair to keep in step.
 */
export function fromFailureRecord(record: FailureRecord): FeedItem {
  return {
    id: record.id,
    source: record.source,
    rowId: record.id,
    createdAt: record.createdAt,
    kind: record.kind,
    status: "failed",
    prompt: record.prompt,
    aspect: aspectFrom(record.aspectRatio, record.width, record.height),
    errorKind: record.errorKind,
    error: record.error,
  };
}
