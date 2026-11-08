import { File } from "expo-file-system";
import { ImageManipulator, SaveFormat } from "expo-image-manipulator";

import { REFERENCE_PROFILES, type ReferenceProfile } from "@/lib/reference-profile";
import { referenceDimensions } from "@/lib/reference-dimensions";

/**
 * The iOS half of what canvas does in the browser: fit inside the provider's box
 * and re-encode until it is under the byte ceiling.
 *
 * The limits come from packages/shared, so the two clients cannot drift on what
 * a provider accepts — only on how they get there.
 */
export async function prepareReference(uri: string, profile: ReferenceProfile) {
  const limits = REFERENCE_PROFILES[profile];
  const context = ImageManipulator.manipulate(uri);
  const original = await context.renderAsync();
  context.resize(referenceDimensions(original.width, original.height, profile));
  const image = await context.renderAsync();

  for (const quality of limits.qualitySteps) {
    const saved = await image.saveAsync({ compress: quality, format: SaveFormat.JPEG });
    // Read off the file rather than through `fetch(file://)`, which React Native
    // does not serve reliably — see upload-reference.ts. An unreadable size means
    // "assume it is too big and compress further", which is the safe direction.
    const size = new File(saved.uri).size ?? Number.POSITIVE_INFINITY;
    if (size <= limits.maxBytes) return saved;
  }
  throw new Error(
    "This image is too large for the selected provider. Choose another reference or model.",
  );
}
