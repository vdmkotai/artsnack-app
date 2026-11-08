"use client";

import dynamic from "next/dynamic";

/**
 * Dialogs that are closed on arrival, loaded only when wanted.
 *
 * The backend manager is big (~86 KB of its own) and subscribed to its Convex
 * queries while closed, on every page that offers it. It is now fetched the
 * first time its button is pointed at or focused — the `preload…` function —
 * and mounted the first time it opens, so arriving on /generate costs neither
 * the bytes nor the subscriptions.
 */

const loadBackendManagerDialog = () =>
  import("@/components/backend-manager-dialog").then((module) => module.BackendManagerDialog);

export const LazyBackendManagerDialog = dynamic(loadBackendManagerDialog, { ssr: false });

export function preloadBackendManagerDialog() {
  void loadBackendManagerDialog();
}
