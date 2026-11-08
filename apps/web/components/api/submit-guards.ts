import type { Id } from "@/convex/_generated/dataModel";

/**
 * Time limits for the awaits a Generate button waits on.
 *
 * A composer sets "submitting" before its first await and clears it after the
 * last, and two of those awaits had no way to end on their own: a reference
 * upload is a plain `fetch` to Convex storage, and a Convex mutation sent while
 * the websocket is reconnecting simply waits for the connection to come back.
 * Either one left the button spinning and the form locked until a reload.
 */

/** Long enough for a few megabytes on a poor uplink. */
const UPLOAD_TIMEOUT_MS = 120_000;
/** Starting a job is a quick write; this long means the connection is gone. */
const SERVER_TIMEOUT_MS = 30_000;

/**
 * Rejects if `work` has not settled in time.
 *
 * The mutation itself is not cancelled — Convex has no way to, and it may well
 * be delivered once the socket reconnects — so the message says so: retrying
 * blindly could start the same paid job twice.
 */
export function withServerTimeout<T>(work: Promise<T>, ms = SERVER_TIMEOUT_MS): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(
        new Error(
          `No answer from the server for ${Math.round(ms / 1000)} s — the connection may be down. ` +
            "The request can still go through once it reconnects, so check the results before retrying.",
        ),
      );
    }, ms);
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/** POSTs one image to a Convex storage upload URL and returns its storage id. */
export async function uploadToStorage(
  uploadUrl: string,
  blob: Blob,
  failure = "Failed to upload reference image",
): Promise<Id<"_storage">> {
  let response: Response;
  try {
    response = await fetch(uploadUrl, {
      method: "POST",
      headers: { "Content-Type": blob.type || "image/jpeg" },
      body: blob,
      signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "TimeoutError") {
      throw new Error(`${failure}: the upload took longer than ${UPLOAD_TIMEOUT_MS / 1000} s`);
    }
    throw error;
  }
  if (!response.ok) throw new Error(failure);
  const { storageId } = (await response.json()) as { storageId: Id<"_storage"> };
  return storageId;
}
