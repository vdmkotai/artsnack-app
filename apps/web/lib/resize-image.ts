import { centerCropRect } from "@/lib/api-models";
import { REFERENCE_PROFILES, type ReferenceProfile } from "@/lib/reference-profile";

/**
 * Browser reference-image preparation, using `createImageBitmap` and canvas.
 *
 * The limits it works to are shared with the iOS app — see
 * packages/shared/reference-profile.ts. Only the mechanism is web-specific.
 *
 * The two providers want very different things. xAI's Imagine edit/video
 * endpoints reject reference images larger than ~400KB or with dimensions
 * outside 256–768px (limits taken from grok-build's image_edit tool). fal has
 * no such ceiling — Seedream edits precisely at multi-megapixel resolution and
 * Seedance accepts up to 30MB per frame — so squeezing an image into Grok's
 * box before sending it to Seedream would throw away most of what makes the
 * edit worth doing.
 *
 * Hence one profile per provider. Both re-encode to JPEG on the client so we
 * never ship an untouched multi-MB original around.
 */

export type PreparedReference = {
  blob: Blob;
  width: number;
  height: number;
  /**
   * The *source* image's width / height (after any crop) — resolves an "auto"
   * aspect ratio before submitting. Deliberately not `width / height` above:
   * the min-dimension stretch clamps each edge independently, so for an extreme
   * panorama the blob is squashed and only the original ratio describes the
   * shape the user asked for.
   */
  aspect: number;
};

type Rect = { x: number; y: number; width: number; height: number };

type DecodedReference = {
  source: CanvasImageSource;
  width: number;
  height: number;
  close: () => void;
};

/**
 * Safari decodes AVIF in `<img>` and rejects the same bytes from
 * `createImageBitmap`. The element path is the fallback, used only after the
 * bitmap decoder throws, so JPEG and PNG keep the path they already had.
 */
async function decodeReference(file: Blob): Promise<DecodedReference> {
  try {
    const bitmap = await createImageBitmap(file);
    return {
      source: bitmap,
      width: bitmap.width,
      height: bitmap.height,
      close: () => bitmap.close(),
    };
  } catch (bitmapError) {
    const url = URL.createObjectURL(file);
    try {
      const image = await new Promise<HTMLImageElement>((resolve, reject) => {
        const element = new Image();
        element.onload = () => resolve(element);
        element.onerror = () => reject(bitmapError);
        element.src = url;
      });
      if (image.naturalWidth === 0 || image.naturalHeight === 0) throw bitmapError;
      return {
        source: image,
        width: image.naturalWidth,
        height: image.naturalHeight,
        close: () => URL.revokeObjectURL(url),
      };
    } catch (error) {
      URL.revokeObjectURL(url);
      throw error;
    }
  }
}

/**
 * The `crop` region of the source scaled to the output size, off the main
 * thread where the browser can do it. `rect` is what to draw from what comes
 * back: the whole bitmap when the browser did the work, else still the crop.
 *
 * `createImageBitmap` with resize options scales asynchronously; drawing a
 * 6000px photo straight onto a 2048px canvas does the same work synchronously,
 * on the thread that is also running the composer. The source here is always a
 * decoded image with its orientation already applied, so the resize cannot
 * disagree with EXIF the way resizing a raw file can. Safari versions without
 * the options reject or ignore them; the canvas draw below scales either way.
 */
async function scaledSource(
  decoded: DecodedReference,
  crop: Rect,
  width: number,
  height: number,
): Promise<{ source: CanvasImageSource; rect: Rect; close: () => void }> {
  const unscaled = { source: decoded.source, rect: crop, close: () => undefined };
  if (crop.width === width && crop.height === height) return unscaled;
  try {
    const scaled = await createImageBitmap(
      decoded.source as ImageBitmapSource,
      crop.x,
      crop.y,
      crop.width,
      crop.height,
      { resizeWidth: width, resizeHeight: height, resizeQuality: "high" },
    );
    // A browser that ignores the resize options still crops; the bitmap's own
    // size says which happened.
    const rect = { x: 0, y: 0, width: scaled.width, height: scaled.height };
    return { source: scaled, rect, close: () => scaled.close() };
  } catch {
    return unscaled;
  }
}

type Encoder = (quality: number) => Promise<Blob | null>;

/** An OffscreenCanvas where there is one: its encoder never touches the DOM. */
function drawForEncoding(
  source: CanvasImageSource,
  rect: Rect,
  width: number,
  height: number,
): Encoder {
  if (typeof OffscreenCanvas !== "undefined") {
    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext("2d");
    if (ctx) {
      ctx.drawImage(source, rect.x, rect.y, rect.width, rect.height, 0, 0, width, height);
      return (quality) => canvas.convertToBlob({ type: "image/jpeg", quality });
    }
  }
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas not available");
  ctx.drawImage(source, rect.x, rect.y, rect.width, rect.height, 0, 0, width, height);
  return (quality) =>
    new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", quality));
}

async function prepareNow(
  file: Blob,
  profile: ReferenceProfile,
  aspectRatio: string | undefined,
): Promise<PreparedReference> {
  const limits = REFERENCE_PROFILES[profile];
  const bitmap = await decodeReference(file);
  try {
    const crop = centerCropRect(bitmap.width, bitmap.height, aspectRatio);
    let { width, height } = crop;

    const scaleDown = Math.min(1, limits.maxDimension / Math.max(width, height));
    width = Math.round(width * scaleDown);
    height = Math.round(height * scaleDown);

    // If a dimension ends up below the API minimum, stretch it back up while
    // staying within maxDimension on the long edge.
    const minEdge = Math.min(width, height);
    if (minEdge < limits.minDimension) {
      const scaleUp = limits.minDimension / minEdge;
      width = Math.min(limits.maxDimension, Math.round(width * scaleUp));
      height = Math.min(limits.maxDimension, Math.round(height * scaleUp));
    }

    const scaled = await scaledSource(bitmap, crop, width, height);
    let encode: Encoder;
    try {
      encode = drawForEncoding(scaled.source, scaled.rect, width, height);
    } finally {
      scaled.close();
    }

    for (const quality of limits.qualitySteps) {
      const blob = await encode(quality);
      if (!blob) throw new Error("Failed to encode image");
      if (blob.size <= limits.maxBytes) {
        // The original ratio, not width/height: the min-dimension stretch above
        // clamps each edge independently, so an extreme panorama comes out
        // squashed and reporting the squashed ratio would also size the
        // generated output for a shape the user never asked for.
        return { blob, width, height, aspect: crop.width / crop.height };
      }
    }
    throw new Error(
      `Could not compress image below the ${Math.round(limits.maxBytes / 1024)}KB limit`,
    );
  } finally {
    bitmap.close();
  }
}

/**
 * One preparation at a time, in the order they were asked for.
 *
 * Callers fan out — a seven-image hand-off, a reproduce restoring every
 * reference, a multi-file drop — and running those decodes and encodes side by
 * side held several full-size bitmaps in memory at once and stacked their
 * canvas work into one long stall. Downloads still overlap; only this part
 * queues.
 */
let queue: Promise<unknown> = Promise.resolve();

/**
 * `aspectRatio` ("16:9"…) centre-crops the picture to that shape first; absent
 * or "auto" keeps it whole.
 */
export function prepareReferenceImage(
  file: Blob,
  profile: ReferenceProfile,
  aspectRatio?: string,
): Promise<PreparedReference> {
  const run = queue.then(() => prepareNow(file, profile, aspectRatio));
  queue = run.catch(() => undefined);
  return run;
}

export type { ReferenceProfile } from "@/lib/reference-profile";
