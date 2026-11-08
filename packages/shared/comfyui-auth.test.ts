import assert from "node:assert/strict";
import test from "node:test";
import { comfyAuthHeaders, comfyAuthHeadersForUrl } from "./comfyui-auth";

test("adds Cloudflare service-token headers only as a complete pair", () => {
  assert.deepEqual(
    comfyAuthHeaders({ cloudflareClientId: "id", cloudflareClientSecret: "secret" }),
    { "CF-Access-Client-Id": "id", "CF-Access-Client-Secret": "secret" },
  );
  assert.deepEqual(comfyAuthHeaders({ cloudflareClientId: "id" }), {});
});

test("Cloudflare credentials are scoped to the configured Vast origin", () => {
  const env = {
    VAST_BACKEND_PUBLIC_URL: "https://comfy.example.com",
    CF_ACCESS_CLIENT_ID: "id",
    CF_ACCESS_CLIENT_SECRET: "secret",
    COMFYUI_API_KEY: "legacy-comfy-key",
    HF_TOKEN: "legacy-bearer",
    RUNPOD_URL: "https://legacy.proxy.runpod.net",
  };
  assert.equal(
    comfyAuthHeadersForUrl(env, "https://legacy.proxy.runpod.net")["CF-Access-Client-Id"],
    undefined,
  );
  assert.equal(
    comfyAuthHeadersForUrl(env, "https://comfy.example.com/prompt")["CF-Access-Client-Id"],
    "id",
  );
  assert.equal(
    comfyAuthHeadersForUrl(env, "https://comfy.example.com/prompt").Authorization,
    undefined,
  );
  assert.equal(
    comfyAuthHeadersForUrl(env, "https://comfy.example.com/prompt")["X-API-Key"],
    undefined,
  );
  assert.equal(
    comfyAuthHeadersForUrl(env, "https://fresh-managed.proxy.runpod.net").Authorization,
    undefined,
  );
  assert.equal(
    comfyAuthHeadersForUrl(env, "https://legacy.proxy.runpod.net").Authorization,
    "Bearer legacy-bearer",
  );
});

test("preserves the existing ComfyUI and Hugging Face credentials", () => {
  assert.deepEqual(
    comfyAuthHeaders({
      apiKey: "comfy",
      bearerToken: "hf",
      cloudflareClientId: "id",
      cloudflareClientSecret: "secret",
    }),
    {
      "X-API-Key": "comfy",
      Authorization: "Bearer hf",
      "CF-Access-Client-Id": "id",
      "CF-Access-Client-Secret": "secret",
    },
  );
});
