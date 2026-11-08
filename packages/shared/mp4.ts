/**
 * Just enough of the ISO base media format (MP4) to vet an uploaded clip
 * without a decoder: whether it is an MP4 at all, and how long it runs.
 *
 * Used where a clip arrives from a client and is about to be handed to a
 * vendor — the length decides whether Grok can edit (≤ 8.7 s) or extend
 * (2–15 s) it, and a figure the browser reported is a claim, not a fact.
 */

function readUint32(bytes: Uint8Array, offset: number): number {
  return (
    ((bytes[offset] << 24) >>> 0) +
    (bytes[offset + 1] << 16) +
    (bytes[offset + 2] << 8) +
    bytes[offset + 3]
  );
}

function readUint64(bytes: Uint8Array, offset: number): number {
  // Lossless up to 2^53, which no box size or duration here comes near.
  return readUint32(bytes, offset) * 2 ** 32 + readUint32(bytes, offset + 4);
}

function readType(bytes: Uint8Array, offset: number): string {
  return String.fromCharCode(
    bytes[offset],
    bytes[offset + 1],
    bytes[offset + 2],
    bytes[offset + 3],
  );
}

/** An MP4 opens with an `ftyp` box; anything else is not one. */
export function isMp4(bytes: Uint8Array): boolean {
  return bytes.length >= 12 && readType(bytes, 4) === "ftyp";
}

/** The boxes directly inside [start, end), as [type, payload start, payload end]. */
function* boxes(
  bytes: Uint8Array,
  start: number,
  end: number,
): Generator<[string, number, number]> {
  let offset = start;
  while (offset + 8 <= end) {
    let size = readUint32(bytes, offset);
    const type = readType(bytes, offset + 4);
    let header = 8;
    if (size === 1) {
      if (offset + 16 > end) return;
      size = readUint64(bytes, offset + 8);
      header = 16;
    } else if (size === 0) {
      size = end - offset;
    }
    if (size < header || offset + size > end) return;
    yield [type, offset + header, offset + size];
    offset += size;
  }
}

/**
 * The picture size from the first visual track's header (`moov/trak/tkhd`):
 * its last eight bytes are width and height in 16.16 fixed point. Audio tracks
 * carry zeros there and are passed over. Null when no track says.
 */
export function mp4VideoDimensions(bytes: Uint8Array): { width: number; height: number } | null {
  if (!isMp4(bytes)) return null;
  for (const [type, start, end] of boxes(bytes, 0, bytes.length)) {
    if (type !== "moov") continue;
    for (const [inner, trakStart, trakEnd] of boxes(bytes, start, end)) {
      if (inner !== "trak") continue;
      for (const [box, payload, payloadEnd] of boxes(bytes, trakStart, trakEnd)) {
        if (box !== "tkhd" || payloadEnd - payload < 8) continue;
        const width = readUint32(bytes, payloadEnd - 8) / 65536;
        const height = readUint32(bytes, payloadEnd - 4) / 65536;
        if (width > 0 && height > 0)
          return { width: Math.round(width), height: Math.round(height) };
      }
    }
    return null;
  }
  return null;
}

/**
 * Duration from the movie header (`moov/mvhd`), in seconds, or null when the
 * file has none — not an MP4, truncated, or a fragmented stream whose length
 * lives elsewhere.
 */
export function mp4DurationSeconds(bytes: Uint8Array): number | null {
  if (!isMp4(bytes)) return null;
  for (const [type, start, end] of boxes(bytes, 0, bytes.length)) {
    if (type !== "moov") continue;
    for (const [inner, payload, payloadEnd] of boxes(bytes, start, end)) {
      if (inner !== "mvhd") continue;
      const version = bytes[payload];
      // version(1) flags(3), then creation and modification times — 4 bytes
      // each in version 0, 8 in version 1 — then timescale and duration.
      const timescaleAt = payload + 4 + (version === 1 ? 16 : 8);
      const durationAt = timescaleAt + 4;
      if (durationAt + (version === 1 ? 8 : 4) > payloadEnd) return null;
      const timescale = readUint32(bytes, timescaleAt);
      const duration =
        version === 1 ? readUint64(bytes, durationAt) : readUint32(bytes, durationAt);
      // A fragmented stream writes 0 here and keeps its length in the
      // fragments; that is "unknown", not a zero-second clip.
      return timescale > 0 && duration > 0 ? duration / timescale : null;
    }
    return null;
  }
  return null;
}
