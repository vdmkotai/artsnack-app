"use client";

import { useCallback, useLayoutEffect, useRef, useState } from "react";

// Multi-select state for image grids. Selection is keyed by a stable per-image
// identity (e.g. `${generationId}:${b2Key}`), NOT by array index — paginated
// Convex lists can prepend/reorder, and index-based selection would silently
// retarget onto different images.
//
// Plain click toggles a single item and moves the anchor; shift+click ADDS the
// inclusive range anchor..clicked to the existing selection (previous
// selections are kept) and leaves the anchor in place, matching file-manager
// behavior. `mode` lets touch/keyboard users enter selection without a
// shift+click.
//
// Every callback returned here keeps its identity for the life of the grid.
// `handleSelect` is handed to every tile, and it used to be rebuilt whenever
// `orderedKeys` changed — which is every push of a live list, since each one is
// a new array — so `React.memo` on the tiles never held and a background
// progress write re-rendered the whole grid. The anchor and the key order are
// therefore read through refs at click time instead of being closed over.
export function useImageSelection(orderedKeys: readonly string[]) {
  const [selectedKeys, setSelectedKeys] = useState<ReadonlySet<string>>(() => new Set());
  const [mode, setMode] = useState(false);
  // Never rendered, only consulted by the next shift+click.
  const anchorKey = useRef<string | null>(null);
  const keys = useRef(orderedKeys);
  useLayoutEffect(() => {
    keys.current = orderedKeys;
  }, [orderedKeys]);

  const selectionActive = mode || selectedKeys.size > 0;

  const handleSelect = useCallback((key: string, shiftKey: boolean) => {
    const anchor = anchorKey.current;
    if (shiftKey && anchor !== null) {
      const ordered = keys.current;
      const anchorIdx = ordered.indexOf(anchor);
      const targetIdx = ordered.indexOf(key);
      if (anchorIdx !== -1 && targetIdx !== -1) {
        const from = Math.min(anchorIdx, targetIdx);
        const to = Math.max(anchorIdx, targetIdx);
        const range = ordered.slice(from, to + 1);
        setSelectedKeys((prev) => new Set([...prev, ...range]));
        return; // anchor stays put for the next shift+click
      }
    }
    setSelectedKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
    anchorKey.current = key;
  }, []);

  const clearSelection = useCallback(() => {
    setSelectedKeys(new Set());
    anchorKey.current = null;
  }, []);

  /** Replaces the selection outright — "select all" over whatever is showing. */
  const selectKeys = useCallback((next: readonly string[]) => {
    setSelectedKeys(new Set(next));
    anchorKey.current = null;
  }, []);

  const enterSelection = useCallback(() => setMode(true), []);

  const exitSelection = useCallback(() => {
    setSelectedKeys(new Set());
    anchorKey.current = null;
    setMode(false);
  }, []);

  return {
    selectedKeys,
    selectionActive,
    handleSelect,
    clearSelection,
    selectKeys,
    enterSelection,
    exitSelection,
  };
}
