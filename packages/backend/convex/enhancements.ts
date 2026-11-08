import { paginationOptsValidator } from "convex/server";
import { v } from "convex/values";
import { query, mutation } from "./_generated/server";
import { allowedUserOrNull, requireAllowedUser } from "./authz";

/**
 * The same rows as `list`, paginated.
 *
 * `list` takes the newest 100 and stops, which is fine for a page that shows a
 * recent strip and wrong for a grid you scroll: the phone's Library reaches its
 * enhancements through a cursor like every other source it merges, and a
 * hard-capped query would have looked like "no older results" rather than
 * "no more asked for".
 */
export const listPaginated = query({
  args: { paginationOpts: paginationOptsValidator },
  handler: async (ctx, args) => {
    const identity = await allowedUserOrNull(ctx);
    if (!identity) return { page: [], isDone: true, continueCursor: "" };

    return await ctx.db
      .query("enhancements")
      .withIndex("by_user_timestamp", (q) => q.eq("userId", identity.subject))
      .order("desc")
      .paginate(args.paginationOpts);
  },
});

export const list = query({
  args: {},
  handler: async (ctx) => {
    const identity = await allowedUserOrNull(ctx);
    if (!identity) {
      return [];
    }

    const enhancements = await ctx.db
      .query("enhancements")
      .withIndex("by_user_timestamp", (q) => q.eq("userId", identity.subject))
      .order("desc")
      .take(100);

    return enhancements;
  },
});

export const getById = query({
  // A string, not v.id: the id now arrives from `/enhance?reproduce=…`, which
  // the user can edit, and a malformed one must read as "not found" rather than
  // fail argument validation — `useQuery` rethrows that during render, and
  // Suspense does not catch errors, so it replaces the whole page with
  // app/error.tsx. Same reasoning as grokGenerations.get.
  args: { id: v.string() },
  handler: async (ctx, args) => {
    const identity = await allowedUserOrNull(ctx);
    if (!identity) {
      return null;
    }

    const id = ctx.db.normalizeId("enhancements", args.id);
    if (!id) return null;

    const enhancement = await ctx.db.get(id);
    if (!enhancement || enhancement.userId !== identity.subject) {
      return null;
    }

    return enhancement;
  },
});

export const save = mutation({
  args: {
    timestamp: v.number(),
    mode: v.string(),
    sourceImageUrl: v.string(),
    sourceB2Key: v.optional(v.string()),
    sourceGenerationId: v.optional(v.id("generations")),
    resultB2Key: v.string(),
    params: v.any(),
    backend: v.optional(v.string()),
    warning: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const identity = await requireAllowedUser(ctx);

    const enhancementId = await ctx.db.insert("enhancements", {
      userId: identity.subject,
      ...args,
    });

    return enhancementId;
  },
});

export const remove = mutation({
  args: { id: v.id("enhancements") },
  handler: async (ctx, args) => {
    const identity = await requireAllowedUser(ctx);

    const enhancement = await ctx.db.get(args.id);
    if (!enhancement || enhancement.userId !== identity.subject) {
      throw new Error("Enhancement not found or not owned by user");
    }

    // The same cleanup generations.remove does, and for the same reason: a
    // favorite outliving what it points at is the one thing that keeps a
    // deleted image on screen. It became reachable the moment enhancements
    // could be favourited at all.
    const favorite = await ctx.db
      .query("favorites")
      .withIndex("by_user_key", (q) =>
        q.eq("userId", identity.subject).eq("b2Key", enhancement.resultB2Key),
      )
      .first();
    if (favorite) await ctx.db.delete(favorite._id);

    await ctx.db.delete(args.id);
  },
});
