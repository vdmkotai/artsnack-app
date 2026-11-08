"use node";

import type { ActionCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import { fetchWithTimeout, withTransientRetry } from "./mediaPipeline";
import { GROK_API_USER_AGENT, GROK_CLIENT_ID, GROK_ISSUER } from "./grokConfig";

/**
 * The subscription access token, shared by everything that calls api.x.ai on
 * the user's behalf: image and video generation in grokProcessor, and prompt
 * enhancement in promptEnhance. Lived inside grokProcessor until the second
 * caller appeared.
 */

/** Refresh the access token when it expires within this window. */
const TOKEN_REFRESH_SKEW_MS = 60_000;

export const RECONNECT_ERROR =
  "Grok connection expired. Please reconnect your Grok account in the Grok tab.";

// ---------------------------------------------------------------------------
// Token handling
// ---------------------------------------------------------------------------

/** Returns a valid access token for the given user, refreshing if needed.
 * Takes userId explicitly: scheduled actions run without an auth context. */
export async function getValidAccessToken(ctx: ActionCtx, userId: string): Promise<string> {
  const row = await ctx.runQuery(internal.grokAuth.getTokenRow, { userId });
  if (!row) throw new Error(RECONNECT_ERROR);

  if (row.expiresAt - TOKEN_REFRESH_SKEW_MS > Date.now()) {
    return row.accessToken;
  }

  const resp = await withTransientRetry(() =>
    fetchWithTimeout(
      `${GROK_ISSUER}/oauth2/token`,
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: row.refreshToken,
          client_id: GROK_CLIENT_ID,
        }),
      },
      30_000,
    ),
  );

  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    // Terminal failures (refresh token rejected / client rejected) mean the
    // user must reconnect — drop the dead credentials.
    if (body.includes("invalid_grant") || body.includes("invalid_client")) {
      await ctx.runMutation(internal.grokAuth.clearTokens, { userId });
      throw new Error(RECONNECT_ERROR);
    }
    throw new Error(`Failed to refresh Grok token (HTTP ${resp.status})`);
  }

  const tokens = (await resp.json()) as {
    access_token: string;
    refresh_token?: string;
    expires_in?: number;
  };

  await ctx.runMutation(internal.grokAuth.storeTokens, {
    userId,
    accessToken: tokens.access_token,
    // Refresh tokens rotate — always persist the new one when returned.
    refreshToken: tokens.refresh_token ?? row.refreshToken,
    expiresAt: Date.now() + (tokens.expires_in ?? 3600) * 1000,
  });

  return tokens.access_token;
}

export function grokApiHeaders(accessToken: string): Record<string, string> {
  return {
    Authorization: `Bearer ${accessToken}`,
    "Content-Type": "application/json",
    "user-agent": GROK_API_USER_AGENT,
  };
}
