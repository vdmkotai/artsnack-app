/**
 * Both bundlers inline only their own prefix — Next replaces `NEXT_PUBLIC_*`,
 * Metro replaces `EXPO_PUBLIC_*` — so reading both is how one module serves two
 * apps. Whichever is not inlined resolves to undefined at runtime and falls
 * through.
 */
const MEDIA_BASE = process.env.NEXT_PUBLIC_MEDIA_URL ?? process.env.EXPO_PUBLIC_MEDIA_URL;

/**
 * Build a CDN URL for an image key, falling back to the proxy API route.
 *
 * The fallback is a same-origin path and therefore only meaningful in the
 * browser. On iOS there is always a base — `lib/convex.ts` refuses to start
 * without one — so the branch is never taken there.
 */
export function mediaUrl(key: string): string {
  return MEDIA_BASE ? `${MEDIA_BASE}/${key}` : `/api/images/${key}`;
}

/**
 * CDN URL for a small, optimized PREVIEW of an image, via Cloudflare
 * Transformations (cdn-cgi/image). Serves a ~width-px WebP/AVIF instead of the
 * full-size PNG — much faster for grid thumbnails. Use mediaUrl() for full view.
 *
 * A fixed width keeps it to ONE unique transformation per image (shared across
 * every device/resolution), so it stays well within Cloudflare's free tier and
 * the same image is never billed twice in a month. Falls back to the original
 * when no CDN base is configured (e.g. local dev), so the grid still works.
 *
 * The fixed width has a second effect that matters on iOS: the URL is stable, so
 * it doubles as the disk-cache key. Making the width dynamic would orphan every
 * cached thumbnail on the device.
 */
export function thumbUrl(key: string, width = 512): string {
  if (!MEDIA_BASE) return mediaUrl(key);
  return `${MEDIA_BASE}/cdn-cgi/image/format=auto,quality=72,width=${width},fit=scale-down/${key}`;
}

/** Build a CDN URL for a video key, falling back to the proxy API route. */
export function videoUrl(key: string): string {
  return MEDIA_BASE ? `${MEDIA_BASE}/${key}` : `/api/videos/${key}`;
}

/**
 * A still frame from a video, so a grid can show a poster without downloading
 * the clip. Cloudflare Media Transformations, the same mechanism as `thumbUrl`
 * and billed the same way — 5,000 free operations a month, and one per unique
 * URL, which the fixed width and timestamp guarantee.
 *
 * Only `grokGenerations` needs this: the self-hosted video pipeline wrote its own
 * `thumbnailKey`, and hosted-API videos have no poster at all. Without it a feed
 * of video tiles pulls video bytes to show anything, and cannot lay out until the
 * metadata arrives.
 *
 * Requires the zone to have transformations enabled and the origin to answer
 * HEAD and range requests; B2 does. Source clips must be under 100 MB.
 */
export function videoPosterUrl(key: string, width = 512): string {
  if (!MEDIA_BASE) return videoUrl(key);
  return `${MEDIA_BASE}/cdn-cgi/media/mode=frame,time=1s,format=jpg,width=${width},fit=scale-down/${key}`;
}

/**
 * `videoPosterUrl` where the CDN can cut a frame, otherwise nothing: without a
 * media base it falls back to the clip itself, and a "poster" that is the whole
 * video would download it to show one frame.
 */
export function videoPosterIfAvailable(key: string, width = 512): string | undefined {
  return MEDIA_BASE ? videoPosterUrl(key, width) : undefined;
}
