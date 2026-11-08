import type { ConvexReactClient } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Doc } from "@/convex/_generated/dataModel";
import { OUTPUT_PREFIXES } from "@/lib/image-key";
import { mediaUrl } from "@/lib/media-url";

export type ReferenceGeneration =
  | { kind: "selfhosted"; generation: Doc<"generations">; b2Key: string }
  | { kind: "enhancement"; generation: Doc<"enhancements">; b2Key: string }
  | { kind: "api"; generation: Doc<"grokGenerations">; b2Key: string };

/** Only app media addresses can identify a generated output. */
export function referenceOutputKey(sourceUrl: string | undefined): string | null {
  if (!sourceUrl) return null;
  const base = mediaUrl("");
  let key: string;
  if (sourceUrl.startsWith("/api/images/")) {
    key = sourceUrl.slice("/api/images/".length);
  } else if (sourceUrl.startsWith(base)) {
    key = sourceUrl.slice(base.length);
  } else {
    return null;
  }
  key = key.replace(/^cdn-cgi\/image\/[^/]+\//, "").split(/[?#]/)[0];
  return key.startsWith("generations/") ||
    Object.values(OUTPUT_PREFIXES).some((prefix) => key.startsWith(`${prefix}/`))
    ? key
    : null;
}

/** Pages on demand so old outputs work without loading the entire history at mount. */
export async function findInHistory<T>(
  readPage: (cursor: string | null) => Promise<{
    page: T[];
    isDone: boolean;
    continueCursor: string;
  }>,
  matches: (row: T) => boolean,
  cancelled: () => boolean,
): Promise<T | null> {
  let cursor: string | null = null;
  while (!cancelled()) {
    const result = await readPage(cursor);
    if (cancelled()) return null;
    const found = result.page.find(matches);
    if (found) return found;
    if (result.isDone) return null;
    cursor = result.continueCursor;
  }
  return null;
}

export async function findReferenceGeneration(
  client: ConvexReactClient,
  b2Key: string,
  cancelled: () => boolean,
): Promise<ReferenceGeneration | null> {
  if (b2Key.startsWith("generations/")) {
    const generation = await findInHistory(
      (cursor) =>
        client.query(api.generations.listPaginated, {
          paginationOpts: { cursor, numItems: 100 },
        }),
      (row) => row.b2Keys?.includes(b2Key) === true,
      cancelled,
    );
    if (generation) return { kind: "selfhosted", generation, b2Key };
    const enhancement = await findInHistory(
      (cursor) =>
        client.query(api.enhancements.listPaginated, { paginationOpts: { cursor, numItems: 100 } }),
      (row) => row.resultB2Key === b2Key,
      cancelled,
    );
    return enhancement ? { kind: "enhancement", generation: enhancement, b2Key } : null;
  }
  const generation = await findInHistory(
    (cursor) =>
      client.query(api.grokGenerations.list, {
        paginationOpts: { cursor, numItems: 100 },
      }),
    (row) =>
      row.mediaType === "image" &&
      (row.b2Keys?.length ? row.b2Keys.includes(b2Key) : row.b2Key === b2Key),
    cancelled,
  );
  return generation ? { kind: "api", generation, b2Key } : null;
}
