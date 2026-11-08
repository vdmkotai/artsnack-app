"use client";

import { useSyncExternalStore } from "react";
import type { DesktopBridge, DesktopState } from "@/lib/desktop-bridge";

declare global {
  interface Window {
    /** Present only inside the macOS shell (apps/desktop). */
    artsnackDesktop?: DesktopBridge;
  }
}

function bridge(): DesktopBridge | undefined {
  return typeof window === "undefined" ? undefined : window.artsnackDesktop;
}

function subscribe(onChange: () => void): () => void {
  return bridge()?.subscribe(onChange) ?? (() => {});
}

/**
 * contextBridge clones every value that crosses it, so `getState()` returns a
 * fresh object on each call. useSyncExternalStore compares snapshots by
 * identity and would re-render forever ("Maximum update depth exceeded") if
 * it saw that, so the last snapshot is kept and reused while nothing changed.
 */
let cached: DesktopState | null = null;

function sameState(a: DesktopState, b: DesktopState): boolean {
  return (
    a.platform === b.platform &&
    a.appVersion === b.appVersion &&
    a.fullScreen === b.fullScreen &&
    a.zoomFactor === b.zoomFactor
  );
}

function getSnapshot(): DesktopState | null {
  const next = bridge()?.getState();
  if (!next) return null;
  if (cached && sameState(cached, next)) return cached;
  cached = next;
  return cached;
}

function getServerSnapshot(): null {
  return null;
}

/**
 * The shell's state, or null in a browser. Null on the server and on the
 * hydration pass too, so the first client render matches the server's HTML;
 * React then re-renders with the real snapshot before paint.
 */
export function useDesktop(): DesktopState | null {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

/**
 * Screen pixels the traffic lights need, measured from the window's left
 * edge: 18px offset + 52px of buttons + breathing room. Must match
 * TRAFFIC_LIGHT_X in apps/desktop/src/config.ts.
 */
const TRAFFIC_LIGHT_SCREEN_PX = 84;

/**
 * Left padding, in CSS pixels, the header needs to keep clear of macOS's
 * traffic lights, or null when there are none to avoid (browser, other
 * platforms, full screen). The buttons are native and never zoom, but CSS
 * pixels do: at 80% page zoom, 84 CSS pixels is only 67 real ones and the
 * first tab slides under the green button. Dividing by the zoom factor keeps
 * the gap constant on screen.
 */
export function useTrafficLightInset(): number | null {
  const desktop = useDesktop();
  if (!desktop || desktop.platform !== "darwin" || desktop.fullScreen) return null;
  const zoom = desktop.zoomFactor > 0 ? desktop.zoomFactor : 1;
  return Math.ceil(TRAFFIC_LIGHT_SCREEN_PX / zoom);
}
