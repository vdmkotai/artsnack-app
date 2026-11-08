import { paginationOptsValidator } from "convex/server";
import { v } from "convex/values";
import { mutation, query } from "./_generated/server";

/**
 * The retired Wan 2.2 pipeline's public surface, as no-ops.
 *
 * Its clips moved to grokGenerations (comfyVideo.migrateLegacyVideos) and the
 * table is gone, but iOS builds already on phones still subscribe to these by
 * name; a missing function would error the whole Library feed rather than just
 * its (now empty) video half. Ids are plain strings because the `videos`
 * table no longer exists to type them. Delete once no shipped build calls them.
 */

const EMPTY_PAGE = { page: [] as never[], isDone: true, continueCursor: "" };

export const listPaginated = query({
  args: { paginationOpts: paginationOptsValidator },
  handler: async () => EMPTY_PAGE,
});

export const listRecent = query({
  args: { limit: v.optional(v.number()) },
  handler: async () => [] as never[],
});

/** The shape installed iOS builds read off a clip; always null now. */
type LegacyVideoRow = {
  error?: string;
  settings: {
    prompt: string;
    negativePrompt: string;
    highModel: string;
    lowModel: string;
    width: number;
    height: number;
    durationSeconds: number;
    loras: { enabled: boolean; id: string }[];
    advanced: { steps: number; cfg: number; sampler: string; scheduler: string; seed: number };
  };
};

export const getById = query({
  args: { id: v.string() },
  handler: async (): Promise<LegacyVideoRow | null> => null,
});

export const deleteVideo = mutation({
  args: { id: v.string() },
  handler: async () => null,
});

export const removeAllFailed = mutation({
  args: {},
  handler: async () => 0,
});
