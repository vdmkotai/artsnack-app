import { ConvexError, v } from "convex/values";
import {
  internalMutation,
  internalQuery,
  mutation,
  query,
  type QueryCtx,
} from "./_generated/server";
import { allowedUserOrNull, requireAllowedUser } from "./authz";

const provider = v.union(v.literal("vast"), v.literal("runpod"), v.literal("legacy"));

async function selection(ctx: { db: QueryCtx["db"] }) {
  return ctx.db
    .query("selfHostedSelection")
    .withIndex("by_key", (q) => q.eq("key", "default"))
    .unique();
}

export const current = query({
  args: {},
  handler: async (ctx) => {
    if (!(await allowedUserOrNull(ctx))) return null;
    return selection(ctx);
  },
});

export const internalCurrent = internalQuery({
  args: {},
  handler: async (ctx) => selection(ctx),
});

export const set = mutation({
  args: { provider },
  handler: async (ctx, args) => {
    const identity = await requireAllowedUser(ctx);
    if (args.provider === "vast") {
      const row = await ctx.db
        .query("vastBackends")
        .withIndex("by_active", (q) => q.eq("active", true))
        .unique();
      if (row?.state !== "ready") throw new ConvexError("The Vast.ai backend is not ready");
    }
    if (args.provider === "runpod") {
      // Two RunPod rows can be active now (image + video); the switch is the
      // image pod's, and a row without a purpose is an image pod.
      const rows = await ctx.db
        .query("runpodBackends")
        .withIndex("by_active", (q) => q.eq("active", true))
        .collect();
      const row = rows.find((candidate) => (candidate.purpose ?? "image") === "image");
      if (row?.state !== "ready") throw new ConvexError("The RunPod backend is not ready");
    }

    const existing = await selection(ctx);
    const value = {
      key: "default" as const,
      provider: args.provider,
      updatedAt: Date.now(),
      updatedBy: identity.subject,
    };
    if (existing) await ctx.db.replace(existing._id, value);
    else await ctx.db.insert("selfHostedSelection", value);
    return args.provider;
  },
});

/** Launch actions select their newly ready provider without impersonating a user. */
export const setInternal = internalMutation({
  args: { provider },
  handler: async (ctx, args) => {
    const existing = await selection(ctx);
    const value = {
      key: "default" as const,
      provider: args.provider,
      updatedAt: Date.now(),
      updatedBy: "system",
    };
    if (existing) await ctx.db.replace(existing._id, value);
    else await ctx.db.insert("selfHostedSelection", value);
  },
});
