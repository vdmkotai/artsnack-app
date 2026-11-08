import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api";
import { internalMutation, internalQuery, type ActionCtx } from "./_generated/server";
import { VAST_PROVISION_VERSION } from "../../shared/vast-backend";

/**
 * Cache plumbing for the `/provision-script` HTTP route — see the
 * `provisionScript` table in schema.ts for why this exists. One row, written
 * only after a successful fetch of the published script, read only when that
 * fetch fails (e.g. GitHub throttles it). The launch dialog's model list
 * (podLaunchModels.list) reads the same script the same way, so it offers
 * exactly the lines the next pod will download.
 */

/**
 * Where the published infra/provision.sh lives: any URL that serves the raw
 * file (a gist's raw URL, a release asset, an object in your bucket). Set it as
 * `PROVISION_SCRIPT_URL` on the Convex deployment; the RunPod template should
 * fetch the same URL. There is no default, because every pod boots from it.
 */
function provisionScriptUrl(): string {
  const value = process.env.PROVISION_SCRIPT_URL?.trim();
  if (!value) {
    throw new ConvexError(
      "PROVISION_SCRIPT_URL is not configured on this Convex deployment — set it to the raw URL of your published infra/provision.sh",
    );
  }
  return value;
}

/** A plausible provision.sh, not a CDN error page or a truncated body. */
function looksLikeProvisionScript(body: string): boolean {
  return (
    body.startsWith("#!/usr/bin/env bash") &&
    body.includes(`# ARTSNACK_PROVISION_VERSION=${VAST_PROVISION_VERSION}`) &&
    body.length > 20_000
  );
}

/** The published script as it is now, refreshing the cache; else the last good copy. */
export async function loadProvisionScript(
  ctx: Pick<ActionCtx, "runQuery" | "runMutation">,
): Promise<{ content: string; source: "remote" | "cache"; fetchedAt: number } | null> {
  const url = provisionScriptUrl();
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(20_000) });
    if (response.ok) {
      const content = await response.text();
      if (looksLikeProvisionScript(content)) {
        await ctx.runMutation(internal.provisionScript.store, { content });
        return { content, source: "remote", fetchedAt: Date.now() };
      }
    }
  } catch {
    // Host unreachable or slow — fall through to the cache.
  }
  const cached = await ctx.runQuery(internal.provisionScript.cached, {});
  return cached && looksLikeProvisionScript(cached.content)
    ? { content: cached.content, source: "cache", fetchedAt: cached.fetchedAt }
    : null;
}

export const cached = internalQuery({
  args: {},
  handler: async (ctx) => {
    const current = await ctx.db
      .query("provisionScript")
      .withIndex("by_key", (q) => q.eq("key", "current"))
      .unique();
    // A deployment may hold one row from before the singleton key existed. Keep
    // it readable until the next successful refresh migrates it in `store`.
    return current ?? ctx.db.query("provisionScript").first();
  },
});

export const store = internalMutation({
  args: { content: v.string() },
  handler: async (ctx, args) => {
    const current = await ctx.db
      .query("provisionScript")
      .withIndex("by_key", (q) => q.eq("key", "current"))
      .unique();
    const existing = current ?? (await ctx.db.query("provisionScript").first());
    if (existing) {
      await ctx.db.patch(existing._id, {
        key: "current",
        content: args.content,
        fetchedAt: Date.now(),
      });
      return;
    }
    await ctx.db.insert("provisionScript", {
      key: "current",
      content: args.content,
      fetchedAt: Date.now(),
    });
  },
});
