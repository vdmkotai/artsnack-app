/**
 * Cleans a comma-separated search input into space-separated terms
 * for Convex full-text search.
 *
 * Examples:
 *   "corgi, king"       → "corgi king"
 *   "corgi, color"      → "corgi color"
 *   "(dog:1.2), corgi"  → "(dog:1.2) corgi"
 *
 * Convex's Tantivy tokenizer handles the rest — stripping parentheses,
 * colons, underscores, and lowercasing all terms automatically.
 */
export function cleanSearchQuery(raw: string): string {
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .join(" ");
}
