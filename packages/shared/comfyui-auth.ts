/** Server-to-server headers accepted by both the legacy pod and Cloudflare Access. */
export type ComfyAuthConfig = {
  apiKey?: string;
  bearerToken?: string;
  cloudflareClientId?: string;
  cloudflareClientSecret?: string;
};

export function comfyAuthHeaders(config: ComfyAuthConfig): Record<string, string> {
  const headers: Record<string, string> = {};
  if (config.apiKey) headers["X-API-Key"] = config.apiKey;
  if (config.bearerToken) headers.Authorization = `Bearer ${config.bearerToken}`;
  // Access service-token auth is all-or-nothing. Sending one half produces a
  // confusing Cloudflare login response, so an incomplete pair is omitted.
  if (config.cloudflareClientId && config.cloudflareClientSecret) {
    headers["CF-Access-Client-Id"] = config.cloudflareClientId;
    headers["CF-Access-Client-Secret"] = config.cloudflareClientSecret;
  }
  return headers;
}

function sameOrigin(left: string | undefined, right: string): boolean {
  if (!left) return false;
  try {
    return new URL(left).origin === new URL(right).origin;
  } catch {
    return false;
  }
}

/**
 * Cloudflare Access credentials belong only to the stable Vast hostname. They
 * must never be sprayed at a legacy RunPod URL when the active backend changes.
 */
export function comfyAuthHeadersForUrl(
  env: Record<string, string | undefined>,
  url: string,
  includeBearer = true,
): Record<string, string> {
  const isVast = sameOrigin(env.VAST_BACKEND_PUBLIC_URL, url);
  const isConfiguredLegacy = [
    env.RUNPOD_URL,
    env.COMFYUI_API_URL,
    env.NEXT_PUBLIC_COMFYUI_URL,
  ].some((candidate) => sameOrigin(candidate, url));
  const headers = comfyAuthHeaders({
    apiKey: isConfiguredLegacy ? env.COMFYUI_API_KEY : undefined,
    bearerToken: includeBearer && isConfiguredLegacy ? env.HF_TOKEN : undefined,
  });
  if (isVast) {
    Object.assign(
      headers,
      comfyAuthHeaders({
        cloudflareClientId: env.CF_ACCESS_CLIENT_ID,
        cloudflareClientSecret: env.CF_ACCESS_CLIENT_SECRET,
      }),
    );
  }
  return headers;
}
