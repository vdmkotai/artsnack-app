import { toast } from "sonner";

const MEDIA_BASE = process.env.NEXT_PUBLIC_MEDIA_URL;

export type DownloadableMediaType = "image" | "video";

/**
 * Rewrite a CDN URL to the matching same-origin proxy route.
 *
 * The media CDN sends no CORS headers, so anything that needs the *bytes* rather
 * than the pixels — downloading, re-uploading as a reference — has to read them
 * back through /api/images or /api/videos. URLs that are already same-origin
 * (local dev, where mediaUrl() falls back to the proxy) pass through untouched.
 */
export function proxyMediaUrl(url: string, type: DownloadableMediaType): string {
  if (!MEDIA_BASE || !url.startsWith(MEDIA_BASE)) return url;
  const key = url.slice(MEDIA_BASE.length + 1);
  if (type === "video") return `/api/videos/${key}`;
  return `/api/images/${key}`;
}

interface DownloadMediaOptions {
  url: string;
  type: DownloadableMediaType;
  /** Filename stem; a random suffix and the real extension are appended. */
  name: string;
}

/**
 * Save a piece of media to the user's device.
 *
 * Fetching the blob first is not optional: `<a download>` is ignored by the
 * spec for cross-origin hrefs, so pointing a link straight at the CDN navigates
 * to the file instead of saving it — which is exactly how the video download
 * button was broken in production while working in local dev.
 */
export async function downloadMedia({ url, type, name }: DownloadMediaOptions): Promise<void> {
  try {
    const response = await fetch(proxyMediaUrl(url, type));
    if (!response.ok) {
      toast.error(`${type === "video" ? "Video" : "Image"} unavailable for download`);
      return;
    }
    const blob = await response.blob();
    // Build a unique filename so multiple downloads never collide. Derive the
    // extension from the blob's mime type, fall back per media type.
    const defaultExt = type === "video" ? "mp4" : "png";
    const ext = (blob.type?.split("/")[1] || defaultExt).split(";")[0];
    const unique = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const filename = `${name}-${unique}.${ext}`;

    // On touch devices (iOS/Android) use the native share sheet so the media
    // can go straight to the photo library via "Save". The classic
    // <a download> on iOS Safari just opens the file instead of saving it.
    const file = new File([blob], filename, {
      type: blob.type || (type === "video" ? "video/mp4" : "image/png"),
    });
    const isTouch =
      typeof window !== "undefined" && window.matchMedia?.("(pointer: coarse)").matches;
    if (isTouch && navigator.canShare?.({ files: [file] })) {
      try {
        await navigator.share({ files: [file] });
        return;
      } catch (err) {
        // User dismissed the share sheet — don't also trigger a file download.
        if ((err as Error)?.name === "AbortError") return;
        // Other errors: fall through to the download fallback below.
      }
    }

    const blobUrl = window.URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = blobUrl;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    window.URL.revokeObjectURL(blobUrl);
  } catch (error) {
    console.error("Download failed:", error);
    toast.error("Download failed - the file may be unavailable");
  }
}
