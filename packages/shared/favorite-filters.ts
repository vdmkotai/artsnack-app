/**
 * What the Favorites filters mean, in one place for both sides of the wire.
 *
 * `convex/favorites.ts:listFavorites` applies it to every enriched row it
 * returns, and the web page applies it to the rows it already holds, so a chip
 * click can show the narrowed view in the same frame instead of waiting for
 * the server to answer the new query. The two must never disagree about which
 * row belongs where — a view that briefly showed a row the server then drops
 * reads as a glitch.
 */

/** The fields of an enriched favourite the filters look at. */
export type FilterableFavorite = {
  folderId?: string;
  mediaType: "image" | "video";
  provider: string;
  checkpoint?: string;
};

export type FavoriteFilters = {
  /** undefined for every favourite, "none" for the unfiled ones, else a folder id. */
  folder?: string;
  mediaType?: "image" | "video";
  /** Empty means any provider. */
  providers?: readonly string[];
  /** Empty means any checkpoint; a non-empty list excludes rows without one. */
  checkpoints?: readonly string[];
};

export function matchesFavoriteFilters(
  favorite: FilterableFavorite,
  filters: FavoriteFilters,
): boolean {
  if (filters.folder === "none" && favorite.folderId !== undefined) return false;
  if (
    filters.folder !== undefined &&
    filters.folder !== "none" &&
    favorite.folderId !== filters.folder
  ) {
    return false;
  }
  if (filters.mediaType && favorite.mediaType !== filters.mediaType) return false;
  if (filters.providers?.length && !filters.providers.includes(favorite.provider)) return false;
  if (
    filters.checkpoints?.length &&
    (!favorite.checkpoint || !filters.checkpoints.includes(favorite.checkpoint))
  ) {
    return false;
  }
  return true;
}
