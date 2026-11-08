import type { MasonryLayout } from "@/components/media-masonry";

/** The page size the composers start with, and the least a page asks for. */
const MIN_PAGE_ROWS = 30;
/**
 * The most one page asks for. Convex splits any page longer than twice the
 * first one in the background — the rows stay on screen while it does, at the
 * cost of reading them again — so this is kept to what a dense grid needs.
 */
export const MAX_PAGE_ROWS = 400;

/**
 * Rows to ask for so the next page fills about two screens.
 *
 * A fixed 30 rows is two screens at 100% preview zoom and a sliver at 25%,
 * where fourteen narrow columns swallow a page in a few hundred pixels: paging
 * is sequential, so the reader spent nearly all of a steady scroll looking at
 * the end of the list waiting for the next one. At 50% it was a quarter of the
 * time, at 100% a tenth.
 *
 * Sized from what the loaded rows actually laid out to — pixels of grid per
 * row — so tile shape, batch size and filters all count: a filter that shows
 * one tile in twenty rows asks for the most, which is also what finds its
 * matches fastest. Before anything is laid out, the column count stands in,
 * assuming square tiles.
 */
export function pageRowsFor(
  layout: MasonryLayout | null,
  loadedRows: number,
  screenHeight = typeof window === "undefined" ? 0 : window.innerHeight,
): number {
  if (!layout || screenHeight <= 0) return MIN_PAGE_ROWS;
  const rows =
    layout.height > 0 && loadedRows > 0
      ? (2 * screenHeight * loadedRows) / layout.height
      : layout.columnWidth > 0
        ? 2 * layout.columns * Math.ceil(screenHeight / layout.columnWidth)
        : MIN_PAGE_ROWS;
  if (!Number.isFinite(rows)) return MIN_PAGE_ROWS;
  return Math.min(MAX_PAGE_ROWS, Math.max(MIN_PAGE_ROWS, Math.ceil(rows)));
}
