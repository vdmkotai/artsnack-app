import { v } from "convex/values";
import { internalMutation, internalQuery, mutation, query } from "./_generated/server";
import { allowedUserOrNull, requireAllowedUser } from "./authz";

/**
 * The dynamic provisioning manifest — see the `podModels` table in schema.ts.
 *
 * Rows are added with the internal `upsert` mutation (from the Convex dashboard
 * or `convex run podModels:upsert`); reads come from the UI and from
 * convex/http.ts, which serves the rows to a booting pod as manifest lines.
 */

const dirValidator = v.union(
  v.literal("checkpoints"),
  v.literal("loras"),
  v.literal("diffusion_models"),
);
const profileValidator = v.union(v.literal("image"), v.literal("video"));

/** Every row, newest first — the UI's management list. */
export const list = query({
  args: {},
  handler: async (ctx) => {
    if (!(await allowedUserOrNull(ctx))) return [];
    const rows = await ctx.db.query("podModels").collect();
    return rows.sort((a, b) => b.addedAt - a.addedAt);
  },
});

/** Enabled rows of one pod's manifest, for the /pod-manifest HTTP endpoint.
 *  A row with no profile predates the video pod and is an image row. */
export const manifestRows = internalQuery({
  args: { profile: v.optional(profileValidator) },
  handler: async (ctx, args) => {
    const profile = args.profile ?? "image";
    const rows = await ctx.db.query("podModels").collect();
    return rows.filter((row) => row.enabled && (row.profile ?? "image") === profile);
  },
});

/**
 * Insert or refresh one manifest entry. Keyed on (profile, dir, filename) because
 * the filename is what ComfyUI's loaders key on: two rows with the same name would
 * race each other at provision time, last download wins, silently.
 */
export const upsert = internalMutation({
  args: {
    profile: profileValidator,
    dir: dirValidator,
    url: v.string(),
    filename: v.string(),
    addedBy: v.string(),
    modelName: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    // Per pod profile: an SDXL and an H3 LoRA may share a filename, and each
    // pod only ever downloads its own profile's rows (absent = image).
    const existing = (
      await ctx.db
        .query("podModels")
        .withIndex("by_dir_filename", (q) => q.eq("dir", args.dir).eq("filename", args.filename))
        .collect()
    ).find((row) => (row.profile ?? "image") === args.profile);
    if (existing) {
      await ctx.db.patch(existing._id, {
        profile: args.profile,
        url: args.url,
        enabled: true,
        modelName: args.modelName ?? existing.modelName,
      });
      return existing._id;
    }
    return ctx.db.insert("podModels", { ...args, enabled: true, addedAt: Date.now() });
  },
});

/** Flip a row in or out of the manifest without losing the record of it. */
export const setEnabled = mutation({
  args: { id: v.id("podModels"), enabled: v.boolean() },
  handler: async (ctx, args) => {
    await requireAllowedUser(ctx);
    await ctx.db.patch(args.id, { enabled: args.enabled });
  },
});

export const remove = mutation({
  args: { id: v.id("podModels") },
  handler: async (ctx, args) => {
    await requireAllowedUser(ctx);
    await ctx.db.delete(args.id);
  },
});

/** Remember which video family a file is (see schema.videoModelFamilies). */
export const setVideoFamily = internalMutation({
  args: { filename: v.string(), family: v.union(v.literal("h3"), v.literal("ltx")) },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("videoModelFamilies")
      .withIndex("by_filename", (q) => q.eq("filename", args.filename))
      .first();
    if (existing) {
      if (existing.family !== args.family) {
        await ctx.db.patch(existing._id, { family: args.family, updatedAt: Date.now() });
      }
      return;
    }
    await ctx.db.insert("videoModelFamilies", { ...args, updatedAt: Date.now() });
  },
});

export const videoFamilies = internalQuery({
  args: {},
  handler: async (ctx) => {
    const rows = await ctx.db.query("videoModelFamilies").take(2000);
    return Object.fromEntries(rows.map((row) => [row.filename, row.family]));
  },
});
