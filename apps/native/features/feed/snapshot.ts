import { createMMKV } from "react-native-mmkv";

import type { FeedItem } from "./types";

const store = createMMKV({ id: "artsnack.feed-snapshot" });
const KEY = "items";
/** Enough to fill several screens of a three-column grid, and small as JSON. */
const MAX = 240;

/**
 * The last feed the app rendered, kept so a cold launch without a connection has
 * something to draw.
 *
 * Convex holds query results only while the client is alive: nothing survives a
 * restart, and `useQuery` returns undefined forever with no network — an empty
 * grid indistinguishable from "you have made nothing". The images are already on
 * disk in expo-image's cache; this is the few kilobytes of rows that say they
 * exist.
 *
 * A rendering aid, never a source of truth: it is replaced wholesale the moment a
 * live subscription arrives, and read only during a cold launch that has none.
 */
export function saveSnapshot(items: FeedItem[]) {
  if (items.length === 0) return;
  try {
    store.set(KEY, JSON.stringify(items.slice(0, MAX)));
  } catch {
    // A snapshot that cannot be written is not worth interrupting a feed for.
  }
}

export function readSnapshot(): FeedItem[] {
  const raw = store.getString(KEY);
  if (!raw) return [];
  try {
    return JSON.parse(raw) as FeedItem[];
  } catch {
    return [];
  }
}

export function clearSnapshot() {
  store.remove(KEY);
}

export function snapshotSize(): number {
  return readSnapshot().length;
}
