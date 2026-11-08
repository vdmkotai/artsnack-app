/** One tile. A row with four outputs becomes four of these. */
export type FeedItem = {
  /** Stable across renders and unique across every source. */
  id: string;
  /** Which table it came from. Never shown on the tile — only in the viewer. */
  /**
   * Which table `rowId` points into.
   *
   * "enhance" is its own value rather than being folded into "api": a favourite
   * of an enhanced image points at the `enhancements` table, and Convex's
   * `v.id(table)` rejects a cross-table id outright — so filing one under "api"
   * made every un-favourite throw an argument-validation error that nothing
   * surfaced.
   */
  source: "local" | "video" | "api" | "enhance";
  /** Row id, for opening the viewer and for mutations. */
  rowId: string;
  /**
   * The `favorites` document behind this tile, when it came from the favourites
   * feed. `rowId` deliberately points at the *generation* (see the comment in
   * use-favourites-feed.ts), so folder moves and bulk removal — which address the
   * favourites table itself — need the document id carried separately.
   */
  favoriteId?: string;
  createdAt: number;
  kind: "image" | "video";
  /** B2 key. Absent while pending and on a row that failed before producing. */
  mediaKey?: string;
  /** A separately rendered poster, used by self-hosted video search results. */
  thumbnailKey?: string;
  status: "pending" | "processing" | "completed" | "failed";
  prompt: string;
  /** width / height. Read from the row so the grid lays out before media loads. */
  aspect: number;
  /** Only on failures: the machine-readable class that decides what we offer. */
  errorKind?: string;
  /** On failures, the reason; on a completed image row, the shortfall note —
   *  why fewer images arrived than were requested. */
  error?: string;
  /** How many outputs the row asked for (hosted image rows only). */
  requestedCount?: number;
  /** How many outputs the row actually holds. Fewer than requested means part
   *  of the fan-out was refused — the tile shows "1 of 4". */
  producedCount?: number;
  progressStage?: string;
  progressMessage?: string;
  progressCurrent?: number;
  progressTotal?: number;
  queuePosition?: number;
  providerStatus?: string;
  dispatchedAt?: number;
};

/**
 * Whether there is something to draw: a row that has not produced a file yet has
 * no key, and every grid and the viewer key their placeholder off that.
 */
export function hasMedia(item: FeedItem): boolean {
  return Boolean(item.mediaKey);
}

const RATIO = /^(\d+(?:\.\d+)?)\s*[:x/]\s*(\d+(?:\.\d+)?)$/;

/**
 * Aspect from whatever the row happens to carry.
 *
 * Self-hosted rows store real pixel dimensions in `formState`. Hosted-API rows
 * store the ratio they asked the vendor for, as a string. Neither stores the
 * dimensions of the file that came back, so this is what the grid has — which is
 * fine, because it is what the grid needs *before* the file arrives.
 */
export function aspectFrom(value: string | undefined, width?: number, height?: number): number {
  if (width && height && height > 0) return width / height;
  if (value) {
    const match = RATIO.exec(value.trim());
    if (match) {
      const w = Number(match[1]);
      const h = Number(match[2]);
      if (w > 0 && h > 0) return w / h;
    }
  }
  return 1;
}
