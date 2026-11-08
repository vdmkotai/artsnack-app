import { File, UploadType } from "expo-file-system";

import type { Id } from "@/convex/_generated/dataModel";
import type { ReferenceProfile } from "@/lib/reference-profile";

import { prepareReference } from "./prepare-reference";

/**
 * Fit an image to the provider's box and put it in Convex storage.
 *
 * Shared by the picker and by "use as reference" from the viewer, which is why
 * it takes a URI rather than an asset: a photo from the library and a generated
 * image on the CDN are the same thing by the time they get here.
 *
 * The upload is `File.upload` — a native binary POST from the file itself —
 * rather than `fetch(await fetch(uri).then(r => r.blob()))`. Two reasons, and the
 * second is why Grok video was failing to start: `fetch` on a `file://` URI in
 * React Native is unreliable, and nothing checked the response, so a POST that
 * did not return `{ storageId }` produced a reference holding `undefined`. That
 * survived all the way to the mutation, where Convex rejected the whole argument
 * object with "undefined is not a valid Convex value at .referenceStorageIds[0]".
 * A failure here now throws where it happened.
 */
export async function uploadReference(
  uri: string,
  profile: ReferenceProfile,
  uploadUrl: () => Promise<string>,
) {
  const prepared = await prepareReference(uri, profile);
  return {
    ...(await uploadImageFile(prepared.uri, uploadUrl)),
    width: prepared.width,
    height: prepared.height,
  };
}

export async function uploadImageFile(uri: string, uploadUrl: () => Promise<string>) {
  const preparedFile = new File(uri);

  const result = await preparedFile.upload(await uploadUrl(), {
    httpMethod: "POST",
    uploadType: UploadType.BINARY_CONTENT,
    headers: { "Content-Type": "image/jpeg" },
  });

  if (result.status < 200 || result.status >= 300) {
    throw new Error(`Upload refused with ${result.status}: ${result.body.slice(0, 200)}`);
  }

  const storageId = readStorageId(result.body);
  if (!storageId) {
    throw new Error(`Upload returned no storage id: ${result.body.slice(0, 200)}`);
  }

  return {
    storageId,
    uri,
    bytes: preparedFile.size ?? undefined,
  };
}

function readStorageId(body: string): Id<"_storage"> | null {
  try {
    const parsed = JSON.parse(body) as { storageId?: unknown };
    return typeof parsed.storageId === "string" && parsed.storageId.length > 0
      ? (parsed.storageId as Id<"_storage">)
      : null;
  } catch {
    return null;
  }
}
