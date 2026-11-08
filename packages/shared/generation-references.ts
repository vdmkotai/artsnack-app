import { OUTPUT_PREFIXES } from "./image-key";

/** Keep empty slots so a later reference never inherits an earlier one's origin. */
export function normalizeReferenceSourceKeys(
  keys: (string | null)[] | undefined,
  referenceCount: number,
): (string | null)[] | undefined {
  if (!keys || referenceCount === 0) return undefined;
  if (keys.length !== referenceCount)
    throw new Error("Reference origins must match reference slots");
  return keys.map((key) => {
    if (key === null) return null;
    if (
      key.includes("..") ||
      /[?#\\\\]/.test(key) ||
      !["generations", ...Object.values(OUTPUT_PREFIXES)].some((prefix) =>
        key.startsWith(`${prefix}/`),
      )
    )
      throw new Error("Invalid reference output key");
    return key;
  });
}
