/**
 * What the reference file dialog and the drop handler will take.
 *
 * `accept="image/*"` is not enough. Chrome and Safari on macOS expand that
 * wildcard to a fixed extension list, and `.avif` is not on it, so the open
 * panel greys the file out. A drop is the other half of the same bug: Finder
 * often hands the file over with an empty type or `application/octet-stream`,
 * and a check for `image/` then skips a picture the browser can decode.
 */

export const REFERENCE_IMAGE_ACCEPT = ".avif,image/avif,.webp,image/webp,.gif,image/gif,image/*";

/**
 * Extensions the open panel and Finder disagree about. A reported `image/*`
 * type needs no help; these cover the empty type and `application/octet-stream`.
 */
const EXTENSION_CONTENT_TYPES: Record<string, string> = {
  avif: "image/avif",
  webp: "image/webp",
  gif: "image/gif",
};

function contentTypeFromName(name: string): string | null {
  const extension = /\.([a-z0-9]+)$/i.exec(name)?.[1]?.toLowerCase();
  return (extension && EXTENSION_CONTENT_TYPES[extension]) || null;
}

export function isAttachableImageFile(file: { name: string; type: string }): boolean {
  const type = file.type.split(";")[0].trim().toLowerCase();
  if (type.startsWith("image/")) return true;
  if (type === "" || type === "application/octet-stream")
    return contentTypeFromName(file.name) !== null;
  return false;
}

/** A mixed clipboard must keep its text when pasting into an editable field. */
export function pastedImageFiles(
  clipboard: Pick<DataTransfer, "files" | "getData">,
  intoTextField: boolean,
): File[] {
  if (intoTextField && clipboard.getData("text/plain")) return [];
  return Array.from(clipboard.files).filter(isAttachableImageFile);
}

/**
 * A blob whose type the decoder will believe.
 *
 * `createImageBitmap` and `<img>` trust the blob type. An AVIF, WebP or GIF
 * that arrived as `application/octet-stream` fails both unless it is
 * relabeled with its own type. `slice` changes the type without copying
 * the bytes.
 */
export function referenceImageBlob(file: File): Blob {
  const type = file.type.split(";")[0].trim().toLowerCase();
  if (type.startsWith("image/")) return file;
  const labeled = contentTypeFromName(file.name);
  if (labeled && isAttachableImageFile(file)) return file.slice(0, file.size, labeled);
  return file;
}
