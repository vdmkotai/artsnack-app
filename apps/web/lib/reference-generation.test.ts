import assert from "node:assert/strict";
import { test } from "node:test";
import type { ConvexReactClient } from "convex/react";
import { getFunctionName } from "convex/server";
import { mediaUrl, thumbUrl } from "@/lib/media-url";
import { findInHistory, findReferenceGeneration, referenceOutputKey } from "./reference-generation";

test("recognizes self-hosted and every API provider through CDN and proxy URLs", () => {
  for (const prefix of ["generations", "grok", "fal", "higgsfield", "atlas"]) {
    const key = `${prefix}/output.png`;
    for (const url of [mediaUrl(key), thumbUrl(key), `/api/images/${key}?download=1`]) {
      assert.equal(referenceOutputKey(url), key);
    }
  }
});

test("uploaded files, copied inputs and external images do not acquire generation settings", () => {
  for (const url of [
    undefined,
    "blob:local-file",
    "https://example.com/generations/output.png",
    mediaUrl("grok-references/input.jpg"),
    mediaUrl("imports/import.jpg"),
  ]) {
    assert.equal(referenceOutputKey(url), null);
  }
});

test("finds older generations beyond the first page and honors both API output formats", async () => {
  for (const [key, row, queryName, kind] of [
    [
      "generations/old.png",
      { b2Keys: ["generations/old.png"] },
      "generations:listPaginated",
      "selfhosted",
    ],
    [
      "fal/second.png",
      { mediaType: "image", b2Keys: ["fal/first.png", "fal/second.png"] },
      "grokGenerations:list",
      "api",
    ],
    ["grok/old.png", { mediaType: "image", b2Key: "grok/old.png" }, "grokGenerations:list", "api"],
  ] as const) {
    const cursors: (string | null)[] = [];
    const client = {
      query: async (
        query: Parameters<typeof getFunctionName>[0],
        args: { paginationOpts: { cursor: string | null } },
      ) => {
        assert.equal(getFunctionName(query), queryName);
        cursors.push(args.paginationOpts.cursor);
        return args.paginationOpts.cursor === null
          ? { page: [{ b2Keys: ["unrelated.png"] }], isDone: false, continueCursor: "older" }
          : { page: [row], isDone: true, continueCursor: "" };
      },
    } as unknown as ConvexReactClient;
    const found = await findReferenceGeneration(client, key, () => false);
    assert.equal(found?.kind, kind);
    assert.equal(found?.generation, row);
    assert.equal(found?.b2Key, key);
    assert.deepEqual(cursors, [null, "older"]);
  }
});

test("deleted or inaccessible generations return no settings", async () => {
  const found = await findInHistory(
    async () => ({ page: [], isDone: true, continueCursor: "" }),
    () => true,
    () => false,
  );
  assert.equal(found, null);
});

test("closing the preview ignores an in-flight lookup and stops pagination", async () => {
  let cancelled = false;
  let calls = 0;
  const found = await findInHistory(
    async () => {
      calls++;
      cancelled = true;
      return { page: ["match"], isDone: false, continueCursor: "older" };
    },
    () => true,
    () => cancelled,
  );
  assert.equal(found, null);
  assert.equal(calls, 1);
});
