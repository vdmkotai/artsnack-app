/**
 * Which slice of the search results the grid mounts.
 *
 * The grid grows a page at a time as the user scrolls down, so a session that
 * scrolled through 3,000 results has 3,000 tiles mounted — fine while it grew
 * gradually, but a return to /search used to mount all of them again in one
 * commit just to put the user back where they were. A restored grid instead
 * mounts a window around the remembered anchor and grows in both directions.
 *
 * The window is anchored to a result id, not an index: a generation finishing
 * while the user browses inserts at the top of the results, and an index-based
 * window would shift every mounted tile by one.
 */

export type SearchWindow = {
  /** Result the window is anchored to; null is the ordinary grid from the top. */
  pivotId: string | null;
  /** Where the pivot was, used while it is missing (deleted) from the results. */
  pivotHint: number;
  /** Results mounted above the pivot. */
  before: number;
  /** Results mounted from the pivot on. */
  after: number;
};

export type SearchWindowRange = { start: number; pivot: number; end: number };

export type SearchScrollPosition = {
  /** Serialized intent of the results the position belongs to. */
  intentKey: string;
  anchorKey: string | null;
  /** The anchor's index in those results, used if its result is gone. */
  anchorIndex: number;
  /** Viewport offset of the anchor's top edge. */
  anchorOffset: number;
};

export const SEARCH_WINDOW_PAGE = 180;
/** Results mounted above a restored anchor, so a short scroll up has content. */
export const SEARCH_RESTORE_BEFORE = 60;
/** Anchors this close to the top restore as an ordinary grid. */
export const SEARCH_RESTORE_THRESHOLD = 240;

export const FRESH_SEARCH_WINDOW: SearchWindow = {
  pivotId: null,
  pivotHint: 0,
  before: 0,
  after: SEARCH_WINDOW_PAGE,
};

export const TOP_SEARCH_SCROLL: SearchScrollPosition = {
  intentKey: "",
  anchorKey: null,
  anchorIndex: 0,
  anchorOffset: 0,
};

type Identified = { id: string };

/** The index the restored anchor should land on: its result, else where it was. */
export function restoredAnchorIndex(
  results: readonly Identified[],
  position: SearchScrollPosition,
): number {
  if (results.length === 0) return 0;
  const found = position.anchorKey
    ? results.findIndex((result) => result.id === position.anchorKey)
    : -1;
  if (found >= 0) return found;
  return Math.min(Math.max(0, position.anchorIndex), results.length - 1);
}

export function restoredSearchWindow(
  results: readonly Identified[],
  anchorIndex: number,
): SearchWindow {
  if (anchorIndex < SEARCH_RESTORE_THRESHOLD || anchorIndex >= results.length) {
    return {
      ...FRESH_SEARCH_WINDOW,
      after: Math.max(SEARCH_WINDOW_PAGE, anchorIndex + SEARCH_WINDOW_PAGE),
    };
  }
  return {
    pivotId: results[anchorIndex].id,
    pivotHint: anchorIndex,
    before: SEARCH_RESTORE_BEFORE,
    after: SEARCH_WINDOW_PAGE,
  };
}

export function resolveSearchWindow(
  results: readonly Identified[],
  current: SearchWindow,
): SearchWindowRange {
  let pivot = 0;
  if (current.pivotId !== null && results.length > 0) {
    const found = results.findIndex((result) => result.id === current.pivotId);
    pivot = found >= 0 ? found : Math.min(current.pivotHint, results.length - 1);
  }
  return {
    start: Math.max(0, pivot - current.before),
    pivot,
    end: Math.min(results.length, pivot + current.after),
  };
}

export function growSearchWindowAfter(current: SearchWindow): SearchWindow {
  return { ...current, after: current.after + SEARCH_WINDOW_PAGE };
}

export function growSearchWindowBefore(current: SearchWindow, pivot: number): SearchWindow {
  return { ...current, before: Math.min(pivot, current.before + SEARCH_WINDOW_PAGE) };
}

type Box = { getBoundingClientRect(): { bottom: number } };

/**
 * Index of the first box whose bottom edge is below `viewportTop`, for boxes in
 * reading order (each row's bottom is at or below the previous row's), or -1.
 */
export function firstVisibleIndex(boxes: ArrayLike<Box>, viewportTop: number): number {
  let low = 0;
  let high = boxes.length - 1;
  let match = -1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    if (boxes[middle].getBoundingClientRect().bottom > viewportTop) {
      match = middle;
      high = middle - 1;
    } else low = middle + 1;
  }
  return match;
}
