import { app } from "electron";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type AppUrlConfig, hostMatches, inAppHostSuffixes, resolveAppUrl } from "./app-url";

/**
 * The URL a packaged build was made for: scripts/package.ts writes
 * `ARTSNACK_DESKTOP_URL` into the bundled package.json as `artsnackDesktopUrl`.
 */
function packagedUrl(): string | null {
  try {
    const manifest = JSON.parse(readFileSync(join(app.getAppPath(), "package.json"), "utf8")) as {
      artsnackDesktopUrl?: unknown;
    };
    return typeof manifest.artsnackDesktopUrl === "string" ? manifest.artsnackDesktopUrl : null;
  } catch {
    return null;
  }
}

/**
 * Where the shell points: `--url=`, `ARTSNACK_DESKTOP_URL`, or the URL the
 * packaged build was made for (see app-url.ts). There is no default; without
 * one the window shows the setup page instead.
 */
export const APP_CONFIG: AppUrlConfig = resolveAppUrl({
  argv: process.argv,
  env: process.env,
  packaged: packagedUrl(),
});

/** The configured web app, or null when the shell is not set up. */
export const APP_URL: URL | null = APP_CONFIG.ok ? APP_CONFIG.url : null;

/**
 * Hosts that may load inside the window: the app's own host and its parent
 * domain (where Clerk's production Frontend API lives), Clerk, and the OAuth
 * providers' pages. Everything else opens in the default browser.
 */
const IN_APP_HOST_SUFFIXES = inAppHostSuffixes(APP_URL);

export function isInAppUrl(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol === "file:" || url.protocol === "about:" || url.protocol === "blob:") {
    return true;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return false;
  if (url.hostname === "localhost" || url.hostname === "127.0.0.1") return true;
  return hostMatches(url.hostname, IN_APP_HOST_SUFFIXES);
}

/** The app's own pages — the only URLs the offline page may bounce back to. */
export function isAppOrigin(raw: string): boolean {
  if (!APP_URL) return false;
  try {
    return new URL(raw).origin === APP_URL.origin;
  } catch {
    return false;
  }
}

/**
 * Matches `.dark { --background }` in apps/web/app/globals.css so the window
 * never flashes white before the page paints.
 */
export const WINDOW_BACKGROUND = "#1b1a17";

/** apps/web's header is h-14 = 56 CSS px; page zoom scales it on screen. */
export const HEADER_CSS_PX = 56;
/** macOS draws the three buttons 12px tall. */
export const TRAFFIC_LIGHT_HEIGHT_PX = 12;
/** Left offset of the buttons, in screen px. Mirrored by use-desktop.ts. */
export const TRAFFIC_LIGHT_X = 18;

/**
 * Where the traffic lights go for a given zoom: always centred on the header
 * as it is actually drawn. At 100% that is y=22; at 80% the header is 45px
 * tall and they move up to 16.
 */
export function trafficLightPosition(zoomFactor: number): { x: number; y: number } {
  const headerPx = HEADER_CSS_PX * (zoomFactor > 0 ? zoomFactor : 1);
  return {
    x: TRAFFIC_LIGHT_X,
    y: Math.max(6, Math.round((headerPx - TRAFFIC_LIGHT_HEIGHT_PX) / 2)),
  };
}

export const PRODUCT_NAME = "ArtSnack";

export function appVersion(): string {
  return app.getVersion();
}
