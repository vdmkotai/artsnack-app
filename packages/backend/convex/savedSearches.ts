import { v } from "convex/values";

import { allowedUserOrNull, requireAllowedUser } from "./authz";
import { mutation, query } from "./_generated/server";

const MAX_TITLE = 80;
const MAX_INTENT = 16_000;

export function validateSavedSearchInput(titleInput: string, intent: string): string {
  const title = titleInput.trim();
  if (!title || title.length > MAX_TITLE) throw new Error("Search name must be 1–80 characters");
  if (!intent || intent.length > MAX_INTENT) throw new Error("Saved search is too large");
  return title;
}

export const list = query({
  args: {},
  handler: async (ctx) => {
    const identity = await allowedUserOrNull(ctx);
    if (!identity) return [];
    return await ctx.db
      .query("savedSearches")
      .withIndex("by_user_updatedAt", (q) => q.eq("userId", identity.subject))
      .order("desc")
      .take(100);
  },
});

export const save = mutation({
  args: { title: v.string(), intent: v.string() },
  handler: async (ctx, args) => {
    const identity = await requireAllowedUser(ctx);
    const title = validateSavedSearchInput(args.title, args.intent);
    const existing = await ctx.db
      .query("savedSearches")
      .withIndex("by_user_title", (q) => q.eq("userId", identity.subject).eq("title", title))
      .first();
    const now = Date.now();
    if (existing) {
      await ctx.db.patch(existing._id, { intent: args.intent, updatedAt: now });
      return existing._id;
    }
    return await ctx.db.insert("savedSearches", {
      userId: identity.subject,
      title,
      intent: args.intent,
      createdAt: now,
      updatedAt: now,
    });
  },
});

export const remove = mutation({
  args: { id: v.id("savedSearches") },
  handler: async (ctx, args) => {
    const identity = await requireAllowedUser(ctx);
    const saved = await ctx.db.get(args.id);
    if (!saved || saved.userId !== identity.subject) throw new Error("Saved search not found");
    await ctx.db.delete(args.id);
  },
});
