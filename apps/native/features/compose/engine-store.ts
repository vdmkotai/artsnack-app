import { useSyncExternalStore } from "react";
import { Keyboard } from "react-native";
import { createMMKV } from "react-native-mmkv";

const store = createMMKV({ id: "artsnack.composer" });
const KEY = "engine";

/** Which composer the Create tab shows. */
export type Engine = "local" | "api";

/**
 * Self-hosted, unless told otherwise.
 *
 * The web opens on the ComfyUI form and reaches the hosted providers through a
 * tab; this app opened on Seedream only because the API composer happened to be
 * the tab's index route. Same default as the web now, remembered across launches.
 */
let current: Engine = store.getString(KEY) === "api" ? "api" : "local";

const listeners = new Set<() => void>();

/**
 * Module state rather than context, because engines are also switched from
 * outside the provider: `recreateLocal` is a plain function called from the
 * viewer (a root route). Making it navigate somewhere and hope a focus effect
 * picked up a flag was the shape this replaced.
 */
export function getEngine(): Engine {
  return current;
}

export function setEngine(next: Engine): void {
  if (next === current) return;
  // Switching engines swaps the whole composer, prompt field included; a keyboard
  // left over from the old one has nothing to type into.
  Keyboard.dismiss();
  current = next;
  store.set(KEY, next);
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useEngine(): Engine {
  return useSyncExternalStore(subscribe, getEngine);
}
