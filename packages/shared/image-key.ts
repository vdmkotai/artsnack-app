/**
 * Which B2 keys the same-origin media proxy will serve.
 *
 * The proxy is not decoration: it is how the browser reads media without CORS,
 * which is what "use as reference", "send to the API tab" and the lightbox
 * download all rely on. A prefix missing from these lists doesn't degrade — the
 * route answers 400 and the feature fails outright, while the picture still
 * displays fine from the CDN, so the gap hides until someone clicks.
 *
 * The provider prefixes are exported for the uploaders to use, so a new
 * provider cannot be given a folder the proxy has never heard of.
 */

/** Prefix each provider's finished media is uploaded under. */
export const OUTPUT_PREFIXES = {
  grok: "grok",
  fal: "fal",
  higgsfield: "higgsfield",
  atlas: "atlas",
} as const;

/** Reference attachments, shared across providers and deduplicated by hash. */
export const REFERENCE_PREFIX = "grok-references";

/**
 * Clips uploaded as the source of a Grok edit or extension, deduplicated by
 * content hash like the reference images. A video-only prefix: nothing under
 * it is a picture, so the image proxy keeps refusing it.
 */
export const GROK_SOURCE_VIDEO_PREFIX = "grok-video-sources";

const PROVIDER_PREFIXES = Object.values(OUTPUT_PREFIXES).map((prefix) => `${prefix}/`);

const IMAGE_KEY_PREFIXES = [
  "generations/",
  `${REFERENCE_PREFIX}/`,
  "video-posters/",
  "video-sources/",
  ...PROVIDER_PREFIXES,
];

export function isAllowedImageKey(key: string): boolean {
  return IMAGE_KEY_PREFIXES.some((prefix) => key.startsWith(prefix));
}

/** Hosted-API clips sit alongside that provider's images — the extension, not
 *  the folder, tells them apart, so the prefixes overlap with the image list.
 *  The bare `videos/` entry is not redundant with `videos/generated/`: the
 *  self-hosted pipelines (lib/backends/comfyui.ts, lib/backends/runpod.ts and
 *  convex/generationProcessor.ts) write clips straight under `videos/`, and the
 *  allowlist is checked at read time so widening it here also rescues rows that
 *  were already stored that way. */
const VIDEO_KEY_PREFIXES = ["videos/", `${GROK_SOURCE_VIDEO_PREFIX}/`, ...PROVIDER_PREFIXES];

export function isAllowedVideoKey(key: string): boolean {
  return VIDEO_KEY_PREFIXES.some((prefix) => key.startsWith(prefix));
}

/**
 * A key a Grok edit or extension may name as its source clip.
 *
 * The key reaches a Convex mutation from the client and is turned into a URL
 * xAI fetches, so it is held to more than the read allowlist: an mp4 (xAI
 * requires the extension), on a video prefix, in a plain character set with no
 * `..` segment, no leading slash and nothing that could start a query or
 * fragment. Everything it can name is already public on the media CDN, so the
 * check is about not handing xAI a malformed or surprising URL, not secrecy.
 */
export function isGrokSourceVideoKey(key: string): boolean {
  return (
    key.length <= 512 &&
    /^[A-Za-z0-9][A-Za-z0-9._/-]*\.mp4$/i.test(key) &&
    !key.split("/").some((segment) => segment === ".." || segment === "." || segment === "") &&
    isAllowedVideoKey(key)
  );
}

/**
 * Content types the media proxy is willing to echo back.
 *
 * The stored type is attacker-influenced: convex/mediaPipeline.ts takes it from
 * a client-uploaded blob and writes it to B2 verbatim, and both media routes are
 * public. Anything outside this list is served as application/octet-stream so a
 * `text/html` (or `image/svg+xml`, which executes script even when the type is
 * honest) object cannot run on the app's own origin.
 */
const SERVABLE_CONTENT_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/jpg",
  "image/webp",
  "image/gif",
  "image/avif",
  "video/mp4",
  "video/webm",
  "video/quicktime",
]);

export function safeMediaContentType(contentType: string | undefined): string {
  const normalized = (contentType ?? "").split(";")[0].trim().toLowerCase();
  return SERVABLE_CONTENT_TYPES.has(normalized) ? normalized : "application/octet-stream";
}

/**
 * Does this failure from `getImage()` mean the object genuinely is not there?
 *
 * Both media routes answer 404 for anything that throws, but only a real absence
 * is safe to let a cache keep: a missing B2 env var, a connection reset or a B2
 * 5xx is transient, and pinning "not found" for those would hide media that is
 * fine the moment B2 answers again.
 */
export function isMissingObjectError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const { name, $metadata } = error as { name?: string; $metadata?: { httpStatusCode?: number } };
  return $metadata?.httpStatusCode === 404 || name === "NoSuchKey" || name === "NotFound";
}
