#!/usr/bin/env node
/**
 * One-shot Higgsfield re-auth for Artsnack.
 *
 *   bun run higgsfield:auth
 *
 * 1. Opens the Higgsfield browser login (higgsfield / hf CLI)
 * 2. Sets HIGGSFIELD_CREDENTIALS on Convex prod (seed)
 * 3. Replaces the higgsfieldAuth table on prod (what the app actually reads)
 *
 * Env alone is not enough when a dead row already exists — this always writes both.
 * Run from the repo root. Needs Convex CLI + packages/backend/.env.local.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const BACKEND = join(ROOT, "packages/backend");
const ENV_VAR = "HIGGSFIELD_CREDENTIALS";

const CREDENTIAL_CANDIDATES = [
  join(homedir(), ".config", "higgsfield", "credentials.json"),
  join(homedir(), "Library", "Application Support", "higgsfield", "credentials.json"),
];

const step = (m) => console.log(`\n▶ ${m}`);

// ---------------------------------------------------------------------------
// Preflight
// ---------------------------------------------------------------------------

if (!existsSync(join(BACKEND, ".env.local")) && !process.env.CONVEX_DEPLOYMENT) {
  console.error(
    [
      "✗ No Convex deployment config.",
      `  Expected ${join(BACKEND, ".env.local")} with CONVEX_DEPLOYMENT.`,
      "  Run `bunx convex dev` once inside packages/backend.",
    ].join("\n"),
  );
  process.exit(1);
}

// ---------------------------------------------------------------------------
// 1) Login
// ---------------------------------------------------------------------------

step("Higgsfield browser login…");
const cli = which("higgsfield") || which("hf");
if (!cli) {
  console.error(
    ["✗ Neither `higgsfield` nor `hf` is on PATH.", "  Install: npm i -g @higgsfield/cli"].join(
      "\n",
    ),
  );
  process.exit(1);
}
const login = spawnSync(cli, ["auth", "login"], { stdio: "inherit" });
if (login.status !== 0) {
  console.error(`  ✗ ${cli} auth login failed`);
  process.exit(login.status ?? 1);
}

// ---------------------------------------------------------------------------
// 2) Read credentials
// ---------------------------------------------------------------------------

step("Reading credentials…");
const credPath = CREDENTIAL_CANDIDATES.find((p) => existsSync(p));
if (!credPath) {
  console.error(
    [
      "✗ No credentials file after login. Looked in:",
      ...CREDENTIAL_CANDIDATES.map((p) => `    ${p}`),
    ].join("\n"),
  );
  process.exit(1);
}

const credentials = readFileSync(credPath, "utf8").trim();
validateCredentials(credentials, credPath);
console.log(`  ${credPath}`);
console.log(`  ${summarizeToken(credentials)}`);

// ---------------------------------------------------------------------------
// 3) Convex prod: env + table
// ---------------------------------------------------------------------------

step(`Convex prod: set ${ENV_VAR}…`);
{
  const r = spawnSync("bunx", ["convex", "env", "set", ENV_VAR, "--prod"], {
    cwd: BACKEND,
    input: credentials + "\n",
    encoding: "utf8",
    stdio: ["pipe", "inherit", "inherit"],
  });
  if (r.status !== 0) {
    console.error(`  ✗ convex env set failed (exit ${r.status})`);
    process.exit(r.status ?? 1);
  }
}

step("Convex prod: replace higgsfieldAuth table…");
{
  const dir = mkdtempSync(join(tmpdir(), "higgsfield-auth-"));
  const path = join(dir, "higgsfieldAuth.json");
  try {
    writeFileSync(path, JSON.stringify([{ credentials, updatedAt: Date.now() }]), "utf8");
    execFileSync(
      "bunx",
      ["convex", "import", "--table", "higgsfieldAuth", "--replace", "-y", "--prod", path],
      { cwd: BACKEND, stdio: "inherit" },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log(
  [
    "",
    "✅ Higgsfield re-authed on prod (env + table).",
    "  Retry a generation in the app.",
    "",
  ].join("\n"),
);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function validateCredentials(text, path) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    console.error(`✗ ${path} is not valid JSON`);
    process.exit(1);
  }
  if (!parsed?.access_token || !parsed?.refresh_token) {
    console.error(`✗ ${path} is missing access_token or refresh_token — login did not stick`);
    process.exit(1);
  }
}

function summarizeToken(text) {
  try {
    const p = JSON.parse(text);
    const token = String(p.access_token ?? "");
    const tail = token.length > 8 ? token.slice(-8) : token;
    const exp =
      typeof p.expires_at === "number"
        ? new Date(p.expires_at < 1e12 ? p.expires_at * 1000 : p.expires_at).toISOString()
        : "unknown";
    return `access_token …${tail}, expires_at ${exp}`;
  } catch {
    return "(unparsed)";
  }
}

function which(cmd) {
  const r = spawnSync("which", [cmd], { encoding: "utf8" });
  if (r.status !== 0) return null;
  return r.stdout.trim() || null;
}
