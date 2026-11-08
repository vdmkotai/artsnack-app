import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { allowedUserOrNull, requireAllowedUser } from "./authz";
import { resolveFeatureFlags } from "../../shared/feature-flags";

/**
 * The caller's flags, defaults filled in. Stored in Convex rather than
 * localStorage so the browser and the desktop shell — separate storage, same
 * account — agree on which tabs are showing.
 */
export const mine = query({
  args: {},
  handler: async (ctx) => {
    const identity = await allowedUserOrNull(ctx);
    if (!identity) return null;
    const row = await ctx.db
      .query("featureFlags")
      .withIndex("by_user", (q) => q.eq("userId", identity.subject))
      .unique();
    return resolveFeatureFlags(row);
  },
});

export const set = mutation({
  args: {
    key: v.union(v.literal("higgsfield"), v.literal("fal")),
    enabled: v.boolean(),
  },
  handler: async (ctx, args) => {
    const identity = await requireAllowedUser(ctx);
    const row = await ctx.db
      .query("featureFlags")
      .withIndex("by_user", (q) => q.eq("userId", identity.subject))
      .unique();
    const now = Date.now();
    if (row) {
      await ctx.db.patch(row._id, { [args.key]: args.enabled, updatedAt: now });
    } else {
      await ctx.db.insert("featureFlags", {
        userId: identity.subject,
        [args.key]: args.enabled,
        updatedAt: now,
      });
    }
  },
});
