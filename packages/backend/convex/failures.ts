import { query, type QueryCtx } from "./_generated/server";
import { allowedUserOrNull } from "./authz";

/**
 * Everything that went wrong, across every table that can hold a failure.
 *
 * Failures are the one view that must not be paged by time. The Library reaches
 * them through a chip, and the chip's number comes from the `by_user_status_*`
 * indexes — history-wide — while the grid used to page the ordinary by-time
 * cursors and drop every row that had succeeded. One old failure behind eight
 * hundred good rows therefore lit a chip over a grid that could never reach it,
 * and an empty list does not scroll, so there was no way to ask for more.
 *
 * So this reads the status indexes directly: bounded, merged, newest first, and
 * projected down to what a failed tile and its sheet actually draw — a clip's
 * row carries its whole LoRA chain and advanced settings, none of which anyone
 * reads to find out why it failed.
 *
 * `count` exists beside it because the chip is drawn before the view is opened,
 * and a count is cheaper than the rows.
 */
const CAP = 200;

/** One more than the cap, so "exactly CAP" is distinguishable from "more". */
const PROBE = CAP + 1;

export type FailureRecord = {
  id: string;
  source: "local" | "api" | "video";
  createdAt: number;
  kind: "image" | "video";
  prompt: string;
  errorKind?: string;
  error?: string;
  width?: number;
  height?: number;
  aspectRatio?: string;
};

async function failedRows(ctx: QueryCtx, userId: string) {
  return await Promise.all([
    ctx.db
      .query("generations")
      .withIndex("by_user_status_timestamp", (q) => q.eq("userId", userId).eq("status", "failed"))
      .order("desc")
      .take(PROBE),
    ctx.db
      .query("grokGenerations")
      .withIndex("by_user_status_createdAt", (q) => q.eq("userId", userId).eq("status", "failed"))
      .order("desc")
      .take(PROBE),
  ]);
}

export const count = query({
  args: {},
  handler: async (ctx) => {
    const identity = await allowedUserOrNull(ctx);
    if (!identity) return { total: 0, capped: false };

    const rows = await failedRows(ctx, identity.subject);
    return {
      total: rows.reduce((sum, side) => sum + Math.min(side.length, CAP), 0),
      capped: rows.some((side) => side.length > CAP),
    };
  },
});

export const list = query({
  args: {},
  handler: async (ctx): Promise<FailureRecord[]> => {
    const identity = await allowedUserOrNull(ctx);
    if (!identity) return [];

    const [local, hosted] = await failedRows(ctx, identity.subject);

    const records: FailureRecord[] = [
      ...local.slice(0, CAP).map((row) => ({
        id: row._id,
        source: "local" as const,
        createdAt: row.timestamp,
        kind: "image" as const,
        prompt: row.formState.prompt,
        error: row.error,
        width: row.formState.width,
        height: row.formState.height,
      })),
      ...hosted.slice(0, CAP).map((row) => ({
        id: row._id,
        source: "api" as const,
        createdAt: row.createdAt,
        kind: row.mediaType,
        prompt: row.prompt,
        errorKind: row.errorKind,
        error: row.error,
        aspectRatio: row.aspectRatio,
      })),
    ];

    return records.sort((a, b) => b.createdAt - a.createdAt);
  },
});
