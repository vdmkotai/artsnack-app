/**
 * Copies the freshly built app into /Applications and launches it. Run via
 * `bun run --cwd apps/desktop install:local` (which builds first) — this file
 * only does the copy.
 *
 * `ditto` rather than `cp -R`: it preserves the code signature, resource
 * forks and symlinks inside the bundle, which a plain copy can mangle.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const built = join(root, "release", "mac-arm64", "ArtSnack.app");
const target = "/Applications/ArtSnack.app";

if (!existsSync(built)) {
  console.error(`No build at ${built}. Run \`bun run dist\` in apps/desktop first.`);
  process.exit(1);
}

/** An app bundle's CFBundleIdentifier, or null when it cannot be read. */
function bundleId(appPath: string): string | null {
  const result = spawnSync(
    "plutil",
    ["-extract", "CFBundleIdentifier", "raw", "-o", "-", join(appPath, "Contents", "Info.plist")],
    { encoding: "utf8" },
  );
  return result.status === 0 ? result.stdout.trim() : null;
}

// Only ever replace something that is ours: the same bundle id as the build.
if (existsSync(target)) {
  const ours = bundleId(built);
  if (!ours || bundleId(target) !== ours) {
    console.error(`${target} exists and is not ArtSnack (bundle id mismatch). Not touching it.`);
    process.exit(1);
  }
  spawnSync("osascript", ["-e", 'tell application "ArtSnack" to quit'], { stdio: "ignore" });
  await new Promise((resolve) => setTimeout(resolve, 800));
  rmSync(target, { recursive: true, force: true });
}

execFileSync("ditto", [built, target], { stdio: "inherit" });
spawnSync("xattr", ["-dr", "com.apple.quarantine", target], { stdio: "ignore" });
const version = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version as string;
console.log(`Installed ArtSnack ${version} to ${target}`);
// `open` hands the caller's environment to the app, and anything running
// inside an Electron-based tool (Claude Code, Cursor, VS Code's terminal)
// carries ELECTRON_RUN_AS_NODE=1 — which turns the launched app into a bare
// Node process that exits at once with no window and no log line.
const { ELECTRON_RUN_AS_NODE: _ignored, ...env } = process.env;
execFileSync("open", ["-a", target], { stdio: "inherit", env });
