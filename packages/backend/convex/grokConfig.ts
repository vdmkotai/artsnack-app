/**
 * Shared constants for Grok (xAI) subscription auth + Imagine API.
 *
 * Auth is the standard OAuth 2.1 device-authorization grant against
 * https://auth.x.ai using grok-build's PUBLIC client (no secret — same as the
 * grok CLI uses for `grok login --device-auth`). The resulting access token
 * calls https://api.x.ai/v1 directly and meters Imagine usage against the
 * user's SuperGrok subscription (the same thing grok-build does for its
 * /imagine commands).
 *
 * GROK_CLIENT_ID env can override the client id if xAI ever rotates it.
 */

export const GROK_ISSUER = "https://auth.x.ai";
export const GROK_API_BASE_URL = "https://api.x.ai/v1";

/** grok-build's public OAuth2 client id (from its open-source auth config). */
export const GROK_CLIENT_ID = process.env.GROK_CLIENT_ID ?? "b1a00492-073a-47ea-816f-4c329264a828";

/** The exact scope set grok-build requests (frozen OAuth client contract). */
export const GROK_SCOPES = [
  "openid",
  "profile",
  "email",
  "offline_access",
  "grok-cli:access",
  "api:access",
  "conversations:read",
  "conversations:write",
  "workspaces:read",
  "workspaces:write",
].join(" ");

/** Mirrors grok-build's device-code request attribution. */
export const GROK_DEVICE_HEADERS: Record<string, string> = {
  "x-grok-client-version": "1.0.0",
  "x-grok-client-surface": "ui",
};

/** Mirrors the UA grok-build sends on Imagine API calls. */
export const GROK_API_USER_AGENT = "xai-grok-build/1.0.0";

/* The Imagine model slugs, the quality → model mapping (`grokImageRequestFor`)
 * and the request bodies now live in packages/shared/grok-imagine.ts and
 * api-models.ts. The processor, the registry, the rate card and the native
 * clients all have to name the same model, and the old copies here were the one
 * place none of them could reach. Two things worth keeping from the notes that
 * lived here:
 *
 * - 1.5 renders text-, image- and reference-to-video (probed live 2026-08-09,
 *   seven references included); reference-to-video is refused at 1080p.
 * - `grok-imagine-video-1.5-preview` still resolves to 1.5, but an alias is not
 *   a promise — requests name the canonical slug. */

/* Video durations, resolutions and aspect ratios used to be duplicated here and
 * in the model registry. Nothing imported this copy — the registry's was the one
 * doing the work — so the constants now live only in
 * packages/shared/api-models.ts, next to the caps that consume them and within
 * reach of the iOS app. */
