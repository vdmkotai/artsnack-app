"use client";

import { useState } from "react";

/**
 * Bookkeeping fields that background jobs rewrite without changing anything a
 * grid shows. A self-hosted clip renews its poll lease every few seconds and
 * every progress report stamps `progressUpdatedAt`, so without ignoring them a
 * running job re-renders every tile of every list it appears in.
 */
export const VOLATILE_ROW_FIELDS: readonly string[] = [
  "atlasPollLeaseId",
  "atlasPollLeaseUntil",
  "progressUpdatedAt",
];

type Row = { _id: string };

type Entry<T> = { signature: string; row: T };

function signatureOf(row: Row, ignore: ReadonlySet<string>): string {
  return JSON.stringify(row, (key, value) => (ignore.has(key) ? undefined : value));
}

type Cache<T> = { entries: Map<string, Entry<T>>; result: T[] };

/**
 * One cache per hook instance, keyed by an object the instance owns. A
 * WeakMap rather than a ref because the React Compiler refuses to compile a
 * hook that reads a ref during render, and it can still memoise the call on
 * `rows` this way — which is exactly when the answer can change.
 */
const caches = new WeakMap<object, Cache<Row>>();

/**
 * Keeps the identity of rows whose content did not change.
 *
 * Every push to a Convex list — any page of it — hands back a new array of new
 * objects, even for rows nobody touched, so `React.memo` on a tile never holds
 * and the whole grid re-renders on each progress tick. This returns the previous
 * object for a row whose fields (minus `ignore`) are unchanged, and the previous
 * array when every row survived in the same order, which lets memoised tiles
 * and every `useMemo` keyed on the list bail out.
 *
 * Pure in render: the cache is derived from the input alone, so a discarded
 * render leaves it in a state the next render would have produced anyway.
 */
export function useStableRows<T extends Row>(
  rows: readonly T[],
  ignore: readonly string[] = VOLATILE_ROW_FIELDS,
): T[] {
  const [owner] = useState(() => ({}));
  return stabilizeRows(owner, rows, ignore);
}

function stabilizeRows<T extends Row>(
  owner: object,
  rows: readonly T[],
  ignore: readonly string[],
): T[] {
  const ignored = new Set(ignore);
  const previous = (caches.get(owner) as Cache<T> | undefined) ?? null;
  const entries = new Map<string, Entry<T>>();
  const result: T[] = [];
  let unchanged = previous !== null && previous.result.length === rows.length;

  rows.forEach((row, index) => {
    const signature = signatureOf(row, ignored);
    const known = previous?.entries.get(row._id);
    const stable = known && known.signature === signature ? known.row : row;
    entries.set(row._id, { signature, row: stable });
    result.push(stable);
    if (unchanged && previous!.result[index] !== stable) unchanged = false;
  });

  const kept = unchanged && previous ? previous.result : result;
  caches.set(owner, { entries, result: kept } as Cache<Row>);
  return kept;
}
