import { hasMedia, type FeedItem } from "./types";

/**
 * The list the grid was showing, handed to the viewer.
 *
 * The viewer used to re-derive the feed from `useFeed`, on the theory that it is
 * the same Convex query so it costs nothing. It is the same query but not the
 * same pagination: state belongs to the hook instance, so the grid could be five
 * pages deep while the viewer's subscription started on its first. The row that
 * was tapped was then simply absent, which produced two bugs in turn — opening
 * the newest clip instead of the tapped one, and, once that was replaced by
 * "page until you find it", a spinner that could sit there for pages.
 *
 * A module-level box rather than route params because this is an array of objects,
 * and the same reason `pendingHandoff` is one. Read once and cleared, so a second
 * visit cannot re-use a stale list.
 */
export const pendingViewer: { items?: FeedItem[]; index?: number } = {};

/**
 * Only what the viewer can actually show travels.
 *
 * The Library's grid holds pending and processing rows — a generation that has been
 * accepted and has produced no file yet — and they were handed over with everything
 * else. `ViewerPage` renders a row with no media as a plain black rectangle, so
 * swiping from a finished image onto its still-running neighbour looked exactly like
 * the viewer had broken. Failed rows are excluded for the same reason and because the
 * grid sends those to the failure sheet instead.
 */
export function openViewer(items: FeedItem[], item: FeedItem): { index: number } {
  const showable = items.filter((entry) => hasMedia(entry) && entry.status !== "failed");
  const index = Math.max(
    0,
    showable.findIndex((entry) => entry.id === item.id),
  );
  pendingViewer.items = showable;
  pendingViewer.index = index;
  return { index };
}

export function takeViewerHandoff(): { items?: FeedItem[]; index?: number } {
  const taken = { ...pendingViewer };
  delete pendingViewer.items;
  delete pendingViewer.index;
  return taken;
}
