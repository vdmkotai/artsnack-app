import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";

// The worker is a plain script served from public/; it exports its pure
// helpers through module.exports when loaded outside a service worker.
const worker = createRequire(import.meta.url)("../public/media-cache-sw.js") as {
  parseRange: (
    header: string | null,
  ) => { start: number | null; end: number | null } | null | undefined;
  resolveRange: (
    range: { start: number | null; end: number | null },
    total: number,
  ) => { start: number; end: number } | null;
  planEviction: (
    entries: { url: string; size: number; used: number }[],
    limit: number,
    target: number,
  ) => string[];
  isMediaType: (contentType: string | null) => boolean;
  mediaKeyFor: (rawUrl: string, mediaOrigin: string | null) => string | null;
  isClipRequest: (
    destination: string,
    range: { start: number | null; end: number | null } | null,
  ) => boolean;
  rangeIsAhead: (start: number, received: number, slack: number) => boolean;
  queuePrefetch: (queue: readonly string[], keys: readonly string[], limit: number) => string[];
  passThroughHeaders: (upstream: Headers) => Headers;
  routePatterns: (mediaOrigin: string) => {
    cdnCgi: Record<string, string>;
    media: Record<string, string>;
  };
  deadline: <T>(
    promise: Promise<T>,
    ms: number,
    controller: AbortController,
    what: string,
  ) => Promise<T>;
  remember: <V>(map: Map<string, V>, key: string, value: V, limit: number) => Map<string, V>;
  claimSide: <S extends string>(map: Map<string, S>, key: string, side: S, limit: number) => S;
  watchedBody: (
    body: ReadableStream<Uint8Array>,
    controller: AbortController,
    ms: number,
    onFailure: (error: unknown) => void,
    onSuccess?: () => void,
  ) => ReadableStream<Uint8Array>;
};

const MEDIA = "https://media.example.com";

test("parses the range forms a media element sends", () => {
  assert.equal(worker.parseRange(null), null);
  assert.deepEqual(worker.parseRange("bytes=0-"), { start: 0, end: null });
  assert.deepEqual(worker.parseRange("bytes=0-1"), { start: 0, end: 1 });
  assert.deepEqual(worker.parseRange("bytes=-500"), { start: null, end: 500 });
  // Multipart and malformed ranges go to the network untouched.
  assert.equal(worker.parseRange("bytes=0-1,5-9"), undefined);
  assert.equal(worker.parseRange("bytes=-"), undefined);
  assert.equal(worker.parseRange("items=0-1"), undefined);
});

test("resolves ranges against the object size, clamping and rejecting", () => {
  assert.deepEqual(worker.resolveRange({ start: 0, end: null }, 100), { start: 0, end: 99 });
  assert.deepEqual(worker.resolveRange({ start: 0, end: 1 }, 100), { start: 0, end: 1 });
  assert.deepEqual(worker.resolveRange({ start: 90, end: 500 }, 100), { start: 90, end: 99 });
  assert.deepEqual(worker.resolveRange({ start: null, end: 10 }, 100), { start: 90, end: 99 });
  assert.deepEqual(worker.resolveRange({ start: null, end: 500 }, 100), { start: 0, end: 99 });
  assert.equal(worker.resolveRange({ start: 100, end: null }, 100), null);
  assert.equal(worker.resolveRange({ start: 50, end: 40 }, 100), null);
  assert.equal(worker.resolveRange({ start: null, end: 0 }, 100), null);
});

test("evicts least recently used entries down to the target, only once over the limit", () => {
  const entries = [
    { url: "new", size: 40, used: 300 },
    { url: "old", size: 40, used: 100 },
    { url: "mid", size: 40, used: 200 },
  ];
  assert.deepEqual(worker.planEviction(entries, 120, 100), []);
  assert.deepEqual(worker.planEviction(entries, 110, 90), ["old"]);
  assert.deepEqual(worker.planEviction(entries, 100, 50), ["old", "mid"]);
  assert.equal(entries[0].url, "new", "the input order is left alone");
});

test("keeps only media, never an error page", () => {
  assert.equal(worker.isMediaType("video/mp4"), true);
  assert.equal(worker.isMediaType("image/avif"), true);
  assert.equal(worker.isMediaType("text/html; charset=utf-8"), false);
  assert.equal(worker.isMediaType("application/json"), false);
  assert.equal(worker.isMediaType(null), false);
});

test("keys only media originals, never the edge's previews or other origins", () => {
  assert.equal(
    worker.mediaKeyFor(`${MEDIA}/generations/a.png#frag`, MEDIA),
    `${MEDIA}/generations/a.png`,
  );
  assert.equal(worker.mediaKeyFor(`${MEDIA}/videos/a.mp4?v=2`, MEDIA), `${MEDIA}/videos/a.mp4?v=2`);
  // Thumbnails and posters stay on the nearest Cloudflare edge.
  assert.equal(
    worker.mediaKeyFor(`${MEDIA}/cdn-cgi/image/width=512/generations/a.png`, MEDIA),
    null,
  );
  assert.equal(worker.mediaKeyFor(`${MEDIA}/cdn-cgi/media/mode=frame/videos/a.mp4`, MEDIA), null);
  assert.equal(
    worker.mediaKeyFor("https://artsnack.example.com/media/generations/a.png", MEDIA),
    null,
  );
  assert.equal(worker.mediaKeyFor("http://media.example.com/generations/a.png", MEDIA), null);
  assert.equal(worker.mediaKeyFor(`${MEDIA}/generations/a.png`, null), null);
  assert.equal(worker.mediaKeyFor("not a url", MEDIA), null);
});

test("treats ranged and media-element requests as clips, whole-object requests as images", () => {
  assert.equal(worker.isClipRequest("video", { start: 0, end: null }), true);
  assert.equal(worker.isClipRequest("video", null), true);
  assert.equal(worker.isClipRequest("audio", null), true);
  assert.equal(worker.isClipRequest("", { start: 0, end: 0 }), true);
  assert.equal(worker.isClipRequest("image", null), false);
  assert.equal(worker.isClipRequest("", null), false);
});

test("waits for a download only when the range starts within the slack of its front", () => {
  const slack = 2 * 1024 ** 2;
  assert.equal(worker.rangeIsAhead(0, 0, slack), false);
  assert.equal(worker.rangeIsAhead(slack, 0, slack), false);
  assert.equal(worker.rangeIsAhead(slack + 1, 0, slack), true);
  assert.equal(worker.rangeIsAhead(10_000_000, 9_000_000, slack), false);
  assert.equal(worker.rangeIsAhead(40_000_000, 1_000_000, slack), true);
});

test("queues prefetches newest first, without duplicates, dropping the oldest", () => {
  assert.deepEqual(worker.queuePrefetch([], ["a", "b"], 16), ["a", "b"]);
  // A later request goes ahead of everything waiting, in the order it gave.
  assert.deepEqual(worker.queuePrefetch(["a", "b"], ["c", "d"], 16), ["c", "d", "a", "b"]);
  // Asking again for something already waiting moves it to the front.
  assert.deepEqual(worker.queuePrefetch(["a", "b", "c"], ["c"], 16), ["c", "a", "b"]);
  assert.deepEqual(worker.queuePrefetch([], ["a", "a", "b"], 16), ["a", "b"]);
  assert.deepEqual(worker.queuePrefetch(["x", "y", "z"], ["a", "b"], 3), ["a", "b", "x"]);
  const queue = ["a"];
  worker.queuePrefetch(queue, ["b"], 16);
  assert.deepEqual(queue, ["a"], "the input queue is left alone");
});

test("restates only the headers a media element reads on a passed-through range", () => {
  const passed = worker.passThroughHeaders(
    new Headers({
      "content-type": "video/mp4",
      "content-length": "1000",
      "content-range": "bytes 0-999/5000",
      "accept-ranges": "bytes",
      "set-cookie": "a=b",
      "cf-cache-status": "HIT",
    }),
  );
  assert.deepEqual(Object.fromEntries(passed), {
    "accept-ranges": "bytes",
    "content-length": "1000",
    "content-range": "bytes 0-999/5000",
    "content-type": "video/mp4",
  });
  // A 206 that lost its length on the way gets one from its range.
  const chunked = worker.passThroughHeaders(
    new Headers({ "content-type": "video/mp4", "content-range": "bytes 100-199/5000" }),
  );
  assert.equal(chunked.get("content-length"), "100");
  assert.equal(chunked.get("accept-ranges"), "bytes");
  // A whole-object answer without a length stays without one.
  const whole = worker.passThroughHeaders(new Headers({ "content-type": "video/mp4" }));
  assert.equal(whole.get("content-length"), null);
  assert.equal(whole.get("content-range"), null);
});

test("routes previews and everything off the media origin to the network", () => {
  const patterns = worker.routePatterns(MEDIA);
  const cdnCgi = new URLPattern(patterns.cdnCgi);
  const media = new URLPattern(patterns.media);
  const toNetwork = (url: string) => cdnCgi.test(url) || !media.test(url);
  assert.equal(toNetwork(`${MEDIA}/cdn-cgi/image/width=512/generations/a.png`), true);
  assert.equal(toNetwork(`${MEDIA}/cdn-cgi/media/mode=frame/videos/a.mp4`), true);
  assert.equal(toNetwork("https://artsnack.example.com/"), true);
  assert.equal(toNetwork("https://artsnack.example.com/_next/static/chunks/main.js"), true);
  assert.equal(toNetwork("https://artsnack.example.com/media/videos/a.mp4"), true);
  assert.equal(toNetwork("https://clerk.example.com/v1/client"), true);
  assert.equal(toNetwork("https://media.example.com:8443/videos/a.mp4"), true);
  // Only media originals reach the fetch handler.
  assert.equal(toNetwork(`${MEDIA}/generations/a.png`), false);
  assert.equal(toNetwork(`${MEDIA}/videos/a.mp4?v=1`), false);
});

test("a deadline passes a prompt answer through and aborts a slow one", async () => {
  const quick = new AbortController();
  assert.equal(await worker.deadline(Promise.resolve("ok"), 50, quick, "x"), "ok");
  assert.equal(quick.signal.aborted, false);

  const slow = new AbortController();
  await assert.rejects(worker.deadline(new Promise(() => {}), 10, slow, "headers"), /headers/);
  assert.equal(slow.signal.aborted, true, "the fetch behind it is torn down");

  // An abort for any other reason ends the wait too, even if the promise ignores it.
  const abandoned = new AbortController();
  const waiting = worker.deadline(new Promise(() => {}), 10_000, abandoned, "chunk");
  abandoned.abort(new Error("abandoned"));
  await assert.rejects(waiting, /abandoned/);
});

test("remembers which side answered a clip, forgetting the least recent past the limit", () => {
  const sources = new Map<string, string>();
  worker.remember(sources, "a", "worker", 2);
  worker.remember(sources, "b", "network", 2);
  worker.remember(sources, "a", "worker", 2); // a is the most recent again
  worker.remember(sources, "c", "worker", 2);
  assert.deepEqual(
    [...sources],
    [
      ["a", "worker"],
      ["c", "worker"],
    ],
  );
  worker.remember(sources, "c", "network", 2);
  assert.equal(sources.get("c"), "network");
});

/** An upstream body for watchedBody: `chunks` pieces, then optionally a stall. */
function upstream(chunks: number, { stall = false, fail = false } = {}) {
  const seen = { pulls: 0, cancelled: false };
  let sent = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      seen.pulls++;
      if (sent < chunks) {
        sent++;
        controller.enqueue(new Uint8Array(4));
        return;
      }
      if (fail) controller.error(new Error("connection reset"));
      else if (stall) return new Promise<void>(() => {});
      else controller.close();
    },
    cancel() {
      seen.cancelled = true;
    },
  });
  return { body, seen };
}

const readAll = async (stream: ReadableStream<Uint8Array>) => {
  const reader = stream.getReader();
  let bytes = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return bytes;
    bytes += value.byteLength;
  }
};

test("a watched body hands on every chunk and reports success at the end", async () => {
  const { body } = upstream(3);
  const failures: unknown[] = [];
  let successes = 0;
  const controller = new AbortController();
  const watched = worker.watchedBody(
    body,
    controller,
    1_000,
    (e) => failures.push(e),
    () => {
      successes++;
    },
  );
  assert.equal(await readAll(watched), 12);
  assert.equal(successes, 1);
  assert.equal(failures.length, 0);
  assert.equal(controller.signal.aborted, false);
});

test("a watched body that stalls is cut off, aborted upstream and counted", async () => {
  const { body, seen } = upstream(1, { stall: true });
  const failures: unknown[] = [];
  let successes = 0;
  const controller = new AbortController();
  const watched = worker.watchedBody(
    body,
    controller,
    20,
    (e) => failures.push(e),
    () => {
      successes++;
    },
  );
  await assert.rejects(readAll(watched), /next chunk/);
  assert.equal(failures.length, 1);
  assert.equal(successes, 0);
  assert.equal(controller.signal.aborted, true, "the fetch behind it is torn down");
  assert.equal(seen.cancelled, true);
});

test("an upstream error mid-body is a failure", async () => {
  const { body } = upstream(1, { fail: true });
  const failures: unknown[] = [];
  const watched = worker.watchedBody(body, new AbortController(), 1_000, (e) => failures.push(e));
  await assert.rejects(readAll(watched), /connection reset/);
  assert.equal(failures.length, 1);
});

test("the element letting go cancels the upstream, and is no failure", async () => {
  for (const readFirst of [true, false]) {
    const { body, seen } = upstream(100, { stall: !readFirst });
    const failures: unknown[] = [];
    let successes = 0;
    const controller = new AbortController();
    const watched = worker.watchedBody(
      body,
      controller,
      1_000,
      (e) => failures.push(e),
      () => {
        successes++;
      },
    );
    const reader = watched.getReader();
    if (readFirst) await reader.read();
    await reader.cancel();
    assert.equal(seen.cancelled, true);
    assert.equal(controller.signal.aborted, true);
    assert.equal(failures.length, 0);
    // Bytes that flowed before the cancel vouch for the path; none do not.
    assert.equal(successes, readFirst ? 1 : 0);
  }
});

test("a watched body reads ahead by no more than a chunk or two", async () => {
  const { body, seen } = upstream(1_000);
  const watched = worker.watchedBody(body, new AbortController(), 1_000, () => {});
  const reader = watched.getReader();
  await reader.read();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.ok(seen.pulls <= 3, `pulled ${seen.pulls} chunks for 1 read`);
  await reader.cancel();
});

test("the first claim on a clip's side wins, and later claims learn which side to follow", () => {
  type Side = "worker" | "network";
  // A tile's range failed fast to the network; the lightbox's slower range
  // then succeeded through the worker — it must follow the network.
  const sides = new Map<string, Side>();
  assert.equal(worker.claimSide<Side>(sides, "clip", "network", 10), "network");
  assert.equal(worker.claimSide<Side>(sides, "clip", "worker", 10), "network");
  assert.equal(sides.get("clip"), "network");
  // The reverse order: the worker answered first, a late failure may not go
  // to the network.
  assert.equal(worker.claimSide<Side>(sides, "other", "worker", 10), "worker");
  assert.equal(worker.claimSide<Side>(sides, "other", "network", 10), "worker");

  // A claim refreshes the key's place in the LRU whichever side holds.
  const lru = new Map<string, Side>();
  worker.claimSide<Side>(lru, "a", "network", 2);
  worker.claimSide<Side>(lru, "b", "worker", 2);
  worker.claimSide<Side>(lru, "a", "worker", 2); // loses, but a is now the most recent
  worker.claimSide<Side>(lru, "c", "worker", 2);
  assert.deepEqual(
    [...lru],
    [
      ["a", "network"],
      ["c", "worker"],
    ],
  );
});
