"use node";

/**
 * Shared plumbing for the provider processors: timeouts, transient-failure
 * retries, B2 uploads and reference-image handling.
 *
 * Extracted from grokProcessor when fal was added — both processors download
 * bytes from a vendor and park them in B2, and duplicating that was how the
 * two would have drifted apart.
 */

import { ActionCtx } from "./_generated/server";
import { Id } from "./_generated/dataModel";
import { createHash } from "node:crypto";
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
} from "@aws-sdk/client-s3";
import { b2Region } from "../../shared/b2-region";
import { GROK_SOURCE_VIDEO_PREFIX, REFERENCE_PREFIX } from "../../shared/image-key";
import { extensionForContentType } from "../../shared/atlas-output";
import { boundedMediaParts } from "../../shared/media-stream";

/** Transient network error codes worth retrying (DNS hiccups, dropped sockets). */
const TRANSIENT_CODES = [
  "EBUSY",
  "EAI_AGAIN",
  "ECONNRESET",
  "ECONNREFUSED",
  "ETIMEDOUT",
  "UND_ERR_SOCKET",
];

export async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    // Keep a caller-owned signal connected after the response headers arrive.
    // Streaming callers need to abort a stalled body later; this function's
    // own timer is only the deadline for receiving the initial response.
    const signal = init.signal
      ? AbortSignal.any([controller.signal, init.signal])
      : controller.signal;
    return await fetch(url, { ...init, signal });
  } finally {
    clearTimeout(timer);
  }
}

export function isTransientNetworkError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  // Node fetch (undici) wraps network failures in TypeError("fetch failed")
  // with the real code on .cause; the S3 SDK puts the code on the error itself.
  const code =
    (error as { code?: string }).code ?? (error.cause as { code?: string } | undefined)?.code;
  return code !== undefined && TRANSIENT_CODES.includes(code);
}

/** Retry transient network failures with backoff: 1s, 3s. Deterministic
 * errors (HTTP 4xx/5xx, timeouts, validation) are never retried. */
export async function withTransientRetry<T>(fn: () => Promise<T>): Promise<T> {
  const delays = [1000, 3000];
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (error) {
      if (attempt >= delays.length || !isTransientNetworkError(error)) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, delays[attempt]));
    }
  }
}

// ---------------------------------------------------------------------------
// B2
// ---------------------------------------------------------------------------

/**
 * One client per isolate, matching lib/b2.ts.
 *
 * The win is socket reuse across the uploads of a single fan-out, not credential
 * resolution — these credentials are static literals. The cost is that a warm
 * isolate keeps using the B2 key it started with, so rotating B2_KEY_ID in the
 * Convex environment only takes effect as isolates recycle.
 */
let s3Client: S3Client | null = null;

export function getS3Client(): S3Client {
  if (s3Client) return s3Client;
  const endpoint = process.env.B2_ENDPOINT;
  const keyId = process.env.B2_KEY_ID;
  const appKey = process.env.B2_APP_KEY;
  if (!endpoint || !keyId || !appKey) {
    throw new Error("B2 environment variables not configured in Convex env");
  }
  s3Client = new S3Client({
    endpoint: `https://${endpoint}`,
    region: b2Region(endpoint, process.env.B2_REGION),
    credentials: { accessKeyId: keyId, secretAccessKey: appKey },
  });
  return s3Client;
}

/** Uploads generated media and returns its B2 key. */
export async function uploadMediaToB2(
  bytes: Uint8Array,
  contentType: string,
  prefix: string,
  objectKey?: string,
): Promise<string> {
  const bucketName = process.env.B2_BUCKET_NAME;
  if (!bucketName) throw new Error("B2_BUCKET_NAME not configured");

  const extension = extensionForContentType(contentType);
  const key =
    objectKey ??
    `${prefix}/${Date.now()}_${Math.random().toString(36).substring(2, 8)}.${extension}`;
  await withTransientRetry(() =>
    getS3Client().send(
      new PutObjectCommand({
        Bucket: bucketName,
        Key: key,
        Body: bytes,
        ContentType: contentType,
      }),
    ),
  );
  return key;
}

async function* responseChunks(
  body: ReadableStream<Uint8Array>,
  controller: AbortController,
  inactivityTimeoutMs: number,
): AsyncGenerator<Uint8Array> {
  const reader = body.getReader();
  try {
    for (;;) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const result = await Promise.race([
          reader.read(),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => {
              controller.abort();
              reject(new Error(`Media download made no progress for ${inactivityTimeoutMs}ms`));
            }, inactivityTimeoutMs);
          }),
        ]);
        if (result.done) return;
        if (result.value.byteLength > 0) yield result.value;
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    }
  } finally {
    reader.releaseLock();
  }
}

/**
 * Copies provider media to B2 with bounded memory.
 *
 * Multipart upload is intentional even when the source omits Content-Length:
 * every part is capped at 16 MiB, so a 139 MiB video never becomes one giant
 * `ArrayBuffer` inside a Convex action. The deterministic object key remains
 * invisible until the multipart upload completes.
 */
export async function uploadMediaUrlToB2(
  url: string,
  contentType: string,
  prefix: string,
  options: {
    maxBytes: number;
    inactivityTimeoutMs: number;
    objectKey?: string;
  },
): Promise<string> {
  const bucketName = process.env.B2_BUCKET_NAME;
  if (!bucketName) throw new Error("B2_BUCKET_NAME not configured");

  const extension = extensionForContentType(contentType);
  const key =
    options.objectKey ??
    `${prefix}/${Date.now()}_${Math.random().toString(36).substring(2, 8)}.${extension}`;
  const controller = new AbortController();
  const response = await withTransientRetry(() =>
    fetchWithTimeout(url, { signal: controller.signal }, options.inactivityTimeoutMs),
  );
  if (!response.ok || !response.body) {
    throw new Error(`Failed to download provider output (HTTP ${response.status})`);
  }

  const declaredBytes = Number(response.headers.get("content-length") ?? 0);
  if (Number.isFinite(declaredBytes) && declaredBytes > options.maxBytes) {
    controller.abort();
    throw new RangeError(
      `Provider output is ${declaredBytes} bytes, above the ${options.maxBytes}-byte limit`,
    );
  }

  const client = getS3Client();
  const created = await withTransientRetry(() =>
    client.send(
      new CreateMultipartUploadCommand({
        Bucket: bucketName,
        Key: key,
        ContentType: contentType,
      }),
    ),
  );
  if (!created.UploadId) throw new Error("B2 did not return a multipart upload id");

  const uploadId = created.UploadId;
  const uploadedParts: { ETag: string; PartNumber: number }[] = [];
  let uploadedBytes = 0;
  try {
    for await (const part of boundedMediaParts(
      responseChunks(response.body, controller, options.inactivityTimeoutMs),
      options.maxBytes,
    )) {
      const partNumber = uploadedParts.length + 1;
      const uploaded = await withTransientRetry(() =>
        client.send(
          new UploadPartCommand({
            Bucket: bucketName,
            Key: key,
            UploadId: uploadId,
            PartNumber: partNumber,
            Body: part,
          }),
        ),
      );
      if (!uploaded.ETag) throw new Error(`B2 returned no ETag for multipart part ${partNumber}`);
      uploadedParts.push({ ETag: uploaded.ETag, PartNumber: partNumber });
      uploadedBytes += part.byteLength;
    }
    if (uploadedParts.length === 0) throw new Error("Provider returned an empty media stream");

    await withTransientRetry(() =>
      client.send(
        new CompleteMultipartUploadCommand({
          Bucket: bucketName,
          Key: key,
          UploadId: uploadId,
          MultipartUpload: { Parts: uploadedParts },
        }),
      ),
    );
    const stored = await withTransientRetry(() =>
      client.send(new HeadObjectCommand({ Bucket: bucketName, Key: key })),
    );
    if (stored.ContentLength !== uploadedBytes) {
      throw new Error(`B2 stored ${stored.ContentLength} bytes after receiving ${uploadedBytes}`);
    }
    return key;
  } catch (error) {
    controller.abort();
    await client
      .send(
        new AbortMultipartUploadCommand({
          Bucket: bucketName,
          Key: key,
          UploadId: uploadId,
        }),
      )
      .catch(() => undefined);
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Reference images
// ---------------------------------------------------------------------------

/**
 * Image types that are safe to store — and therefore safe to serve back.
 *
 * Every raster format belongs here, including the ones a phone hands us
 * (image/heic, image/heif) and the ones our own resize path can emit
 * (image/avif): rewriting those would store a perfectly good picture as a
 * download under a content-hashed key that then sticks for every future
 * generation reusing the same bytes.
 *
 * image/svg+xml is the one image type that is deliberately absent — an SVG
 * executes script even when served with its own honest Content-Type.
 */
const SAFE_IMAGE_CONTENT_TYPES = [
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
  "image/avif",
  "image/heic",
  "image/heif",
  "image/bmp",
  "image/tiff",
];

/**
 * The stored Content-Type for a reference image, narrowed to types a browser
 * can only render as a picture.
 *
 * Anything unrecognised becomes application/octet-stream rather than being
 * dropped: the bytes are still worth keeping, they just must not be presented
 * as something the browser will interpret.
 */
export function safeImageContentType(contentType: string): string {
  const normalized = contentType.split(";")[0].trim().toLowerCase();
  const canonical = normalized === "image/jpg" ? "image/jpeg" : normalized;
  return SAFE_IMAGE_CONTENT_TYPES.includes(canonical) ? canonical : "application/octet-stream";
}

export type ReferenceImage = {
  bytes: Uint8Array;
  contentType: string;
  dataUrl: string;
};

export async function loadReferenceImages(
  ctx: ActionCtx,
  storageIds: Id<"_storage">[],
): Promise<ReferenceImage[]> {
  return await Promise.all(
    storageIds.map(async (storageId) => {
      const blob = await ctx.storage.get(storageId);
      if (!blob) throw new Error("Reference image not found in storage");
      const bytes = new Uint8Array(await blob.arrayBuffer());
      const contentType = blob.type || "image/jpeg";
      return {
        bytes,
        contentType,
        dataUrl: `data:${contentType};base64,${Buffer.from(bytes).toString("base64")}`,
      };
    }),
  );
}

/**
 * Parks references in B2 under a content hash, so re-using the same image
 * costs one object no matter how many generations point at it. Shared between
 * providers on purpose — the same attachment used with Grok and with Seedream
 * resolves to one key.
 */
export async function persistReferenceImages(references: ReferenceImage[]): Promise<string[]> {
  if (references.length === 0) return [];
  const bucketName = process.env.B2_BUCKET_NAME;
  if (!bucketName) throw new Error("B2_BUCKET_NAME not configured");

  const client = getS3Client();
  return await Promise.all(
    references.map(async (reference) => {
      const hash = createHash("sha256").update(reference.bytes).digest("hex");
      const key = `${REFERENCE_PREFIX}/${hash}.jpg`;
      try {
        await withTransientRetry(() =>
          client.send(new HeadObjectCommand({ Bucket: bucketName, Key: key })),
        );
        return key;
      } catch (error) {
        const status = (error as { $metadata?: { httpStatusCode?: number } }).$metadata
          ?.httpStatusCode;
        const name = (error as { name?: string }).name;
        if (status !== 404 && name !== "NotFound" && name !== "NoSuchKey") throw error;
      }

      await withTransientRetry(() =>
        client.send(
          new PutObjectCommand({
            Bucket: bucketName,
            Key: key,
            Body: reference.bytes,
            // Clamped, never echoed: the type came from a client-uploaded blob
            // and /api/images serves it back verbatim on a public route, so an
            // attacker-chosen text/html would execute as script on our own
            // origin. image/svg+xml stays off the allowlist for the same reason
            // — it scripts even when the Content-Type is honest.
            ContentType: safeImageContentType(reference.contentType),
          }),
        ),
      );
      return key;
    }),
  );
}

function isMissing(error: unknown): boolean {
  const status = (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
  const name = (error as { name?: string }).name;
  return status === 404 || name === "NotFound" || name === "NoSuchKey";
}

/**
 * Parks an uploaded Grok source clip in B2 under its content hash, the way
 * reference images are parked: the same clip uploaded twice is one object,
 * and the key ends in `.mp4`, which xAI requires of a video URL. The caller
 * has already checked the bytes are an MP4; the stored type is fixed rather
 * than taken from the upload, so the media proxy can only ever serve it as
 * video/mp4.
 */
export async function persistSourceVideo(bytes: Uint8Array): Promise<string> {
  const bucketName = process.env.B2_BUCKET_NAME;
  if (!bucketName) throw new Error("B2_BUCKET_NAME not configured");
  const client = getS3Client();
  const hash = createHash("sha256").update(bytes).digest("hex");
  const key = `${GROK_SOURCE_VIDEO_PREFIX}/${hash}.mp4`;
  try {
    await withTransientRetry(() =>
      client.send(new HeadObjectCommand({ Bucket: bucketName, Key: key })),
    );
    return key;
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
  await withTransientRetry(() =>
    client.send(
      new PutObjectCommand({
        Bucket: bucketName,
        Key: key,
        Body: bytes,
        ContentType: "video/mp4",
      }),
    ),
  );
  return key;
}

/** Reads a whole B2 object — for the rare path with no public media URL. */
export async function loadB2Object(key: string): Promise<Uint8Array> {
  const bucketName = process.env.B2_BUCKET_NAME;
  if (!bucketName) throw new Error("B2_BUCKET_NAME not configured");
  const response = await withTransientRetry(() =>
    getS3Client().send(new GetObjectCommand({ Bucket: bucketName, Key: key })),
  );
  if (!response.Body) throw new Error(`B2 returned no body for ${key}`);
  return await response.Body.transformToByteArray();
}

/**
 * Public URL for a B2 object, or null when no CDN base is configured.
 *
 * fal fetches reference images itself, so it needs a reachable URL. Falling
 * back to a base64 data URI works but inflates the request body, which is why
 * the CDN path is strongly preferred.
 */
export function publicMediaUrl(key: string): string | null {
  const base = process.env.MEDIA_BASE_URL;
  if (!base) return null;
  return `${base.replace(/\/+$/, "")}/${key}`;
}
