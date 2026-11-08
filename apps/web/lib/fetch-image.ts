/**
 * How long one image download may take, body included. Long enough for a
 * full-size original on a slow link; short enough that a stalled request gives
 * the form back instead of leaving "Restoring…" on the button indefinitely.
 */
const IMAGE_FETCH_TIMEOUT_MS = 60_000;

/**
 * Fetch an image as a Blob, rewriting CDN URLs to the same-origin /api/images
 * proxy so CORS never gets in the way (same trick as the lightbox download).
 *
 * The timeout covers reading the body too: an `AbortSignal` passed to `fetch`
 * keeps governing the response stream after the headers arrive.
 */
export async function imageUrlToBlob(
  url: string,
  { timeoutMs = IMAGE_FETCH_TIMEOUT_MS }: { timeoutMs?: number } = {},
): Promise<Blob> {
  const mediaBase = process.env.NEXT_PUBLIC_MEDIA_URL;
  let fetchUrl = url;
  if (mediaBase && url.startsWith(mediaBase)) {
    fetchUrl = `/api/images/${url.slice(mediaBase.length + 1)}`;
  }
  try {
    const response = await fetch(fetchUrl, { signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) throw new Error(`Failed to fetch image (HTTP ${response.status})`);
    return await response.blob();
  } catch (error) {
    if (error instanceof DOMException && error.name === "TimeoutError") {
      throw new Error(`The image took longer than ${Math.round(timeoutMs / 1000)}s to download`);
    }
    throw error;
  }
}
