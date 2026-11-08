/**
 * HTTP wrapper around the Higgsfield CLI.
 *
 * Higgsfield publishes a CLI and an MCP server, not a documented REST API. The
 * CLI already knows the request shapes, the media upload handshake and the job
 * lifecycle, so driving it is far safer than reimplementing an API surface we
 * could only guess at. Convex cannot spawn processes, hence this container.
 *
 * The container is stateless — Vercel container functions "keep nothing between
 * calls" — so credentials travel with every request and any rotation is handed
 * straight back for the caller to persist.
 */

import http from "node:http";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { timingSafeEqual } from "node:crypto";

const PORT = Number(process.env.PORT || 3000);
const SHARED_SECRET = process.env.WORKER_SECRET;
/** Long enough for an upload plus job submission; never for a whole generation. */
const COMMAND_TIMEOUT_MS = Number(process.env.COMMAND_TIMEOUT_MS || 180_000);
const MAX_REFERENCE_BYTES = 32 * 1024 * 1024;
const REFERENCE_FETCH_TIMEOUT_MS = 60_000;
/** Only this host may be fetched. Convex sends CDN links and nothing else, so a
 *  leaked secret cannot turn the worker into a general-purpose fetch proxy. */
const ALLOWED_MEDIA_HOST = process.env.ALLOWED_MEDIA_HOST;
/** Params the CLI is allowed to receive, as defence in depth: Convex is the
 *  only intended caller, but an unexpected key becomes an unexpected flag. */
const ALLOWED_PARAMS = new Set([
  "prompt",
  "aspect_ratio",
  "duration",
  "resolution",
  "quality",
  "seed",
  // Seedance and Kling both call their quality axis `mode`.
  "mode",
  "generate_audio",
  "bitrate_mode",
  "genre",
  "sound",
]);

/**
 * Vendor output can echo credentials — the CLI reads and rewrites a token file,
 * and a verbose auth error may quote one. Errors travel to the database and
 * onto the screen, so anything token-shaped is masked before it leaves.
 */
function redact(text) {
  return String(text || "")
    .replace(/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, "[redacted-jwt]")
    .replace(
      /\b(authorization|bearer|token|refresh_token|access_token|api[_-]?key)\b\s*[:=]?\s*"?[A-Za-z0-9._~+/-]{12,}"?/gi,
      "$1 [redacted]",
    );
}

class WorkerError extends Error {
  constructor(message, status = 500, detail) {
    super(message);
    this.status = status;
    this.detail = detail;
  }
}

// ---------------------------------------------------------------------------
// Credentials
// ---------------------------------------------------------------------------

/**
 * Lays out a throwaway HOME holding the credentials the CLI expects. Go's
 * os.UserConfigDir resolves to $HOME/.config on Linux, which is where the CLI
 * reads and rewrites credentials.json.
 */
async function writeCredentials(workDir, credentials, workspaceId) {
  const home = path.join(workDir, "home");
  const configDir = path.join(home, ".config", "higgsfield");
  await fs.mkdir(configDir, { recursive: true });
  const file = path.join(configDir, "credentials.json");
  await fs.writeFile(file, credentials, "utf8");

  // The workspace selection lives in a separate config file, not in the
  // credentials, and the release build ignores HIGGSFIELD_WORKSPACE_ID — every
  // command fails with "No workspace selected" until this exists.
  if (workspaceId) {
    await fs.writeFile(
      path.join(configDir, "config.json"),
      JSON.stringify({ workspace_id: workspaceId }),
      "utf8",
    );
  }
  return { home, file };
}

/** Returns the credentials only if the CLI rotated them, so the caller knows
 *  whether anything needs persisting. */
async function readRotatedCredentials(file, original) {
  try {
    const current = await fs.readFile(file, "utf8");
    return current.trim() === original.trim() ? null : current;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function runCli(args, { home, credentialsFile, workspaceId }) {
  return new Promise((resolve, reject) => {
    execFile(
      "higgsfield",
      [...args, "--json", "--no-color"],
      {
        timeout: COMMAND_TIMEOUT_MS,
        maxBuffer: 32 * 1024 * 1024,
        env: {
          ...process.env,
          HOME: home,
          XDG_CONFIG_HOME: path.join(home, ".config"),
          // Belt and braces: the release build may ignore this, in which case
          // the HOME above is what the CLI actually follows.
          HIGGSFIELD_CREDENTIALS_PATH: credentialsFile,
          ...(workspaceId ? { HIGGSFIELD_WORKSPACE_ID: workspaceId } : {}),
          HIGGSFIELD_DISABLE_TELEMETRY: "1",
          HIGGSFIELD_NO_UPDATE_CHECK: "1",
        },
      },
      (error, stdout, stderr) => {
        if (error) {
          const raw = `${stdout || ""}${stderr || ""}`.trim();
          const output = redact(raw || error.message);
          // Full text stays in the platform log, where it is not user-visible.
          console.error("[higgsfield-cli] failed:", args[0], raw.slice(0, 4000));
          reject(
            new WorkerError(
              output,
              // The CLI says "Session expired" when the refresh token is dead;
              // that needs a human, not a retry.
              /session expired|not authenticated|auth login|unauthorized|invalid[_ ]grant/i.test(
                output,
              )
                ? 401
                : 502,
              { args: args[0] },
            ),
          );
          return;
        }
        resolve(stdout);
      },
    );
  });
}

/** The CLI prints JSON on stdout, sometimes preceded by human lines. */
function parseCliJson(stdout) {
  const text = (stdout || "").trim();
  if (!text) return null;
  const start = text.search(/[[{]/);
  if (start === -1) return { raw: text };
  try {
    return JSON.parse(text.slice(start));
  } catch {
    return { raw: text };
  }
}

// ---------------------------------------------------------------------------
// Reference images
// ---------------------------------------------------------------------------

/**
 * The CLI takes a local path or a UUID, not a URL, so references are fetched
 * here. Doing it server-side also sidesteps Vercel's 4.5MB request body limit —
 * Convex sends CDN links, not bytes.
 */
async function downloadReferences(workDir, urls) {
  const paths = [];
  for (const [index, url] of urls.entries()) {
    if (ALLOWED_MEDIA_HOST && new URL(url).host !== ALLOWED_MEDIA_HOST) {
      throw new WorkerError(`Reference ${index + 1} is not on the allowed media host`, 400);
    }
    const response = await fetch(url, {
      signal: AbortSignal.timeout(REFERENCE_FETCH_TIMEOUT_MS),
    });
    if (!response.ok) {
      throw new WorkerError(
        `Failed to fetch reference ${index + 1} (HTTP ${response.status})`,
        400,
      );
    }
    const declared = Number(response.headers.get("content-length") || 0);
    if (declared > MAX_REFERENCE_BYTES) {
      throw new WorkerError(`Reference ${index + 1} is larger than 32MB`, 413);
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.byteLength > MAX_REFERENCE_BYTES) {
      throw new WorkerError(`Reference ${index + 1} is larger than 32MB`, 413);
    }
    const extension = extensionFor(response.headers.get("content-type"), url);
    const file = path.join(workDir, `ref-${index}.${extension}`);
    await fs.writeFile(file, bytes);
    paths.push(file);
  }
  return paths;
}

function extensionFor(contentType, url) {
  const normalized = (contentType || "").split(";")[0].trim().toLowerCase();
  switch (normalized) {
    case "image/png":
      return "png";
    case "image/webp":
      return "webp";
    case "video/mp4":
      return "mp4";
    case "image/jpeg":
      return "jpg";
    default: {
      // The CLI detects media type from the extension, so a wrong guess is a
      // hard failure. Fall back to whatever the URL claims.
      const fromUrl = (url.split("?")[0].match(/\.([a-z0-9]{2,4})$/i) || [])[1];
      return (fromUrl || "jpg").toLowerCase();
    }
  }
}

// ---------------------------------------------------------------------------
// Request handling
// ---------------------------------------------------------------------------

/** Turns {prompt: "x", duration: 10} into --prompt x --duration 10. */
function paramFlags(params = {}) {
  const flags = [];
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === "") continue;
    if (!ALLOWED_PARAMS.has(key)) {
      throw new WorkerError(`Unsupported parameter: ${key}`, 400);
    }
    flags.push(`--${key}`, String(value));
  }
  return flags;
}

/**
 * Pairs each reference with the flag it belongs under.
 *
 * A single flag means a list — `--image-references a --image-references b`,
 * which is what Seedance wants. Several flags mean discrete slots, one media
 * input each: `--start-image a --end-image b`. Repeating a slot flag is a
 * vendor rejection ("start_image accepts only one media input"), so anything
 * beyond the declared slots is dropped rather than sent.
 */
function mediaArgs(flags, paths) {
  if (flags.length === 1) {
    return paths.flatMap((file) => [`--${flags[0]}`, file]);
  }
  return paths.slice(0, flags.length).flatMap((file, index) => [`--${flags[index]}`, file]);
}

async function withSession(body, run) {
  if (typeof body.credentials !== "string" || !body.credentials.trim()) {
    throw new WorkerError("credentials are required", 400);
  }
  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), "hf-"));
  try {
    const { home, file } = await writeCredentials(workDir, body.credentials, body.workspaceId);
    const session = { home, credentialsFile: file, workspaceId: body.workspaceId, workDir };
    const result = await run(session);
    return { ...result, credentials: await readRotatedCredentials(file, body.credentials) };
  } finally {
    await fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}

const ROUTES = {
  /** Submits a job and returns immediately — polling is the caller's job, which
   *  keeps every invocation well inside the function duration limit. */
  "/generate": (body) =>
    withSession(body, async (session) => {
      if (!body.model) throw new WorkerError("model is required", 400);
      const references = body.referenceUrls?.length
        ? await downloadReferences(session.workDir, body.referenceUrls)
        : [];

      const args = ["generate", "create", body.model, ...paramFlags(body.params)];
      if (references.length > 0) {
        const flags =
          Array.isArray(body.mediaFlags) && body.mediaFlags.length > 0
            ? body.mediaFlags
            : ["image-references"];
        args.push(...mediaArgs(flags, references));
      }
      return { job: parseCliJson(await runCli(args, session)) };
    }),

  "/status": (body) =>
    withSession(body, async (session) => {
      if (!body.jobId) throw new WorkerError("jobId is required", 400);
      return { job: parseCliJson(await runCli(["generate", "get", body.jobId], session)) };
    }),

  /** Credits for a configuration, without creating anything. */
  "/cost": (body) =>
    withSession(body, async (session) => {
      if (!body.model) throw new WorkerError("model is required", 400);
      const args = ["generate", "cost", body.model, ...paramFlags(body.params)];
      return { cost: parseCliJson(await runCli(args, session)) };
    }),

  "/balance": (body) =>
    withSession(body, async (session) => ({
      account: parseCliJson(await runCli(["account", "status"], session)),
    })),

  /** Parameter schema for a model, so the registry can be checked against the
   *  vendor rather than trusted. */
  "/model": (body) =>
    withSession(body, async (session) => {
      if (!body.model) throw new WorkerError("model is required", 400);
      return { model: parseCliJson(await runCli(["model", "get", body.model], session)) };
    }),
};

/** Constant-time compare, so the secret cannot be recovered by timing. */
function secretMatches(provided) {
  if (typeof provided !== "string") return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(SHARED_SECRET);
  return a.length === b.length && timingSafeEqual(a, b);
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 1024 * 1024) throw new WorkerError("request body too large", 413);
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new WorkerError("invalid JSON body", 400);
  }
}

const server = http.createServer((req, res) => {
  const send = (status, payload) => {
    const body = JSON.stringify(payload);
    res.writeHead(status, {
      "content-type": "application/json",
      "content-length": Buffer.byteLength(body),
    });
    res.end(body);
  };

  void (async () => {
    try {
      const url = new URL(req.url, "http://localhost");

      if (url.pathname === "/health") {
        send(200, { ok: true });
        return;
      }

      // Anyone who can reach this endpoint can spend Higgsfield credits.
      if (!SHARED_SECRET) throw new WorkerError("WORKER_SECRET is not configured", 500);
      if (!secretMatches(req.headers["x-worker-secret"])) {
        throw new WorkerError("unauthorized", 401);
      }

      const route = ROUTES[url.pathname];
      if (!route) throw new WorkerError("not found", 404);
      if (req.method !== "POST") throw new WorkerError("method not allowed", 405);

      send(200, await route(await readBody(req)));
    } catch (error) {
      const status = error instanceof WorkerError ? error.status : 500;
      send(status, {
        error: error.message || "worker failure",
        detail: error instanceof WorkerError ? error.detail : undefined,
      });
    }
  })();
});

server.listen(PORT, () => {
  console.log(`higgsfield worker listening on ${PORT}`);
});
