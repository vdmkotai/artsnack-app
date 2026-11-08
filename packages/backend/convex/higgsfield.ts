import { v } from "convex/values";
import { query, internalQuery, internalMutation } from "./_generated/server";
import { allowedUserOrNull } from "./authz";

/**
 * Stored state for the Higgsfield integration: the rotating OAuth credentials,
 * cached credit quotes, and the last known plan balance.
 *
 * Credentials live in a table rather than an environment variable because the
 * CLI rotates the token and an action can read the environment but not write to
 * it. The env var is only ever the seed.
 */

// ---------------------------------------------------------------------------
// Credentials
// ---------------------------------------------------------------------------

export const getCredentialsInternal = internalQuery({
  args: {},
  handler: async (ctx) => {
    return await ctx.db.query("higgsfieldAuth").first();
  },
});

export const storeCredentials = internalMutation({
  args: { credentials: v.string() },
  handler: async (ctx, args) => {
    const existing = await ctx.db.query("higgsfieldAuth").first();
    if (existing) {
      await ctx.db.patch(existing._id, {
        credentials: args.credentials,
        updatedAt: Date.now(),
      });
      return;
    }
    await ctx.db.insert("higgsfieldAuth", {
      credentials: args.credentials,
      updatedAt: Date.now(),
    });
  },
});

/** Whether Higgsfield is usable, without exposing the token itself. */
export const isConnected = query({
  args: {},
  handler: async (ctx) => {
    const identity = await allowedUserOrNull(ctx);
    if (!identity) return { connected: false as const };
    const row = await ctx.db.query("higgsfieldAuth").first();
    return { connected: row !== null, updatedAt: row?.updatedAt };
  },
});

// ---------------------------------------------------------------------------
// Credit quotes
// ---------------------------------------------------------------------------

export const getCost = query({
  args: { signature: v.string() },
  handler: async (ctx, args) => {
    const identity = await allowedUserOrNull(ctx);
    if (!identity) return null;
    const row = await ctx.db
      .query("higgsfieldCosts")
      .withIndex("by_signature", (q) => q.eq("signature", args.signature))
      .unique();
    return row ? { credits: row.credits, updatedAt: row.updatedAt } : null;
  },
});

/** Every cached quote at once — the table holds one row per distinct settings
 *  combination, so the form can price all of its options from a single read. */
export const listCosts = query({
  args: {},
  handler: async (ctx) => {
    const identity = await allowedUserOrNull(ctx);
    if (!identity) return [];
    const rows = await ctx.db.query("higgsfieldCosts").collect();
    return rows.map((row) => ({ signature: row.signature, credits: row.credits }));
  },
});

export const getCostInternal = internalQuery({
  args: { signature: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("higgsfieldCosts")
      .withIndex("by_signature", (q) => q.eq("signature", args.signature))
      .unique();
  },
});

export const storeCost = internalMutation({
  args: { signature: v.string(), credits: v.number() },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("higgsfieldCosts")
      .withIndex("by_signature", (q) => q.eq("signature", args.signature))
      .unique();
    if (existing) {
      await ctx.db.patch(existing._id, { credits: args.credits, updatedAt: Date.now() });
      return;
    }
    await ctx.db.insert("higgsfieldCosts", {
      signature: args.signature,
      credits: args.credits,
      updatedAt: Date.now(),
    });
  },
});

// ---------------------------------------------------------------------------
// Account balance
// ---------------------------------------------------------------------------

export const getAccount = query({
  args: {},
  handler: async (ctx) => {
    const identity = await allowedUserOrNull(ctx);
    if (!identity) return null;
    return await ctx.db.query("higgsfieldAccount").first();
  },
});

export const getAccountInternal = internalQuery({
  args: {},
  handler: async (ctx) => {
    return await ctx.db.query("higgsfieldAccount").first();
  },
});

export const storeAccount = internalMutation({
  args: {
    credits: v.number(),
    planType: v.optional(v.string()),
    email: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db.query("higgsfieldAccount").first();
    const next = {
      credits: args.credits,
      planType: args.planType,
      email: args.email,
      updatedAt: Date.now(),
    };
    if (existing) {
      await ctx.db.patch(existing._id, next);
      return;
    }
    await ctx.db.insert("higgsfieldAccount", next);
  },
});
