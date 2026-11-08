import { ConvexError, getConvexSize, v } from "convex/values";
import { internalMutation, mutation, query } from "./_generated/server";
import { allowedUserOrNull, requireAllowedUser } from "./authz";
import {
  parsedStudioVariantValidator,
  studioAssistantMessageValidator,
  studioUserMessageValidator,
} from "./promptStudioValidators";
import {
  labelStudioVariants,
  findStudioVariant,
  MAX_STUDIO_MESSAGES,
  studioSessionTitle,
} from "../../shared/prompt-studio";

/**
 * Prompt Studio sessions: the conversation behind "Write with AI".
 *
 * The model call lives in promptStudioRun (a Node action); this file holds the
 * reads and writes. A send leases an existing session before reading its
 * history, so concurrent turns never answer from the same old conversation.
 */

const SESSIONS_LISTED = 30;
// Thirty sessions must also fit a list query's 16 MiB read budget.
const MAX_SESSION_BYTES = 384_000;
// Worst-case UTF-8 user text + three capped variants + provider metadata.
const ROUND_RESERVE_BYTES = 100_000;
const SEND_LEASE_MS = 11 * 60_000;
const SESSION_FULL = "This session is full — start a new one with “New”";

export const list = query({
  args: {},
  handler: async (ctx) => {
    const identity = await allowedUserOrNull(ctx);
    if (!identity) return [];
    const rows = await ctx.db
      .query("promptStudioSessions")
      .withIndex("by_user_updatedAt", (q) => q.eq("userId", identity.subject))
      .order("desc")
      .take(SESSIONS_LISTED);
    return rows.map((row) => ({
      _id: row._id,
      title: row.title,
      media: row.media,
      updatedAt: row.updatedAt,
      rounds: row.messages.filter((message) => message.role === "user").length,
    }));
  },
});

/** Null for a session that is gone or not the caller's. */
export const get = query({
  args: { sessionId: v.string() },
  handler: async (ctx, args) => {
    const identity = await allowedUserOrNull(ctx);
    if (!identity) return null;
    const id = ctx.db.normalizeId("promptStudioSessions", args.sessionId);
    const row = id ? await ctx.db.get(id) : null;
    return row && row.userId === identity.subject ? row : null;
  },
});

export const remove = mutation({
  args: { sessionId: v.id("promptStudioSessions") },
  handler: async (ctx, args) => {
    const identity = await requireAllowedUser(ctx);
    const row = await ctx.db.get(args.sessionId);
    if (row && row.userId === identity.subject) await ctx.db.delete(row._id);
  },
});

/** What a send needs before it calls the model: the history and the format. */
export const forSend = internalMutation({
  args: {
    userId: v.string(),
    sessionId: v.optional(v.id("promptStudioSessions")),
    formatId: v.optional(v.id("enhanceRecipes")),
    replyTo: v.optional(v.string()),
    sendId: v.string(),
  },
  handler: async (ctx, args) => {
    const session = args.sessionId ? await ctx.db.get(args.sessionId) : null;
    if (args.sessionId && (!session || session.userId !== args.userId)) {
      return { ok: false as const, error: "This session no longer exists — start a new one" };
    }
    const recipe = args.formatId ? await ctx.db.get(args.formatId) : null;
    if (args.formatId && (!recipe || recipe.userId !== args.userId)) {
      return { ok: false as const, error: "That format no longer exists — pick another" };
    }
    if (args.replyTo && !findStudioVariant(session?.messages ?? [], args.replyTo)) {
      throw new ConvexError(`There is no variant ${args.replyTo}`);
    }
    if (session) {
      if (session.sending && session.sending.until > Date.now()) {
        throw new ConvexError("This session is already writing an answer — wait for it to finish");
      }
      if (
        session.messages.length + 2 > MAX_STUDIO_MESSAGES ||
        getConvexSize(session) + ROUND_RESERVE_BYTES > MAX_SESSION_BYTES
      ) {
        throw new ConvexError(SESSION_FULL);
      }
      await ctx.db.patch(session._id, {
        sending: { id: args.sendId, until: Date.now() + SEND_LEASE_MS },
      });
    }
    return {
      ok: true as const,
      messages: session?.messages ?? [],
      format: recipe ? { title: recipe.title, instructions: recipe.instructions } : undefined,
    };
  },
});

/** A failed or deleted turn must not hold the session until the lease expires. */
export const releaseSend = internalMutation({
  args: { sessionId: v.id("promptStudioSessions"), sendId: v.string() },
  handler: async (ctx, args) => {
    const session = await ctx.db.get(args.sessionId);
    if (session?.sending?.id === args.sendId) {
      await ctx.db.patch(session._id, { sending: undefined });
    }
  },
});

/**
 * Appends one round — the user's message and the model's variants — creating
 * the session on the first one. Returns the session id and the labels given.
 */
export const appendRound = internalMutation({
  args: {
    userId: v.string(),
    sessionId: v.optional(v.id("promptStudioSessions")),
    sendId: v.string(),
    media: v.union(v.literal("image"), v.literal("video")),
    title: v.optional(v.string()),
    user: studioUserMessageValidator,
    variants: v.array(parsedStudioVariantValidator),
    answer: v.object({
      model: studioAssistantMessageValidator.fields.model,
      provider: studioAssistantMessageValidator.fields.provider,
      fellBack: v.boolean(),
      reason: v.optional(v.string()),
      costUsd: v.optional(v.number()),
      durationMs: v.number(),
    }),
  },
  handler: async (ctx, args) => {
    const session = args.sessionId ? await ctx.db.get(args.sessionId) : null;
    if (args.sessionId && (!session || session.userId !== args.userId)) {
      throw new ConvexError("This session no longer exists — start a new one");
    }
    if (session && session.sending?.id !== args.sendId) {
      throw new ConvexError("This turn expired — send it again");
    }
    const history = session?.messages ?? [];
    if (history.length + 2 > MAX_STUDIO_MESSAGES) {
      throw new ConvexError(SESSION_FULL);
    }
    const now = Date.now();
    const variants = labelStudioVariants(history, args.variants, args.user.replyTo);
    const messages = [
      ...history,
      args.user,
      { role: "assistant" as const, variants, ...args.answer, at: now },
    ];
    if (getConvexSize(messages) + 2048 > MAX_SESSION_BYTES) {
      throw new ConvexError(SESSION_FULL);
    }
    if (session) {
      await ctx.db.patch(session._id, { messages, updatedAt: now, sending: undefined });
      return { sessionId: session._id, labels: variants.map((variant) => variant.label) };
    }
    const sessionId = await ctx.db.insert("promptStudioSessions", {
      userId: args.userId,
      title: studioSessionTitle(args.title, args.user.text),
      media: args.media,
      messages,
      createdAt: now,
      updatedAt: now,
    });
    return { sessionId, labels: variants.map((variant) => variant.label) };
  },
});
