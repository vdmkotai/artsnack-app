"use node";

import { action } from "./_generated/server";
import { requireAllowedUser } from "./authz";
import { internal } from "./_generated/api";
import { GROK_CLIENT_ID, GROK_DEVICE_HEADERS, GROK_ISSUER, GROK_SCOPES } from "./grokConfig";

const DEVICE_GRANT_TYPE = "urn:ietf:params:oauth:grant-type:device_code";

type DeviceCodeResponse = {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete?: string;
  expires_in: number;
  interval?: number;
};

type TokenResponse = {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  id_token?: string;
};

type TokenError = {
  error: string;
  error_description?: string;
};

/** Extract the email claim from an OIDC id_token (no signature check — the
 * token arrived over TLS straight from the token endpoint). */
function emailFromIdToken(idToken?: string): string | undefined {
  if (!idToken) return undefined;
  const parts = idToken.split(".");
  if (parts.length !== 3) return undefined;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    return typeof payload.email === "string" ? payload.email : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Phase 1 of the RFC 8628 device flow: request a device/user code pair from
 * auth.x.ai, persist the pending session, and return what the UI must show.
 */
export const startDeviceAuth = action({
  args: {},
  handler: async (ctx) => {
    await requireAllowedUser(ctx);

    const resp = await fetch(`${GROK_ISSUER}/oauth2/device/code`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        ...GROK_DEVICE_HEADERS,
      },
      body: new URLSearchParams({
        client_id: GROK_CLIENT_ID,
        scope: GROK_SCOPES,
        referrer: "grok-build",
      }),
    });

    if (!resp.ok) {
      const body = await resp.text();
      throw new Error(`Grok device auth request failed (HTTP ${resp.status}): ${body}`);
    }

    const data = (await resp.json()) as DeviceCodeResponse;

    await ctx.runMutation(internal.grokAuth.createAuthSession, {
      deviceCode: data.device_code,
      userCode: data.user_code,
      expiresAt: Date.now() + data.expires_in * 1000,
    });

    return {
      userCode: data.user_code,
      verificationUri: data.verification_uri,
      verificationUriComplete: data.verification_uri_complete,
      expiresIn: data.expires_in,
      interval: data.interval ?? 5,
    };
  },
});

export type DeviceAuthPollResult =
  | { status: "pending" }
  | { status: "done"; email?: string }
  | { status: "expired" }
  | { status: "denied" };

/**
 * Phase 2: single poll of the token endpoint. The client calls this every few
 * seconds until it returns something other than "pending".
 */
export const pollDeviceAuth = action({
  args: {},
  handler: async (ctx): Promise<DeviceAuthPollResult> => {
    const identity = await requireAllowedUser(ctx);

    const session = await ctx.runQuery(internal.grokAuth.getAuthSession, {});
    if (!session) return { status: "expired" };
    if (session.expiresAt < Date.now()) {
      await ctx.runMutation(internal.grokAuth.deleteAuthSession, {});
      return { status: "expired" };
    }

    const resp = await fetch(`${GROK_ISSUER}/oauth2/token`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        ...GROK_DEVICE_HEADERS,
      },
      body: new URLSearchParams({
        grant_type: DEVICE_GRANT_TYPE,
        device_code: session.deviceCode,
        client_id: GROK_CLIENT_ID,
      }),
    });

    if (resp.ok) {
      const tokens = (await resp.json()) as TokenResponse;
      if (!tokens.refresh_token) {
        // offline_access should always yield one, but fail closed — without a
        // refresh token the connection would die at first expiry.
        throw new Error("Grok auth did not return a refresh token");
      }
      const email = emailFromIdToken(tokens.id_token);
      await ctx.runMutation(internal.grokAuth.storeTokens, {
        userId: identity.subject,
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token,
        expiresAt: Date.now() + (tokens.expires_in ?? 3600) * 1000,
        email,
      });
      await ctx.runMutation(internal.grokAuth.deleteAuthSession, {});
      return { status: "done", email };
    }

    const err = (await resp.json().catch(() => ({ error: "unknown" }))) as TokenError;
    switch (err.error) {
      case "authorization_pending":
      case "slow_down":
        return { status: "pending" };
      case "access_denied":
        await ctx.runMutation(internal.grokAuth.deleteAuthSession, {});
        return { status: "denied" };
      case "expired_token":
        await ctx.runMutation(internal.grokAuth.deleteAuthSession, {});
        return { status: "expired" };
      default:
        throw new Error(`Grok token exchange failed: ${err.error_description ?? err.error}`);
    }
  },
});
