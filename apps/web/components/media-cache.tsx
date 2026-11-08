"use client";

import { useEffect, useRef } from "react";
import { freshAtHead, prefetchMedia, registerMediaCache } from "@/lib/media-cache";

/** Registers the local media cache worker. Renders nothing; mounted once, in the root layout. */
export function MediaCacheRegistrar() {
  useEffect(() => registerMediaCache(), []);
  return null;
}

/** At most this many new results are prefetched at once. */
const MAX_FRESH = 8;

/**
 * Prefetches results that appear at the head of a newest-first list after it
 * first loaded — a generation that just finished — so opening one plays from
 * disk. Items appended at the tail (an older page arriving) are left alone,
 * and so is the first load, which would otherwise download a whole page. A
 * list that was replaced rather than grown (a filter toggled, another folder
 * opened) becomes the new baseline without prefetching anything:
 * `freshAtHead` tells the two apart.
 */
export function usePrefetchNewMedia(urls: readonly string[]) {
  const previous = useRef<readonly string[] | null>(null);
  const seen = useRef<Set<string> | null>(null);
  const signature = urls.join("\n");

  useEffect(() => {
    const list = signature ? signature.split("\n") : [];
    if (list.length === 0) return;
    const known = seen.current ?? new Set<string>();
    seen.current = known;
    const before = previous.current;
    previous.current = list;
    const fresh = before ? freshAtHead(before, list, known) : [];
    for (const url of list) known.add(url);
    prefetchMedia(fresh.slice(0, MAX_FRESH));
  }, [signature]);
}
