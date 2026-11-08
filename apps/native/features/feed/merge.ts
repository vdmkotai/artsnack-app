import type { FeedItem } from "./types";

/**
 * Merging two independently paginated, newest-first sources into one list.
 *
 * Convex paginates over one index at a time, so any feed that spans two tables has two
 * cursors and no shared position. The Library (self-hosted generations plus
 * hosted-API rows) is that shape, which is why this lives on its own rather than
 * inside its hook.
 *
 * The merge itself is a linear pass, because both sides arrive sorted. The part that is
 * easy to get wrong is the tail: an item older than the oldest thing held from the
 * *other* source cannot be placed yet, because the other source's next page may belong
 * in front of it. Rendering it anyway makes tiles jump when more loads. So the list is
 * cut at the newer of the two tails, and only an exhausted source stops constraining
 * it.
 */
export function mergeByTime(a: FeedItem[], b: FeedItem[]): FeedItem[] {
  const out: FeedItem[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    out.push(a[i].createdAt >= b[j].createdAt ? a[i++] : b[j++]);
  }
  while (i < a.length) out.push(a[i++]);
  while (j < b.length) out.push(b[j++]);
  return out;
}

export function tailTime(items: FeedItem[]): number | undefined {
  return items.length === 0 ? undefined : items[items.length - 1].createdAt;
}

/**
 * The oldest timestamp that can be rendered without risking a reorder. Undefined means
 * both sources are exhausted and everything held is final.
 */
export function safeBoundary(a: number | undefined, b: number | undefined): number | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  return Math.max(a, b);
}

/**
 * Trim a merged list to the boundary. Separate from the merge so a caller can decide
 * which sources are still constraining it.
 */
export function boundedByTail(items: FeedItem[], boundary: number | undefined): FeedItem[] {
  return boundary === undefined ? items : items.filter((item) => item.createdAt >= boundary);
}
