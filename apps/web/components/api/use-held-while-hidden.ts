"use client";

import { useState } from "react";

/**
 * The value as it last was while `visible`, for as long as it is not.
 *
 * The composers on /generate are hidden with `hidden`, not unmounted, so their
 * live lists keep arriving while another tab is on screen — and a running
 * self-hosted job writes its row every second or two. Holding the list for a
 * hidden panel leaves everything derived from it identical, so the React
 * Compiler's memo blocks and the memoized tiles skip all of that work; the
 * first render after the panel is shown again catches up in one go.
 *
 * The held value is React state, updated during render while visible — the
 * "store information from previous renders" pattern. That keeps it tied to
 * what React actually commits: an update made by a render that is interrupted
 * or thrown away is discarded with it, so a hidden render can only ever return
 * a value that a committed visible render showed. (It used to live in a
 * module-level WeakMap written during render, where an abandoned transition
 * could leave a value that was never on screen.) Not a ref: the React Compiler
 * will not optimise a component that reads a ref during render.
 *
 * The set-state only fires when the value changes while visible, and React
 * re-runs the hook's owner immediately rather than committing twice.
 */
export function useHeldWhileHidden<T>(value: T, visible: boolean): T {
  // Wrapped, so a function value is stored rather than called as an updater.
  const [held, setHeld] = useState(() => value);
  if (visible && held !== value) setHeld(() => value);
  return visible ? value : held;
}
