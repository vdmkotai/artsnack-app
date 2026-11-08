/**
 * Starred Atlas models.
 *
 * Deliberately thin: the catalogue lives in the client bundle, so these
 * functions only ever move slugs. Resolving a slug to a label, a price or a
 * media type is the reader's job — doing it here would mean the server needs
 * the generated catalogue too, and a starred model that left the catalogue
 * would start throwing inside a query instead of being quietly skipped.
 */

import { v } from "convex/values";

import { mutation, query } from "./_generated/server";
import { allowedUserOrNull, requireAllowedUser } from "./authz";

/**
 * Guards against a single user starring the whole catalogue.
 *
 * The chip row is a shortcut; past a couple of dozen it stops being one, and
 * an unbounded list is an unbounded query on every composer render.
 */
const MAX_FAVORITES = 40;

export const list = query({
  args: {},
  handler: async (ctx) => {
    /*
     * Null rather than a throw when there is no identity.
     *
     * A query that throws is rethrown by `useQuery` during render, and the
     * composer's error boundary then replaces the whole page — which is what
     * "Something went wrong … Q(atlasFavorites:list)" was on a cold load, before
     * Clerk had hydrated. Every other list query in this codebase returns empty
     * instead, for exactly this reason; this one was written with the mutation's
     * guard by mistake.
     */
    const identity = await allowedUserOrNull(ctx);
    if (!identity) return [];
    const rows = await ctx.db
      .query("atlasFavorites")
      .withIndex("by_user_createdAt", (q) => q.eq("userId", identity.subject))
      .order("asc")
      .take(MAX_FAVORITES);
    // Oldest first, so the chips keep a stable order and a newly starred model
    // appends rather than reshuffling the row under the cursor.
    return rows.map((row) => row.modelId);
  },
});

export const toggle = mutation({
  args: { modelId: v.string() },
  handler: async (ctx, args) => {
    const identity = await requireAllowedUser(ctx);

    const existing = await ctx.db
      .query("atlasFavorites")
      .withIndex("by_user_model", (q) =>
        q.eq("userId", identity.subject).eq("modelId", args.modelId),
      )
      .unique();

    if (existing) {
      await ctx.db.delete(existing._id);
      return false;
    }

    const count = await ctx.db
      .query("atlasFavorites")
      .withIndex("by_user_createdAt", (q) => q.eq("userId", identity.subject))
      .take(MAX_FAVORITES);
    if (count.length >= MAX_FAVORITES) {
      throw new Error(
        `You have starred ${MAX_FAVORITES} models — unstar one before adding another.`,
      );
    }

    await ctx.db.insert("atlasFavorites", {
      userId: identity.subject,
      modelId: args.modelId,
      createdAt: Date.now(),
    });
    return true;
  },
});
