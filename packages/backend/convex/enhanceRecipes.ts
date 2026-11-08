import { v } from "convex/values";
import { internalQuery, mutation, query } from "./_generated/server";
import type { MutationCtx } from "./_generated/server";
import { allowedUserOrNull, requireAllowedUser } from "./authz";
import {
  BUILTIN_MODEL_MIGRATIONS,
  BUILTIN_RECIPES,
  BUILTIN_RECIPES_VERSION,
  DEFAULT_ENHANCE_MODEL_ID,
  ENHANCE_MODELS,
  MAX_RECIPE_INSTRUCTIONS,
  MAX_RECIPE_TITLE,
} from "../../shared/prompt-enhance";

/**
 * Recipes and the one model setting behind the Enhance button.
 *
 * Seeding is a mutation the client calls on first use rather than something
 * `list` does implicitly — a query cannot write — and it is idempotent: the
 * `seededAt` stamp on the settings row is what says "already done", so a user
 * who deletes every built-in does not get them back on the next page load.
 */

const mediaValidator = v.union(v.literal("image"), v.literal("video"), v.literal("any"));

async function settingsRow(ctx: MutationCtx, userId: string) {
  return await ctx.db
    .query("enhanceSettings")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .unique();
}

async function seedIfNeeded(ctx: MutationCtx, userId: string): Promise<void> {
  const settings = await settingsRow(ctx, userId);
  if (settings?.seededAt) {
    // Seeded before newer built-ins existed: add just those, once — a recipe
    // the user deleted from the original set stays deleted.
    const version = settings.builtinsVersion ?? 1;
    if (version >= BUILTIN_RECIPES_VERSION) return;
    const existing = await ctx.db
      .query("enhanceRecipes")
      .withIndex("by_user_createdAt", (q) => q.eq("userId", userId))
      .collect();
    const present = new Set(existing.map((r) => r.builtinKey ?? r.title));
    const now = Date.now();
    for (const row of existing) {
      const move = BUILTIN_MODEL_MIGRATIONS.find(
        (m) => m.title === row.builtinKey && m.from === row.modelId,
      );
      if (move) await ctx.db.patch(row._id, { modelId: move.to, updatedAt: now });
    }
    for (const [index, { since, ...recipe }] of BUILTIN_RECIPES.entries()) {
      if ((since ?? 1) <= version || present.has(recipe.title)) continue;
      await ctx.db.insert("enhanceRecipes", {
        userId,
        ...recipe,
        builtinKey: recipe.title,
        isDefault: false,
        createdAt: now + index,
        updatedAt: now + index,
      });
    }
    await ctx.db.patch(settings._id, { builtinsVersion: BUILTIN_RECIPES_VERSION, updatedAt: now });
    return;
  }
  const now = Date.now();
  // Insert in order with distinct timestamps so the list keeps the built-in order.
  for (const [index, { since: _since, ...recipe }] of BUILTIN_RECIPES.entries()) {
    await ctx.db.insert("enhanceRecipes", {
      userId,
      ...recipe,
      builtinKey: recipe.title,
      createdAt: now + index,
      updatedAt: now + index,
    });
  }
  if (settings) {
    await ctx.db.patch(settings._id, {
      seededAt: now,
      builtinsVersion: BUILTIN_RECIPES_VERSION,
      updatedAt: now,
    });
  } else {
    await ctx.db.insert("enhanceSettings", {
      userId,
      modelId: DEFAULT_ENHANCE_MODEL_ID,
      seededAt: now,
      builtinsVersion: BUILTIN_RECIPES_VERSION,
      updatedAt: now,
    });
  }
}

export const ensureSeeded = mutation({
  args: {},
  handler: async (ctx) => {
    const identity = await requireAllowedUser(ctx);
    await seedIfNeeded(ctx, identity.subject);
  },
});

export const list = query({
  args: {},
  handler: async (ctx) => {
    const identity = await allowedUserOrNull(ctx);
    if (!identity) return [];
    return await ctx.db
      .query("enhanceRecipes")
      .withIndex("by_user_createdAt", (q) => q.eq("userId", identity.subject))
      .order("asc")
      .take(200);
  },
});

export const settings = query({
  args: {},
  handler: async (ctx) => {
    const identity = await allowedUserOrNull(ctx);
    if (!identity) return null;
    const row = await ctx.db
      .query("enhanceSettings")
      .withIndex("by_user", (q) => q.eq("userId", identity.subject))
      .unique();
    return {
      modelId: row?.modelId ?? DEFAULT_ENHANCE_MODEL_ID,
      // "Seeded" means up to date: a newer built-in set makes the client call
      // ensureSeeded once more, which adds only the new recipes.
      seeded: Boolean(row?.seededAt) && (row?.builtinsVersion ?? 1) >= BUILTIN_RECIPES_VERSION,
    };
  },
});

export const setModel = mutation({
  args: { modelId: v.string() },
  handler: async (ctx, args) => {
    const identity = await requireAllowedUser(ctx);
    if (!ENHANCE_MODELS.some((m) => m.id === args.modelId)) {
      throw new Error("Unknown enhance model");
    }
    const now = Date.now();
    const row = await settingsRow(ctx, identity.subject);
    if (row) {
      await ctx.db.patch(row._id, { modelId: args.modelId, updatedAt: now });
    } else {
      await ctx.db.insert("enhanceSettings", {
        userId: identity.subject,
        modelId: args.modelId,
        updatedAt: now,
      });
    }
  },
});

function validate(title: string | undefined, instructions: string | undefined) {
  if (title !== undefined && title.trim().length === 0) throw new Error("A recipe needs a title");
  if (title !== undefined && title.length > MAX_RECIPE_TITLE) {
    throw new Error(`Titles are limited to ${MAX_RECIPE_TITLE} characters`);
  }
  if (instructions !== undefined && instructions.trim().length === 0) {
    throw new Error("A recipe needs instructions");
  }
  if (instructions !== undefined && instructions.length > MAX_RECIPE_INSTRUCTIONS) {
    throw new Error(`Instructions are limited to ${MAX_RECIPE_INSTRUCTIONS} characters`);
  }
}

/**
 * One default per media value. Clearing a default is allowed — the button then
 * falls through to an "any" default or the first listable recipe.
 */
async function clearOtherDefaults(
  ctx: MutationCtx,
  userId: string,
  media: "image" | "video" | "any",
  keepId: string,
) {
  const rows = await ctx.db
    .query("enhanceRecipes")
    .withIndex("by_user_createdAt", (q) => q.eq("userId", userId))
    .collect();
  for (const row of rows) {
    if (row._id !== keepId && row.isDefault && row.media === media) {
      await ctx.db.patch(row._id, { isDefault: false, updatedAt: Date.now() });
    }
  }
}

export const create = mutation({
  args: {
    title: v.string(),
    instructions: v.string(),
    media: mediaValidator,
  },
  handler: async (ctx, args) => {
    const identity = await requireAllowedUser(ctx);
    validate(args.title, args.instructions);
    const now = Date.now();
    return await ctx.db.insert("enhanceRecipes", {
      userId: identity.subject,
      title: args.title.trim(),
      instructions: args.instructions,
      media: args.media,
      isDefault: false,
      createdAt: now,
      updatedAt: now,
    });
  },
});

export const update = mutation({
  args: {
    id: v.id("enhanceRecipes"),
    title: v.optional(v.string()),
    instructions: v.optional(v.string()),
    media: v.optional(mediaValidator),
    isDefault: v.optional(v.boolean()),
    /** "" clears it: the recipe follows the global model again. */
    modelId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const identity = await requireAllowedUser(ctx);
    const row = await ctx.db.get(args.id);
    if (!row || row.userId !== identity.subject) throw new Error("Recipe not found");
    validate(args.title, args.instructions);
    if (args.modelId && !ENHANCE_MODELS.some((m) => m.id === args.modelId)) {
      throw new Error("Unknown enhance model");
    }

    const media = args.media ?? row.media;
    // Becoming a default, or already one and moving to another media type,
    // unseats that media's current default. A default row that merely changes
    // its media keeps its flag but must not take the other media's default
    // with it — so it is demoted instead of promoted.
    const mediaChanged = media !== row.media;
    const isDefault =
      args.isDefault !== undefined ? args.isDefault : mediaChanged ? false : row.isDefault;
    if (args.isDefault === true) {
      await clearOtherDefaults(ctx, identity.subject, media, row._id);
    }

    await ctx.db.patch(args.id, {
      ...(args.title !== undefined ? { title: args.title.trim() } : {}),
      ...(args.instructions !== undefined ? { instructions: args.instructions } : {}),
      ...(mediaChanged ? { media } : {}),
      ...(isDefault !== row.isDefault ? { isDefault } : {}),
      ...(args.modelId !== undefined ? { modelId: args.modelId || undefined } : {}),
      updatedAt: Date.now(),
    });
  },
});

export const remove = mutation({
  args: { id: v.id("enhanceRecipes") },
  handler: async (ctx, args) => {
    const identity = await requireAllowedUser(ctx);
    const row = await ctx.db.get(args.id);
    if (!row || row.userId !== identity.subject) throw new Error("Recipe not found");
    await ctx.db.delete(args.id);
  },
});

/**
 * Puts back any built-in whose seeded row is gone. A renamed or rewritten
 * built-in still carries its `builtinKey`, so it counts as present — restore
 * adds what was deleted, it does not revert edits.
 */
export const restoreBuiltins = mutation({
  args: {},
  handler: async (ctx) => {
    const identity = await requireAllowedUser(ctx);
    const existing = await ctx.db
      .query("enhanceRecipes")
      .withIndex("by_user_createdAt", (q) => q.eq("userId", identity.subject))
      .collect();
    const present = new Set(existing.map((r) => r.builtinKey ?? r.title));
    const now = Date.now();
    let added = 0;
    for (const [index, { since: _since, ...recipe }] of BUILTIN_RECIPES.entries()) {
      if (present.has(recipe.title)) continue;
      await ctx.db.insert("enhanceRecipes", {
        userId: identity.subject,
        ...recipe,
        builtinKey: recipe.title,
        // A restored default must not unseat one the user chose since.
        isDefault:
          recipe.isDefault && !existing.some((r) => r.isDefault && r.media === recipe.media),
        createdAt: now + index,
        updatedAt: now + index,
      });
      added++;
    }
    return { added };
  },
});

// ---------------------------------------------------------------------------
// Internal — what the enhance action reads
// ---------------------------------------------------------------------------

export const getForEnhance = internalQuery({
  // No recipe is a custom instruction: only the model setting is needed.
  args: { userId: v.string(), recipeId: v.optional(v.id("enhanceRecipes")) },
  handler: async (ctx, args) => {
    const recipe = args.recipeId ? await ctx.db.get(args.recipeId) : null;
    if (args.recipeId && (!recipe || recipe.userId !== args.userId)) return null;
    const settings = await ctx.db
      .query("enhanceSettings")
      .withIndex("by_user", (q) => q.eq("userId", args.userId))
      .unique();
    // A recipe with its own model (the H3 one) runs on it whatever the global
    // setting says; a custom instruction has no recipe and uses the global.
    const recipeModel =
      recipe?.modelId && ENHANCE_MODELS.some((m) => m.id === recipe.modelId)
        ? recipe.modelId
        : undefined;
    return { recipe, modelId: recipeModel ?? settings?.modelId ?? DEFAULT_ENHANCE_MODEL_ID };
  },
});
