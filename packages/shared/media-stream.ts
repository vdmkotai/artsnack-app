/**
 * Re-packs an arbitrary byte stream into bounded upload parts.
 *
 * The caller holds one part in memory at a time. This is the important
 * difference from `Response.arrayBuffer()`, which duplicates an entire large
 * video inside the process before the upload can even start.
 */
export async function* boundedMediaParts(
  source: AsyncIterable<Uint8Array>,
  maxBytes: number,
  partBytes = 16 * 1024 * 1024,
): AsyncGenerator<Uint8Array> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new RangeError("maxBytes must be a positive safe integer");
  }
  if (!Number.isSafeInteger(partBytes) || partBytes <= 0) {
    throw new RangeError("partBytes must be a positive safe integer");
  }

  let part = new Uint8Array(partBytes);
  let used = 0;
  let total = 0;

  for await (const chunk of source) {
    total += chunk.byteLength;
    if (total > maxBytes) {
      throw new RangeError(`Media stream reached ${total} bytes, above the ${maxBytes}-byte limit`);
    }

    let offset = 0;
    while (offset < chunk.byteLength) {
      const copied = Math.min(partBytes - used, chunk.byteLength - offset);
      part.set(chunk.subarray(offset, offset + copied), used);
      offset += copied;
      used += copied;

      if (used === partBytes) {
        yield part;
        part = new Uint8Array(partBytes);
        used = 0;
      }
    }
  }

  if (used > 0) yield part.subarray(0, used);
}
