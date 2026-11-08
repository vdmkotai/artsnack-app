import assert from "node:assert/strict";
import test from "node:test";

import { boundedMediaParts } from "./media-stream";

async function* chunks(...sizes: number[]): AsyncGenerator<Uint8Array> {
  let value = 0;
  for (const size of sizes) {
    yield Uint8Array.from({ length: size }, () => value++ % 256);
  }
}

test("large media is split into bounded upload parts without buffering the whole file", async () => {
  const parts: Uint8Array[] = [];
  for await (const part of boundedMediaParts(chunks(3, 7, 11), 100, 8)) parts.push(part);

  assert.deepEqual(
    parts.map((part) => part.byteLength),
    [8, 8, 5],
  );
  assert.deepEqual(Array.from(parts[0]), [0, 1, 2, 3, 4, 5, 6, 7]);
  assert.deepEqual(Array.from(parts[2]), [16, 17, 18, 19, 20]);
});

test("streaming stops before media can exceed its configured byte limit", async () => {
  await assert.rejects(async () => {
    for await (const _part of boundedMediaParts(chunks(6, 6), 10, 8)) {
      // Consume the stream so the limit is enforced.
    }
  }, /12 bytes.*10-byte limit/);
});

test("exact limits, empty streams, and invalid bounds are explicit", async () => {
  const exact: Uint8Array[] = [];
  for await (const part of boundedMediaParts(chunks(2, 3), 5, 3)) exact.push(part);
  assert.deepEqual(
    exact.map((part) => part.byteLength),
    [3, 2],
  );

  const empty: Uint8Array[] = [];
  for await (const part of boundedMediaParts(chunks(), 5, 3)) empty.push(part);
  assert.deepEqual(empty, []);

  await assert.rejects(async () => {
    for await (const _part of boundedMediaParts(chunks(1), 0, 3)) {
      // Consume validation.
    }
  }, /maxBytes must be a positive safe integer/);
  await assert.rejects(async () => {
    for await (const _part of boundedMediaParts(chunks(1), 5, 0)) {
      // Consume validation.
    }
  }, /partBytes must be a positive safe integer/);
});
