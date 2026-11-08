/**
 * How a favourite says where it came from.
 *
 * Both clients render the same enriched `favorites` rows — `provider` and
 * `checkpoint` come from `convex/favorites.ts:enrichFavorite` — so the words
 * for them live here rather than in a web component the phone cannot import.
 */

/** Reads as a proper noun on a badge or a filter chip. */
export const FAVORITE_PROVIDER_LABELS: Record<string, string> = {
  "self-hosted": "Self-hosted",
  grok: "Grok",
  fal: "fal",
  higgsfield: "Higgsfield",
  atlas: "Atlas",
  enhance: "Enhanced",
};

/**
 * A checkpoint file name, cut to what a human calls the model: no directory,
 * no weights-format extension.
 */
export function shortCheckpointName(name: string): string {
  const base = name.split("/").pop() ?? name;
  return base.replace(/\.(safetensors|ckpt|pt)$/i, "");
}
