import { ConvexReactClient } from "convex/react";

const ENV_HINT = "copy apps/native/.env.example to apps/native/.env.local and fill it in";

const url = process.env.EXPO_PUBLIC_CONVEX_URL;
if (!url) {
  // Failing here beats a client that connects to nothing and renders empty
  // states forever, which is indistinguishable from "you have no generations".
  throw new Error(`EXPO_PUBLIC_CONVEX_URL is not set — ${ENV_HINT}`);
}

// Read by packages/shared/media-url.ts. Without it every image URL falls back to
// a same-origin `/api/images/...` path, which only means something in a browser,
// so on a phone the whole library would render as grey tiles.
if (!process.env.EXPO_PUBLIC_MEDIA_URL) {
  throw new Error(`EXPO_PUBLIC_MEDIA_URL is not set — ${ENV_HINT}`);
}

export const convex = new ConvexReactClient(url, {
  // The web app disables this too. Nothing here is a form the user could lose by
  // navigating away; every write is a mutation that either lands or reports.
  unsavedChangesWarning: false,
});
