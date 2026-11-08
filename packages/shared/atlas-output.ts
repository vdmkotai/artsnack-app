/** File extension derived from the response MIME type, never from its URL. */
export function extensionForContentType(contentType: string): string {
  const normalized = contentType.split(";")[0].trim().toLowerCase();
  switch (normalized) {
    case "image/jpeg":
    case "image/jpg":
      return "jpg";
    case "image/png":
      return "png";
    case "image/webp":
      return "webp";
    case "video/mp4":
      return "mp4";
    case "video/quicktime":
      return "mov";
    case "video/webm":
      return "webm";
    default:
      return normalized.startsWith("video/") ? "mp4" : "jpg";
  }
}

/**
 * Stable storage identity for one Atlas prediction output. A retry overwrites
 * the same B2 object instead of leaking another 100MB copy.
 */
export function atlasOutputObjectKey(
  prefix: string,
  requestId: string,
  outputIndex: number,
  contentType: string,
): string {
  const safeRequestId = requestId.replace(/[^a-zA-Z0-9_-]/g, "_");
  return `${prefix}/${safeRequestId}_${outputIndex}.${extensionForContentType(contentType)}`;
}
