/**
 * A clip's length and frame size, read from its metadata without playing it.
 *
 * Grok's Edit takes a source of at most 8.7 s and Extend one of 2–15 s, and
 * both return the source's resolution capped at 720p — so the form needs all
 * three before the click. A `<video>` element reads them from the first few
 * kilobytes, from a CDN URL or an object URL alike, and needs no CORS for it.
 * Browser-only, which is why it lives with the web app.
 */
export function probeVideo(
  src: string,
  timeoutMs = 20_000,
): Promise<{ seconds: number; width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const video = document.createElement("video");
    video.preload = "metadata";
    video.muted = true;
    const release = () => {
      clearTimeout(timer);
      video.onloadedmetadata = null;
      video.onerror = null;
      // Detaching the source is what lets the decoder go.
      video.removeAttribute("src");
      video.load();
    };
    const timer = setTimeout(() => {
      release();
      reject(new Error("Could not read the video's length in time"));
    }, timeoutMs);
    video.onloadedmetadata = () => {
      const seconds = video.duration;
      const width = video.videoWidth;
      const height = video.videoHeight;
      release();
      if (!Number.isFinite(seconds) || seconds <= 0) {
        reject(new Error("The video reports no length"));
        return;
      }
      resolve({ seconds: Math.round(seconds * 100) / 100, width, height });
    };
    video.onerror = () => {
      release();
      reject(new Error("The browser could not read that video"));
    };
    video.src = src;
  });
}
