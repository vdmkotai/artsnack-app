import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { Id } from "./_generated/dataModel";
import { allowedUserOrNull, requireAllowedUser } from "./authz";

/**
 * Folders for the Favorites page.
 *
 * Flat by design: the feature is "a handful of curated buckets", and every
 * question the UI asks — which folders exist, how full is each, file these
 * rows there — stays a point operation on a flat list. Membership lives on the
 * favourite row (`folderId`), not here, so a favourite is in at most one
 * folder and un-favouriting needs no cleanup pass.
 */

const MAX_NAME = 60;

function normalizeName(raw: string): string {
  const name = raw.trim().replace(/\s+/g, " ");
  if (!name) throw new Error("A folder needs a name");
  return name.length > MAX_NAME ? name.slice(0, MAX_NAME) : name;
}

/**
 * Every folder, oldest first, each with how many favourites it holds — plus
 * the unfiled and total counts the "All" and "Unfiled" chips show.
 *
 * Counts come from one bounded scan of the favourites rather than a per-folder
 * query: folders are few but a per-folder count is a read of that folder's
 * whole membership anyway, so one pass over the same rows answers everything.
 */
export const list = query({
  args: {},
  handler: async (
    ctx,
  ): Promise<{
    folders: Array<{
      _id: Id<"favoriteFolders">;
      name: string;
      createdAt: number;
      count: number;
    }>;
    unfiled: number;
    total: number;
  }> => {
    const identity = await allowedUserOrNull(ctx);
    if (!identity) return { folders: [], unfiled: 0, total: 0 };

    const folders = await ctx.db
      .query("favoriteFolders")
      .withIndex("by_user_createdAt", (q) => q.eq("userId", identity.subject))
      .collect();

    // Same bound as favorites.myKeys, for the same reason: this backs a chip
    // row on every Favorites load and must not outgrow the transaction budget.
    const favorites = await ctx.db
      .query("favorites")
      .withIndex("by_user_createdAt", (q) => q.eq("userId", identity.subject))
      .order("desc")
      .take(5000);

    const counts = new Map<string, number>();
    let unfiled = 0;
    for (const favorite of favorites) {
      if (favorite.folderId) {
        counts.set(favorite.folderId, (counts.get(favorite.folderId) ?? 0) + 1);
      } else {
        unfiled += 1;
      }
    }

    return {
      folders: folders.map((folder) => ({
        _id: folder._id,
        name: folder.name,
        createdAt: folder.createdAt,
        count: counts.get(folder._id) ?? 0,
      })),
      unfiled,
      total: favorites.length,
    };
  },
});

/**
 * Create a folder, or return the existing one with the same name — creating is
 * idempotent so "New folder → refs" typed twice cannot mint twins.
 */
export const create = mutation({
  args: { name: v.string() },
  handler: async (ctx, args): Promise<{ folderId: Id<"favoriteFolders"> }> => {
    const identity = await requireAllowedUser(ctx);
    const name = normalizeName(args.name);
    const existing = await ctx.db
      .query("favoriteFolders")
      .withIndex("by_user_name", (q) => q.eq("userId", identity.subject).eq("name", name))
      .first();
    if (existing) return { folderId: existing._id };
    const now = Date.now();
    const folderId = await ctx.db.insert("favoriteFolders", {
      userId: identity.subject,
      name,
      createdAt: now,
      updatedAt: now,
    });
    return { folderId };
  },
});

export const rename = mutation({
  args: { folderId: v.id("favoriteFolders"), name: v.string() },
  handler: async (ctx, args): Promise<void> => {
    const identity = await requireAllowedUser(ctx);
    const folder = await ctx.db.get(args.folderId);
    if (!folder || folder.userId !== identity.subject) throw new Error("Folder not found");
    const name = normalizeName(args.name);
    const clash = await ctx.db
      .query("favoriteFolders")
      .withIndex("by_user_name", (q) => q.eq("userId", identity.subject).eq("name", name))
      .first();
    if (clash && clash._id !== args.folderId) {
      throw new Error("A folder with that name already exists");
    }
    await ctx.db.patch(args.folderId, { name, updatedAt: Date.now() });
  },
});

/**
 * Delete a folder. Its favourites go back to the unfiled pool — deleting a
 * bucket must never delete what was in it.
 */
export const remove = mutation({
  args: { folderId: v.id("favoriteFolders") },
  handler: async (ctx, args): Promise<void> => {
    const identity = await requireAllowedUser(ctx);
    const folder = await ctx.db.get(args.folderId);
    if (!folder || folder.userId !== identity.subject) throw new Error("Folder not found");
    const members = await ctx.db
      .query("favorites")
      .withIndex("by_user_folder", (q) =>
        q.eq("userId", identity.subject).eq("folderId", args.folderId),
      )
      .collect();
    for (const member of members) {
      await ctx.db.patch(member._id, { folderId: undefined });
    }
    await ctx.db.delete(args.folderId);
  },
});
