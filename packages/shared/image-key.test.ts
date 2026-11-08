import assert from "node:assert/strict";
import test from "node:test";

import {
  OUTPUT_PREFIXES,
  REFERENCE_PREFIX,
  isAllowedImageKey,
  isAllowedVideoKey,
  safeMediaContentType,
} from "./image-key";

test("allows image object prefixes served by the image proxy", () => {
  assert.equal(isAllowedImageKey("generations/example.png"), true);
  assert.equal(isAllowedImageKey("video-posters/example.jpg"), true);
  assert.equal(isAllowedImageKey("video-sources/example.jpg"), true);
  assert.equal(isAllowedImageKey("grok/example.jpg"), true);
  assert.equal(isAllowedImageKey("grok-references/example.jpg"), true);
});

/**
 * The proxy is how the browser reads media without CORS, so a provider missing
 * from the allowlist doesn't degrade — "use as reference", "send to the API tab"
 * and the lightbox download all fail with a 400 while the picture still shows
 * from the CDN. Higgsfield shipped that way and only surfaced once favourites
 * started holding API results.
 */
test("every provider that uploads media can be read back through the proxy", () => {
  for (const prefix of Object.values(OUTPUT_PREFIXES)) {
    assert.equal(isAllowedImageKey(`${prefix}/example.png`), true, `${prefix} images`);
    assert.equal(isAllowedVideoKey(`${prefix}/example.mp4`), true, `${prefix} clips`);
  }
  assert.equal(isAllowedImageKey(`${REFERENCE_PREFIX}/abc.jpg`), true);
});

test("rejects unrelated object keys", () => {
  assert.equal(isAllowedImageKey("private/example.jpg"), false);
  assert.equal(isAllowedImageKey("grok-example.jpg"), false);
});

test("serves clips from every pipeline that writes them", () => {
  assert.equal(isAllowedVideoKey("videos/generated/example.mp4"), true);
  // The self-hosted pipelines write bare videos/ keys, not videos/generated/.
  assert.equal(isAllowedVideoKey("videos/1700000000000_ab12cd_0.mp4"), true);
  // Grok clips land under grok/ and were previously unreachable via the proxy.
  assert.equal(isAllowedVideoKey("grok/example.mp4"), true);
  assert.equal(isAllowedVideoKey("fal/example.mp4"), true);
  assert.equal(isAllowedVideoKey("private/example.mp4"), false);
});

test("only echoes back media content types the proxy is willing to serve", () => {
  assert.equal(safeMediaContentType("image/png"), "image/png");
  assert.equal(safeMediaContentType("image/jpeg; charset=utf-8"), "image/jpeg");
  assert.equal(safeMediaContentType("VIDEO/MP4"), "video/mp4");
  // Both of these execute script on the app's own origin if echoed verbatim.
  assert.equal(safeMediaContentType("text/html"), "application/octet-stream");
  assert.equal(safeMediaContentType("image/svg+xml"), "application/octet-stream");
  assert.equal(safeMediaContentType(undefined), "application/octet-stream");
});
