import { httpRouter } from "convex/server";
import { internal } from "./_generated/api";
import { httpAction } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { podManifestLine } from "../../shared/pod-model-downloads";
import {
  isVastProgressStage,
  VAST_PROGRESS_PATH,
  VAST_PROGRESS_TOKEN_HEADER,
} from "../../shared/vast-backend";
import { loadProvisionScript } from "./provisionScript";

/**
 * `GET /pod-manifest` — the dynamic model manifest, served to a booting pod.
 *
 * infra/provision.sh curls this (on the deployment's .convex.site host, derived
 * from CONVEX_DEPLOY_KEY the same way register_app_url derives .convex.cloud)
 * and appends the body to its static MANIFEST, one `dir|url|filename` line per
 * enabled podModels row. Plain text because the consumer is a bash `while read`
 * loop that already parses exactly this format.
 *
 * Gated on POD_URL_SECRET — the secret the pod template and both Convex
 * deployments already share for config.comfyuiUrl. Fails closed: an unset
 * secret or a wrong header is a 404, not an empty 200, so a misconfigured pod
 * logs a failed fetch instead of silently provisioning without the dynamic
 * entries and looking healthy.
 */
const http = httpRouter();

/** Constant-time-ish compare, mirroring the pod node's hmac.compare_digest —
 *  this route is just as public as the pod's. Length still leaks; acceptable
 *  for a high-entropy shared secret. */
function secretMatches(supplied: string, expected: string): boolean {
  if (supplied.length !== expected.length) return false;
  let diff = 0;
  for (let index = 0; index < expected.length; index++) {
    diff |= supplied.charCodeAt(index) ^ expected.charCodeAt(index);
  }
  return diff === 0;
}

http.route({
  path: "/pod-manifest",
  method: "GET",
  handler: httpAction(async (ctx, request) => {
    const expected = process.env.POD_URL_SECRET;
    const supplied = request.headers.get("x-artsnack-pod-secret") ?? "";
    if (!expected || !secretMatches(supplied, expected)) {
      return new Response("Not found", { status: 404 });
    }

    // provision.sh sends ?profile=video from a video pod; a pod booted from an
    // older script sends nothing and gets the image manifest it always got.
    const profile =
      new URL(request.url).searchParams.get("profile") === "video" ? "video" : "image";
    const rows = await ctx.runQuery(internal.podModels.manifestRows, { profile });
    const body = rows.map((row) => podManifestLine(row.dir, row.url, row.filename)).join("\n");
    return new Response(body, {
      status: 200,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  }),
});

/**
 * Provisioning progress from a booting GPU. The backend id is minted by Convex
 * before Vast receives the launch request. Each paid instance gets its own
 * random progress token; Convex stores only the hash, bound to this backend id.
 */
http.route({
  path: VAST_PROGRESS_PATH,
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const supplied = request.headers.get(VAST_PROGRESS_TOKEN_HEADER) ?? "";
    if (!/^[a-f0-9]{64}$/i.test(supplied)) {
      return new Response("Not found", { status: 404 });
    }

    let body: Record<string, unknown>;
    try {
      if (request.headers.get("content-type")?.includes("application/json")) {
        body = (await request.json()) as Record<string, unknown>;
      } else {
        const form = new URLSearchParams(await request.text());
        body = {
          backendId: form.get("backendId"),
          provider: form.get("provider"),
          stage: form.get("stage"),
          progress: form.get("progress"),
          message: form.get("message"),
        };
      }
    } catch {
      return new Response("Invalid JSON", { status: 400 });
    }
    const backendId = typeof body.backendId === "string" ? body.backendId : "";
    // Provision scripts deployed before dual-provider support sent no provider;
    // defaulting those callbacks to Vast keeps the currently paid instance safe.
    const provider = typeof body.provider === "string" ? body.provider : "vast";
    const stage = typeof body.stage === "string" ? body.stage : "";
    const message = typeof body.message === "string" ? body.message : "Provisioning…";
    const progress = Number(body.progress);
    if (!backendId || !Number.isFinite(progress) || !isVastProgressStage(stage)) {
      return new Response("Missing backendId, valid stage, or progress", { status: 400 });
    }

    try {
      const progressTokenHash = Array.from(
        new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(supplied))),
      )
        .map((byte) => byte.toString(16).padStart(2, "0"))
        .join("");
      if (provider === "runpod-managed") {
        await ctx.runMutation(internal.runpodBackendStore.reportProgress, {
          id: backendId as Id<"runpodBackends">,
          stage,
          message: message.slice(0, 500),
          progress,
          progressTokenHash,
        });
      } else if (provider === "vast") {
        await ctx.runMutation(internal.vastBackendStore.reportProgress, {
          id: backendId as Id<"vastBackends">,
          stage,
          message: message.slice(0, 500),
          progress,
          progressTokenHash,
        });
      } else {
        return new Response("Unknown provider", { status: 400 });
      }
    } catch {
      return new Response("Unknown backend", { status: 404 });
    }
    return new Response(null, { status: 204 });
  }),
});

/**
 * `GET /provision-script` — the published provisioning script, proxied and
 * cached.
 *
 * The RunPod template boots by curling provision.sh straight from
 * PROVISION_SCRIPT_URL, and a host like GitHub rate-limits anonymous fetches
 * per source IP — an IP the pod shares with every other tenant in its
 * datacenter. When the shared IP is throttled (429), the curl fails and the pod
 * comes up bare, with no models, no downloader node, and no log saying why.
 * This route is the template's fallback: same script, fetched from Convex's
 * egress instead of the pod's, with the last good copy cached in the
 * `provisionScript` table so even a throttled-from-Convex fetch serves
 * something. The published script remains the single source of truth — the
 * cache refreshes on every successful fetch and is never written any other way.
 *
 * Same gate and fail-closed behaviour as /pod-manifest above.
 */
http.route({
  path: "/provision-script",
  method: "GET",
  handler: httpAction(async (ctx, request) => {
    const expected = process.env.POD_URL_SECRET;
    const supplied = request.headers.get("x-artsnack-pod-secret") ?? "";
    if (!expected || !secretMatches(supplied, expected)) {
      return new Response("Not found", { status: 404 });
    }

    const script = await loadProvisionScript(ctx);
    if (!script) {
      return new Response("current provisioning script unavailable", { status: 503 });
    }
    return new Response(script.content, {
      status: 200,
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "X-Provision-Source": script.source,
        ...(script.source === "cache"
          ? { "X-Provision-Fetched-At": new Date(script.fetchedAt).toISOString() }
          : {}),
      },
    });
  }),
});

export default http;
