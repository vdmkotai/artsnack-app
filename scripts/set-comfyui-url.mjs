#!/usr/bin/env node
/**
 * Point Artsnack (Vercel prod + Convex prod) at a freshly-deployed RunPod ComfyUI pod.
 *
 *   bun run pod:url https://abc123xyz-8188.proxy.runpod.net
 *   bun run pod:url abc123xyz               # bare pod id -> proxy url is built for you
 *
 * What it does (idempotent — safe to re-run):
 *   1. Normalizes the URL (strips any trailing slash so the app never builds `${url}//object_info`).
 *   2. Probes the pod so a dead/half-booted URL never gets wired in.
 *   3. Sets NEXT_PUBLIC_COMFYUI_URL in Convex prod   (runtime — live immediately).
 *   4. Sets NEXT_PUBLIC_COMFYUI_URL in Vercel prod   (env) and redeploys (applies it).
 *
 * Requires the Vercel CLI and Convex CLI to be logged in locally, linked to your
 * own Vercel project and Convex deployment.
 */
import { execFileSync } from "node:child_process";

const VAR = "NEXT_PUBLIC_COMFYUI_URL";
const PORT = 8188;

const arg = process.argv[2];
if (!arg) {
  console.error(
    [
      "Usage: bun run pod:url <comfyui-url | runpod-pod-id>",
      "  bun run pod:url https://abc123-8188.proxy.runpod.net",
      "  bun run pod:url abc123",
    ].join("\n"),
  );
  process.exit(1);
}

// 1) Resolve + normalize
let url = /^https?:\/\//i.test(arg.trim())
  ? arg.trim()
  : `https://${arg.trim()}-${PORT}.proxy.runpod.net`;
url = url.replace(/\/+$/, ""); // drop trailing slash(es)
console.log(`ComfyUI URL → ${url}`);

const step = (m) => console.log(`\n▶ ${m}`);
const run = (cmd, args) => execFileSync(cmd, args, { stdio: "inherit" });

// 2) Probe reachability — don't wire in a URL that isn't actually serving
step("Probing pod reachability…");
try {
  const r = await fetch(`${url}/system_stats`, { signal: AbortSignal.timeout(15000) });
  if ([502, 503, 504].includes(r.status)) {
    throw new Error(`RunPod proxy returned ${r.status} — pod/ComfyUI not up yet`);
  }
  console.log(`  HTTP ${r.status} — reachable ✓`);
} catch (e) {
  console.error(`  ✗ ${url} is not reachable: ${e.message}`);
  console.error("  Make sure the pod is running and ComfyUI started, then retry.");
  process.exit(1);
}

// 3) Convex prod — runtime env, takes effect immediately (no deploy)
step("Setting Convex prod env…");
run("bunx", ["convex", "env", "set", VAR, url, "--prod"]);

// 4) Vercel prod — overwrite env var, then redeploy to apply it
step("Setting Vercel prod env…");
run("vercel", ["env", "add", VAR, "production", "--value", url, "--force", "-y"]);

step("Redeploying Vercel prod (applies the new env — same as the dashboard Redeploy)…");
const ls = JSON.parse(
  execFileSync("vercel", ["ls", "--environment", "production", "--format", "json", "-y"], {
    encoding: "utf8",
  }),
);
const latest = ls.deployments?.[0]?.url;
if (!latest) {
  console.error("  ✗ No production deployment found to redeploy.");
  process.exit(1);
}
run("vercel", ["redeploy", `https://${latest}`, "--target", "production", "--no-wait"]);

console.log(
  [
    `\n✅ Done — ${VAR} = ${url}`,
    "   • Convex prod: live now",
    "   • Vercel prod: rebuilding (~1 min)",
    "",
  ].join("\n"),
);
