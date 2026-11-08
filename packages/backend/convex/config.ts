import { v } from "convex/values";
import { action } from "./_generated/server";
import { resolveComfyuiTarget } from "./comfyuiTarget";

/**
 * Current ComfyUI base URL, read at RUNTIME from the Convex environment variable
 * that the RunPod pod sets on deploy. Exposing it through Convex lets the Next.js
 * app pick up a freshly-deployed pod WITHOUT a Vercel rebuild — the pod just sets
 * the Convex env var and this returns the new value immediately.
 *
 * It's an `action` (not a `query`) on purpose: actions read process.env fresh on
 * every call, so there's no chance of a cached/stale value after the pod updates
 * the env. Returns "" if unset (callers fall back to their own build-time env).
 *
 * Gated on a shared secret rather than on `getUserIdentity()`, because the only
 * caller — lib/comfyui-url.ts — is a server-to-server call from Next route
 * handlers over a `ConvexHttpClient` that never sets an auth token. An identity
 * check would throw on every call, the caller's catch would swallow it, and
 * every catalog route would silently fall back to the stale build-time pod URL.
 * A wrong secret returns "" for the same reason: the caller already treats an
 * empty string as "not configured", so a misconfiguration degrades exactly like
 * an unset variable instead of surfacing as an unhandled action error.
 *
 * POD_URL_SECRET must be set in Vercel and in *both* Convex deployments.
 */
export const comfyuiUrl = action({
  // The secret is optional purely so the two deploy targets can ship in either
  // order. Pushing to main deploys the frontend only, and `bunx convex deploy`
  // is a separate step; a required argument would make a caller that predates
  // the Convex deploy fail argument validation outright. Optional, it degrades
  // the same way a wrong secret does — an empty string the caller already
  // treats as "not configured" — instead of throwing.
  args: { secret: v.optional(v.string()) },
  handler: async (ctx, args): Promise<string> => {
    const expected = process.env.POD_URL_SECRET;
    if (!expected || args.secret !== expected) return "";
    try {
      return (await resolveComfyuiTarget(ctx)).url;
    } catch {
      return process.env.NEXT_PUBLIC_COMFYUI_URL || process.env.COMFYUI_API_URL || "";
    }
  },
});
