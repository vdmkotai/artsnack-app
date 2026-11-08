import { v } from "convex/values";
import { query, mutation, internalMutation, internalQuery } from "./_generated/server";
import { allowedUserOrNull, requireAllowedUser } from "./authz";

/**
 * Public connection status for the signed-in user. NEVER returns tokens —
 * access/refresh tokens are only read by internal actions.
 */
export const getConnection = query({
  args: {},
  handler: async (ctx) => {
    const identity = await allowedUserOrNull(ctx);
    if (!identity) return { connected: false as const };

    const token = await ctx.db
      .query("grokTokens")
      .withIndex("by_user", (q) => q.eq("userId", identity.subject))
      .unique();

    if (!token) return { connected: false as const };
    return {
      connected: true as const,
      email: token.email,
      expiresAt: token.expiresAt,
    };
  },
});

/** Disconnect the Grok account: drop tokens and any pending login session. */
export const disconnect = mutation({
  args: {},
  handler: async (ctx) => {
    const identity = await requireAllowedUser(ctx);

    const [token, sessions] = await Promise.all([
      ctx.db
        .query("grokTokens")
        .withIndex("by_user", (q) => q.eq("userId", identity.subject))
        .unique(),
      ctx.db
        .query("grokAuthSessions")
        .withIndex("by_user", (q) => q.eq("userId", identity.subject))
        .collect(),
    ]);

    if (token) await ctx.db.delete(token._id);
    for (const session of sessions) await ctx.db.delete(session._id);
  },
});

// ---------------------------------------------------------------------------
// Internal helpers used by the device-flow / generation actions.
// ---------------------------------------------------------------------------

export const createAuthSession = internalMutation({
  args: {
    deviceCode: v.string(),
    userCode: v.string(),
    expiresAt: v.number(),
  },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Not authenticated");

    // Replace any stale pending session for this user.
    const existing = await ctx.db
      .query("grokAuthSessions")
      .withIndex("by_user", (q) => q.eq("userId", identity.subject))
      .collect();
    for (const session of existing) await ctx.db.delete(session._id);

    return await ctx.db.insert("grokAuthSessions", {
      userId: identity.subject,
      deviceCode: args.deviceCode,
      userCode: args.userCode,
      expiresAt: args.expiresAt,
      createdAt: Date.now(),
    });
  },
});

export const getAuthSession = internalQuery({
  args: {},
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return null;
    return await ctx.db
      .query("grokAuthSessions")
      .withIndex("by_user", (q) => q.eq("userId", identity.subject))
      .unique();
  },
});

export const deleteAuthSession = internalMutation({
  args: {},
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return;
    const sessions = await ctx.db
      .query("grokAuthSessions")
      .withIndex("by_user", (q) => q.eq("userId", identity.subject))
      .collect();
    for (const session of sessions) await ctx.db.delete(session._id);
  },
});

export const storeTokens = internalMutation({
  args: {
    userId: v.string(),
    accessToken: v.string(),
    refreshToken: v.string(),
    expiresAt: v.number(),
    email: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("grokTokens")
      .withIndex("by_user", (q) => q.eq("userId", args.userId))
      .unique();

    if (existing) {
      await ctx.db.patch(existing._id, {
        accessToken: args.accessToken,
        refreshToken: args.refreshToken,
        expiresAt: args.expiresAt,
        email: args.email ?? existing.email,
        updatedAt: Date.now(),
      });
    } else {
      await ctx.db.insert("grokTokens", {
        userId: args.userId,
        accessToken: args.accessToken,
        refreshToken: args.refreshToken,
        expiresAt: args.expiresAt,
        email: args.email,
        updatedAt: Date.now(),
      });
    }
  },
});

/** Drop the token row (e.g. refresh token rejected → user must reconnect). */
export const clearTokens = internalMutation({
  args: { userId: v.string() },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("grokTokens")
      .withIndex("by_user", (q) => q.eq("userId", args.userId))
      .unique();
    if (existing) await ctx.db.delete(existing._id);
  },
});

/** Full token row — internal actions only. Takes userId explicitly because
 * scheduled actions run without an auth context. */
export const getTokenRow = internalQuery({
  args: { userId: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("grokTokens")
      .withIndex("by_user", (q) => q.eq("userId", args.userId))
      .unique();
  },
});
