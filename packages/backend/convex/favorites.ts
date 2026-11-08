import { v } from "convex/values";
import { paginationOptsValidator } from "convex/server";
import { mutation, query, QueryCtx } from "./_generated/server";
import { Doc, Id } from "./_generated/dataModel";
import { allowedUserOrNull, requireAllowedUser } from "./authz";
import { matchesFavoriteFilters } from "../../shared/favorite-filters";

/**
 * The key must be one this generation actually produced.
 *
 * Ownership of the generation is checked separately; without this a client
 * could file someone else's object under its own favorite, which would then
 * survive the real owner deleting it.
 */
const VIDEO_EXTENSIONS = [".mp4", ".mov", ".webm"];

function isVideoKey(b2Key: string): boolean {
  const lower = b2Key.toLowerCase();
  return VIDEO_EXTENSIONS.some((extension) => lower.endsWith(extension));
}

function assertOwnsKey(generation: { b2Key?: string; b2Keys?: string[] }, b2Key: string): void {
  const keys = generation.b2Keys?.length
    ? generation.b2Keys
    : generation.b2Key
      ? [generation.b2Key]
      : [];
  if (!keys.includes(b2Key)) {
    throw new Error("That file does not belong to this generation");
  }
}

/**
 * Where a favourite came from, as the filter chips name it.
 *
 * "self-hosted" and the four hosted providers match the global search
 * vocabulary (packages/shared/search.ts); "enhance" exists only here because
 * only favourites can hold those rows.
 */
export type FavoriteProvider = "self-hosted" | "grok" | "fal" | "higgsfield" | "atlas" | "enhance";

/**
 * `"none"` addresses the unfiled set — rows whose folderId is absent — which a
 * v.id validator alone cannot express. A plain string (not v.id) because the
 * value rides in the page URL: a stale or hand-edited `?folder=` must fall
 * back to the All view, not throw an ArgumentValidationError into the page.
 */
const folderFilterValidator = v.optional(v.string());

type FolderFilter = Id<"favoriteFolders"> | "none" | undefined;

function resolveFolderFilter(ctx: QueryCtx, raw: string | undefined): FolderFilter {
  if (raw === undefined) return undefined;
  if (raw === "none") return "none";
  return ctx.db.normalizeId("favoriteFolders", raw) ?? undefined;
}

function favoritesInScope(ctx: QueryCtx, userId: string, folderId: FolderFilter) {
  if (folderId === undefined) {
    return ctx.db
      .query("favorites")
      .withIndex("by_user_createdAt", (q) => q.eq("userId", userId))
      .order("desc");
  }
  return ctx.db
    .query("favorites")
    .withIndex("by_user_folder", (q) =>
      q.eq("userId", userId).eq("folderId", folderId === "none" ? undefined : folderId),
    )
    .order("desc");
}

type EnrichedFavorite = Doc<"favorites"> & {
  mediaType: "image" | "video";
  aspectRatio: string | undefined;
  prompt: string | undefined;
  provider: FavoriteProvider;
  checkpoint: string | undefined;
};

/**
 * One favourite plus everything the page cannot infer from a B2 key: media
 * type, aspect, prompt, provider and (for self-hosted rows) the checkpoint.
 *
 * Rows written since the filters landed carry mediaType/provider/checkpoint
 * denormalised; older rows derive the same answers through the join this
 * query has always performed.
 */
async function enrichFavorite(
  ctx: QueryCtx,
  favorite: Doc<"favorites">,
): Promise<EnrichedFavorite> {
  if (favorite.enhancementId) {
    const enhancement = await ctx.db.get(favorite.enhancementId);
    return {
      ...favorite,
      // Always a still: every enhance mode returns one image.
      mediaType: "image" as const,
      aspectRatio: undefined,
      /*
       * Only img2img. The other three modes have no prompt of their own,
       * but the Enhance page spreads its whole form state into `params`
       * for every mode — so an upscale carries whatever happened to be
       * typed at the time. Reported as this image's prompt it becomes a
       * "copy prompt" button on the Favourites tile and a PROMPT block in
       * the iOS viewer, both quoting text that did not produce it.
       */
      prompt:
        enhancement?.mode === "img2img" &&
        typeof enhancement.params?.prompt === "string" &&
        enhancement.params.prompt.trim()
          ? (enhancement.params.prompt as string)
          : undefined,
      provider: "enhance",
      checkpoint: undefined,
    };
  }
  if (!favorite.apiGenerationId) {
    /**
     * The denormalised copy is preferred but not required.
     *
     * `toggle` copies the generation's `formState` onto the favorite, but
     * `formState` is optional on the table and rows written before that copy
     * existed have none — so Reproduce told the user "no settings were saved
     * with this favorite" while the settings sat on the generation the row
     * still points at. Reading through costs one document, and only for the
     * rows that need it.
     *
     * A missing generation stays missing: the row survives the generation
     * being deleted, and there is genuinely nothing to restore then.
     */
    const formState =
      favorite.formState ??
      (favorite.generationId ? (await ctx.db.get(favorite.generationId))?.formState : undefined);
    return {
      ...favorite,
      formState,
      mediaType: "image" as const,
      aspectRatio: undefined,
      prompt: formState?.prompt,
      provider: "self-hosted",
      checkpoint: favorite.checkpoint ?? formState?.checkpoint,
    };
  }
  const generation = await ctx.db.get(favorite.apiGenerationId);
  return {
    ...favorite,
    // The key is the fallback, not the row: a favorite saved before the
    // generation was deleted must still know it points at a clip, or the
    // page hands an mp4 to an <img> and shows a dead tile.
    mediaType:
      (favorite.mediaType ??
        generation?.mediaType ??
        (isVideoKey(favorite.b2Key) ? "video" : "image")) === "video"
        ? ("video" as const)
        : ("image" as const),
    aspectRatio: generation?.aspectRatio,
    prompt: generation?.prompt,
    provider: (favorite.provider ?? generation?.provider ?? "grok") as FavoriteProvider,
    checkpoint: undefined,
  };
}

/**
 * Toggle a single image (identified by its B2 key) as a favorite for the
 * current user. Returns the new state. The generation's formState is copied in
 * so the Favorites page can reproduce/enhance without joining back.
 */
export const toggle = mutation({
  args: {
    generationId: v.optional(v.id("generations")),
    /** Set instead for a result from the API tab. */
    apiGenerationId: v.optional(v.id("grokGenerations")),
    /** Set instead for a result from the Enhance page. */
    enhancementId: v.optional(v.id("enhancements")),
    b2Key: v.string(),
  },
  handler: async (ctx, args) => {
    const identity = await requireAllowedUser(ctx);

    const existing = await ctx.db
      .query("favorites")
      .withIndex("by_user_key", (q) => q.eq("userId", identity.subject).eq("b2Key", args.b2Key))
      .first();

    if (existing) {
      await ctx.db.delete(existing._id);
      return { favorited: false };
    }

    if (args.enhancementId) {
      const enhancement = await ctx.db.get(args.enhancementId);
      if (!enhancement || enhancement.userId !== identity.subject) {
        throw new Error("Enhancement not found or not owned by user");
      }
      // The same rule the other two branches enforce, against the one key an
      // enhancement produces: a client must not file someone else's object
      // under its own favourite.
      if (enhancement.resultB2Key !== args.b2Key) {
        throw new Error("That file does not belong to this enhancement");
      }
      // No formState to copy. An enhancement's settings live on its own row and
      // are read back when reproducing, the same way an API row's are.
      await ctx.db.insert("favorites", {
        userId: identity.subject,
        enhancementId: args.enhancementId,
        b2Key: args.b2Key,
        mediaType: "image",
        provider: "enhance",
        createdAt: Date.now(),
      });
      return { favorited: true };
    }

    if (args.apiGenerationId) {
      const generation = await ctx.db.get(args.apiGenerationId);
      if (!generation || generation.userId !== identity.subject) {
        throw new Error("Generation not found or not owned by user");
      }
      assertOwnsKey(generation, args.b2Key);
      // No formState to copy: the API tab's settings live on the row itself and
      // are read back when reproducing, so there is nothing to denormalise.
      await ctx.db.insert("favorites", {
        userId: identity.subject,
        apiGenerationId: args.apiGenerationId,
        b2Key: args.b2Key,
        mediaType: generation.mediaType,
        provider: generation.provider ?? "grok",
        createdAt: Date.now(),
      });
      return { favorited: true };
    }

    if (!args.generationId) throw new Error("A generation id is required");
    const generation = await ctx.db.get(args.generationId);
    if (!generation || generation.userId !== identity.subject) {
      throw new Error("Generation not found or not owned by user");
    }
    assertOwnsKey(generation, args.b2Key);

    await ctx.db.insert("favorites", {
      userId: identity.subject,
      generationId: args.generationId,
      b2Key: args.b2Key,
      formState: generation.formState,
      mediaType: "image",
      provider: "self-hosted",
      checkpoint: generation.formState.checkpoint,
      createdAt: Date.now(),
    });
    return { favorited: true };
  },
});

/**
 * Drop a favorite, and only ever drop.
 *
 * `toggle` is right for a heart, where the two states are the point. It is wrong for a
 * "Remove" in a confirmation dialog: the grid can be a moment behind the database — the
 * same row unhearted in the viewer a second earlier — and toggling a row that is
 * already gone *creates* it, so the destructive action silently did the opposite of
 * what it said. Absent is success here, not a signal to insert.
 */
export const removeByKey = mutation({
  args: { b2Key: v.string() },
  handler: async (ctx, args): Promise<void> => {
    const identity = await requireAllowedUser(ctx);
    const existing = await ctx.db
      .query("favorites")
      .withIndex("by_user_key", (q) => q.eq("userId", identity.subject).eq("b2Key", args.b2Key))
      .first();
    if (existing) await ctx.db.delete(existing._id);
  },
});

/** Bulk delete for the selection toolbar. Rows not owned (or already gone) are skipped. */
export const removeMany = mutation({
  args: { favoriteIds: v.array(v.id("favorites")) },
  handler: async (ctx, args): Promise<void> => {
    const identity = await requireAllowedUser(ctx);
    for (const favoriteId of args.favoriteIds) {
      const row = await ctx.db.get(favoriteId);
      if (row && row.userId === identity.subject) await ctx.db.delete(favoriteId);
    }
  },
});

/**
 * File the selected favourites into a folder — or back into the unfiled pool
 * when `folderId` is absent. Skips rows that are not the caller's rather than
 * failing the whole batch: a stale selection should not abort the move.
 */
export const moveToFolder = mutation({
  args: {
    favoriteIds: v.array(v.id("favorites")),
    folderId: v.optional(v.id("favoriteFolders")),
  },
  handler: async (ctx, args): Promise<void> => {
    const identity = await requireAllowedUser(ctx);
    if (args.folderId) {
      const folder = await ctx.db.get(args.folderId);
      if (!folder || folder.userId !== identity.subject) {
        throw new Error("Folder not found");
      }
    }
    for (const favoriteId of args.favoriteIds) {
      const row = await ctx.db.get(favoriteId);
      if (!row || row.userId !== identity.subject) continue;
      await ctx.db.patch(favoriteId, { folderId: args.folderId });
    }
  },
});

/** All of the current user's favorited B2 keys — for rendering heart state in grids. */
export const myKeys = query({
  args: {},
  handler: async (ctx): Promise<string[]> => {
    const identity = await allowedUserOrNull(ctx);
    if (!identity) return [];
    // Bounded: this drives the heart on every grid, and a read that outgrows
    // the transaction budget would take the hearts off all of them at once.
    // Beyond the newest few thousand, an older item simply shows unhearted
    // until it is opened from the Favorites page.
    const favs = await ctx.db
      .query("favorites")
      .withIndex("by_user_createdAt", (q) => q.eq("userId", identity.subject))
      .order("desc")
      .take(5000);
    return favs.map((f) => f.b2Key);
  },
});

/**
 * The current user's favorites, newest first — for the Favorites page.
 *
 * Every row is enriched (see enrichFavorite) and the optional filters are
 * applied after enrichment, so legacy rows without denormalised columns filter
 * exactly like new ones. A filtered page can therefore come back smaller than
 * requested — usePaginatedQuery keeps paging, which is the intended behaviour.
 */
export const listFavorites = query({
  args: {
    paginationOpts: paginationOptsValidator,
    folderId: folderFilterValidator,
    mediaType: v.optional(v.union(v.literal("image"), v.literal("video"))),
    providers: v.optional(v.array(v.string())),
    checkpoints: v.optional(v.array(v.string())),
  },
  handler: async (ctx, args) => {
    const identity = await allowedUserOrNull(ctx);
    if (!identity) {
      return { page: [], isDone: true, continueCursor: "" };
    }
    const result = await favoritesInScope(
      ctx,
      identity.subject,
      resolveFolderFilter(ctx, args.folderId),
    ).paginate(args.paginationOpts);

    const enriched = await Promise.all(
      result.page.map((favorite) => enrichFavorite(ctx, favorite)),
    );

    // The folder is already scoped by the index above (and a garbage id has
    // been normalised away), so only the column filters apply here — through
    // the same predicate the web page uses to narrow rows it already holds.
    const page = enriched.filter((favorite) =>
      matchesFavoriteFilters(favorite, {
        mediaType: args.mediaType,
        providers: args.providers,
        checkpoints: args.checkpoints,
      }),
    );

    return { ...result, page };
  },
});

/**
 * How many favourites the facet counter will read.
 *
 * Facets are folder-scoped totals for the filter chips, so they need every row
 * in scope, not a page. The bound keeps a pathological account from outgrowing
 * the transaction budget; below it the counts are exact.
 */
const FACET_LIMIT = 4000;

/**
 * Filter facets for the Favorites page: how many favourites in the current
 * folder scope are images/clips, came from which provider, and (for
 * self-hosted rows) used which checkpoint.
 *
 * Rows with denormalised columns are counted for free; legacy rows cost one
 * join each, the same read enrichFavorite performs.
 */
export const facets = query({
  args: { folderId: folderFilterValidator },
  handler: async (
    ctx,
    args,
  ): Promise<{
    total: number;
    mediaTypes: { image: number; video: number };
    providers: Array<{ value: FavoriteProvider; count: number }>;
    checkpoints: Array<{ value: string; count: number }>;
  }> => {
    const identity = await allowedUserOrNull(ctx);
    const empty = {
      total: 0,
      mediaTypes: { image: 0, video: 0 },
      providers: [],
      checkpoints: [],
    };
    if (!identity) return empty;

    const rows = await favoritesInScope(
      ctx,
      identity.subject,
      resolveFolderFilter(ctx, args.folderId),
    ).take(FACET_LIMIT);

    const mediaTypes = { image: 0, video: 0 };
    const providers = new Map<FavoriteProvider, number>();
    const checkpoints = new Map<string, number>();

    for (const row of rows) {
      let mediaType = row.mediaType;
      let provider = row.provider as FavoriteProvider | undefined;
      let checkpoint = row.checkpoint;

      if (row.enhancementId) {
        provider ??= "enhance";
        mediaType ??= "image";
      } else if (row.apiGenerationId) {
        if (!provider || !mediaType) {
          const generation = await ctx.db.get(row.apiGenerationId);
          provider ??= (generation?.provider ?? "grok") as FavoriteProvider;
          mediaType ??= generation?.mediaType ?? (isVideoKey(row.b2Key) ? "video" : "image");
        }
      } else {
        provider ??= "self-hosted";
        mediaType ??= "image";
        checkpoint ??=
          row.formState?.checkpoint ??
          (row.generationId
            ? (await ctx.db.get(row.generationId))?.formState.checkpoint
            : undefined);
      }

      mediaTypes[mediaType ?? "image"] += 1;
      const providerKey = provider ?? "self-hosted";
      providers.set(providerKey, (providers.get(providerKey) ?? 0) + 1);
      if (checkpoint) checkpoints.set(checkpoint, (checkpoints.get(checkpoint) ?? 0) + 1);
    }

    const toSorted = <T extends string>(map: Map<T, number>) =>
      [...map]
        .map(([value, count]) => ({ value, count }))
        .sort((left, right) => right.count - left.count || left.value.localeCompare(right.value));

    return {
      total: rows.length,
      mediaTypes,
      providers: toSorted(providers),
      checkpoints: toSorted(checkpoints),
    };
  },
});
