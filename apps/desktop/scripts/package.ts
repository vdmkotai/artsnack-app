/**
 * Runs electron-builder (arguments pass through) with the build-time settings
 * read from the environment:
 *
 * - `ARTSNACK_DESKTOP_APP_ID` replaces the bundle id in electron-builder.yml
 *   (the placeholder `com.example.artsnack.desktop`).
 * - `ARTSNACK_DESKTOP_URL` is baked into the packaged package.json as
 *   `artsnackDesktopUrl`, so the app knows its web app when started from the
 *   Dock or Finder, where it gets no shell environment. Without it the
 *   packaged app needs `ARTSNACK_DESKTOP_URL` or `--url=` at launch.
 *
 * Run through `bun run pack` / `dist` / `pack:linux`, which compile first.
 */
import { spawnSync } from "node:child_process";

const args = process.argv.slice(2);
const appId = process.env.ARTSNACK_DESKTOP_APP_ID?.trim();
if (appId) args.push(`-c.appId=${appId}`);
const url = process.env.ARTSNACK_DESKTOP_URL?.trim();
if (url) {
  try {
    new URL(url);
  } catch {
    console.error(`ARTSNACK_DESKTOP_URL is not a valid URL: ${url}`);
    process.exit(1);
  }
  args.push(`-c.extraMetadata.artsnackDesktopUrl=${url}`);
} else {
  console.warn(
    "ARTSNACK_DESKTOP_URL is not set: the packaged app will show its setup page unless started with ARTSNACK_DESKTOP_URL or --url=.",
  );
}

const result = spawnSync("electron-builder", args, { stdio: "inherit" });
process.exit(result.status ?? 1);
