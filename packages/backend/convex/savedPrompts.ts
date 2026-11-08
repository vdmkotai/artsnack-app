import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { allowedUserOrNull, requireAllowedUser } from "./authz";

/**
 * Reusable prompts.
 *
 * Prompts are the part of a generation worth keeping — models and settings
 * change, wording is the thing that took effort. These are stored on their own
 * rather than derived from history, so a prompt survives deleting the images it
 * produced and can be edited without touching them.
 */

const MAX_TITLE = 120;
const MAX_TEXT = 8000;

/**
 * How many prompts a page shows.
 *
 * A ceiling, not a cap on saving: an unbounded read of a table with 8 KB rows
 * eventually exceeds Convex's per-transaction byte budget, and the failure mode
 * is a list that never loads with no way back under the limit from inside the
 * app. Far above any realistic library.
 */
const LIST_LIMIT = 500;

function titleFrom(text: string): string {
  const firstLine = text.trim().split("\n")[0].trim();
  return firstLine.length > 60 ? `${firstLine.slice(0, 60).trimEnd()}…` : firstLine || "Untitled";
}

/** FNV-1a. Not a security primitive — just a stable bucket for exact-match lookup. */
function hashText(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

export const list = query({
  args: {},
  handler: async (ctx) => {
    const identity = await allowedUserOrNull(ctx);
    if (!identity) return [];
    return await ctx.db
      .query("savedPrompts")
      .withIndex("by_user_createdAt", (q) => q.eq("userId", identity.subject))
      .order("desc")
      .take(LIST_LIMIT);
  },
});

export const save = mutation({
  args: {
    text: v.string(),
    /** Derived from the first line when omitted. */
    title: v.optional(v.string()),
    /**
     * Set by the "New prompt" button, which means a blank card every time —
     * deduping there would silently do nothing on the second press.
     */
    allowDuplicate: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const identity = await requireAllowedUser(ctx);

    const text = args.text.trim();
    if (!text) throw new Error("Cannot save an empty prompt");
    if (text.length > MAX_TEXT) throw new Error(`Prompts are limited to ${MAX_TEXT} characters`);

    const textHash = hashText(text);

    // Saving the same wording twice from the prompt field is almost always a
    // mis-click, and a list of duplicates is worse than no list.
    if (!args.allowDuplicate) {
      const sameHash = await ctx.db
        .query("savedPrompts")
        .withIndex("by_user_hash", (q) => q.eq("userId", identity.subject).eq("textHash", textHash))
        .collect();
      const duplicate = sameHash.find((row) => row.text.trim() === text);
      if (duplicate) {
        await ctx.db.patch(duplicate._id, { updatedAt: Date.now() });
        return { id: duplicate._id, duplicate: true as const };
      }
    }

    const now = Date.now();
    const id = await ctx.db.insert("savedPrompts", {
      userId: identity.subject,
      title: (args.title ?? titleFrom(text)).slice(0, MAX_TITLE),
      text,
      textHash,
      createdAt: now,
      updatedAt: now,
    });
    return { id, duplicate: false as const };
  },
});

export const update = mutation({
  args: {
    id: v.id("savedPrompts"),
    title: v.optional(v.string()),
    text: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const identity = await requireAllowedUser(ctx);

    const row = await ctx.db.get(args.id);
    if (!row || row.userId !== identity.subject) throw new Error("Prompt not found");

    const text = args.text?.trim();
    if (text !== undefined && !text) throw new Error("Cannot save an empty prompt");
    if (text !== undefined && text.length > MAX_TEXT) {
      throw new Error(`Prompts are limited to ${MAX_TEXT} characters`);
    }

    /**
     * A caller that edits the text and says nothing about the title gets the
     * title re-derived — but only when the stored one is still the derived one.
     *
     * The web sends both fields because it edits both in one card. The phone
     * edits the wording alone, and without this the list went on showing the old
     * first line as the name of a prompt that no longer began with it. A title
     * somebody typed on purpose is left exactly as it is: it is not a stale copy
     * of the text, it is a name.
     */
    const retitle =
      args.title === undefined && text !== undefined && row.title === titleFrom(row.text)
        ? { title: titleFrom(text).slice(0, MAX_TITLE) }
        : {};

    await ctx.db.patch(args.id, {
      ...(args.title !== undefined ? { title: args.title.slice(0, MAX_TITLE) || "Untitled" } : {}),
      ...retitle,
      ...(text !== undefined ? { text, textHash: hashText(text) } : {}),
      updatedAt: Date.now(),
    });
  },
});

export const remove = mutation({
  args: { id: v.id("savedPrompts") },
  handler: async (ctx, args) => {
    const identity = await requireAllowedUser(ctx);

    const row = await ctx.db.get(args.id);
    if (!row || row.userId !== identity.subject) throw new Error("Prompt not found");
    await ctx.db.delete(args.id);
  },
});
