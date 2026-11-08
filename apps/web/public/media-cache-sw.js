/**
 * Local media cache: every image and clip from the media CDN, kept on this
 * device so the second look at anything is a disk read.
 *
 * The browser's own HTTP cache is not enough. The media CDN answers
 * `Cache-Control: max-age=14400` with no validator, so after four hours a clip
 * is downloaded again in full, and the HTTP cache evicts big media whenever it
 * likes anyway. This worker owns its storage (Cache Storage, persistent, with
 * its own LRU in IndexedDB) and answers the media element itself.
 *
 * Four constraints shape it:
 *
 * - The media CDN sends no CORS headers, so the worker cannot read a response
 *   it fetches from there — it would be opaque, and an opaque body cannot be
 *   stored usefully or sliced into ranges. It downloads through the same-origin
 *   rewrite `/media/*` instead (next.config.ts), which is the same object.
 * - A <video> asks for byte ranges, and Chromium refuses to play a resource
 *   whose ranges come from different origins. A response the worker builds
 *   itself (`new Response(...)`) carries no origin of its own, while one it
 *   hands on from `fetch(request)` carries the CDN's. So once the worker
 *   has answered a clip with a response it built, every later range of that
 *   clip must be one it built too: from the cache, from a download in memory,
 *   or — on a miss — the requested range fetched through `/media/*` and its
 *   body re-wrapped. The reverse holds as well, so the worker remembers which
 *   side answered each clip (`clipSources`): only a clip's first answer may
 *   fall back to `fetch(request)`; after that a failure is an error the
 *   worker builds, and the bypass leaves the clip with the worker.
 * - It must not spend bandwidth nobody asked for. A grid of
 *   `<video preload="metadata">` tiles asks for the first range of every clip
 *   near the viewport; v0.16.2.0 turned each of those into a full download,
 *   held in worker memory, that outlived the tile and the page and shared the
 *   app origin's connection with every navigation and API call. So a clip is
 *   downloaded whole only when the page asks for it (a prefetch: hovering it,
 *   or a result that just finished). Otherwise each range is passed through
 *   as asked, and an element that lets go cancels the upstream fetch with it.
 * - Nothing may wait forever. Every fetch has a deadline, a stall counts as a
 *   failure, and enough failures in a row switch the worker off for a while.
 *
 * Everything that is not a media original never reaches the fetch handler:
 * `install` registers static routes (Chromium's ServiceWorker Static Routing
 * API) that send the app's own requests and `cdn-cgi/` previews straight to
 * the network, so a navigation does not first wait for an idle worker to boot.
 *
 * Registered by apps/web/lib/media-cache.ts with the CDN base in `?media=`.
 * Plain JS on purpose: it is served as-is from public/, and the pure helpers at
 * the top are exported for media-cache-sw.test.ts.
 */

const CACHE_NAME = "artsnack-media-v1";
const DB_NAME = "artsnack-media-cache";
const STORE = "entries";

const MiB = 1024 ** 2;
const GiB = 1024 ** 3;
/** Ceiling on the whole cache; the browser's quota can lower it further. */
const MAX_CACHE_BYTES = 20 * GiB;
/**
 * Bigger objects stream through without being kept. A download is held in
 * worker memory until it is stored, and two prefetches can run at once, so
 * this is also roughly half the worker's worst-case footprint.
 */
const MAX_ENTRY_BYTES = 512 * MiB;
/** Eviction stops once the cache is back under this share of the ceiling. */
const TRIM_TARGET = 0.9;
const PREFETCH_CONCURRENCY = 2;
/**
 * Prefetches waiting their turn. Newest first: the result just hovered is the
 * likeliest click, and one hovered a minute ago is not worth its bandwidth.
 */
const PREFETCH_QUEUE_LIMIT = 16;
/**
 * A range that starts this far past what a download has received is fetched
 * on its own rather than waited for: a clip with its index at the end, or a
 * seek, would otherwise wait for the whole download to get there.
 */
const AHEAD_BYTES = 2 * MiB;
const HEADERS_TIMEOUT_MS = 15_000;
/** Longest silence between two chunks of a body before it counts as stalled. */
const IDLE_TIMEOUT_MS = 20_000;
const PROBE_TIMEOUT_MS = 10_000;
/**
 * How long a download the page started (an original image) survives once
 * nobody reads it — long enough for a re-render to pick it up again.
 */
const ABANDON_GRACE_MS = 3_000;
/** A cache hit refreshes its LRU timestamp at most this often. */
const TOUCH_INTERVAL_MS = 60_000;
/** After this many downloads fail in a row, stop intercepting for a while. */
const FAILURES_BEFORE_BYPASS = 3;
const BYPASS_MS = 10 * 60_000;
/** Clips whose answering side (worker or network) is remembered; see `clipSources`. */
const CLIP_SOURCE_LIMIT = 500;

/**
 * Parses a Range header. `null` means no header (the whole object); `undefined`
 * means a form this worker does not serve (multipart), which goes to the network.
 * A suffix range (`bytes=-500`) has `start: null`.
 *
 * @param {string | null} header
 * @returns {{ start: number | null, end: number | null } | null | undefined}
 */
function parseRange(header) {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return undefined;
  const [, startText, endText] = match;
  if (startText === "" && endText === "") return undefined;
  return {
    start: startText === "" ? null : Number(startText),
    end: endText === "" ? null : Number(endText),
  };
}

/**
 * Turns a parsed range into inclusive byte offsets for an object of `total`
 * bytes, or `null` when it cannot be satisfied (answered with 416).
 *
 * @param {{ start: number | null, end: number | null }} range
 * @param {number} total
 */
function resolveRange(range, total) {
  let start;
  let end;
  if (range.start === null) {
    if (!range.end) return null;
    start = Math.max(0, total - range.end);
    end = total - 1;
  } else {
    start = range.start;
    end = range.end === null ? total - 1 : Math.min(range.end, total - 1);
  }
  if (start >= total || start > end) return null;
  return { start, end };
}

/**
 * Least recently used first, until the total is back under `target` — but only
 * when it is over `limit`. Returns the URLs to delete.
 *
 * @param {{ url: string, size: number, used: number }[]} entries
 * @param {number} limit
 * @param {number} target
 */
function planEviction(entries, limit, target) {
  let total = entries.reduce((sum, entry) => sum + entry.size, 0);
  if (total <= limit) return [];
  const victims = [];
  for (const entry of [...entries].sort((a, b) => a.used - b.used)) {
    if (total <= target) break;
    victims.push(entry.url);
    total -= entry.size;
  }
  return victims;
}

/** Media types worth keeping; anything else (an HTML error page) is not. */
function isMediaType(contentType) {
  return /^(image|video|audio)\//i.test(contentType ?? "");
}

/**
 * The cache key for a URL this worker handles, or null to leave it alone.
 *
 * `/cdn-cgi/` is Cloudflare's own image and media transformation — the grid's
 * thumbnails and posters. They are small, rendered and cached at the edge
 * nearest the viewer (a few ms away), and they are not the object the key
 * names. Routed through `/media/*` they would go via Vercel's region instead,
 * to a colder Cloudflare cache, for no gain.
 *
 * @param {string} rawUrl
 * @param {string | null} mediaOrigin
 */
function mediaKeyFor(rawUrl, mediaOrigin) {
  if (!mediaOrigin) return null;
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }
  if (url.origin !== mediaOrigin || url.pathname.startsWith("/cdn-cgi/")) return null;
  url.hash = "";
  return url.href;
}

/**
 * Whether a request is a media element reading a clip: those ask in ranges
 * and are never downloaded whole on their own account. An `<img>` (or a
 * plain fetch) asks for the whole object.
 *
 * @param {string} destination Request.destination
 * @param {{ start: number | null, end: number | null } | null} range
 */
function isClipRequest(destination, range) {
  return range !== null || destination === "video" || destination === "audio";
}

/**
 * Whether a range starting at `start` is too far past a download's front to
 * wait for. Exactly `slack` bytes ahead still waits.
 *
 * @param {number} start
 * @param {number} received
 * @param {number} slack
 */
function rangeIsAhead(start, received, slack) {
  return start > received + slack;
}

/**
 * The prefetch queue after a new request: its keys first, in the order given
 * (the page sends newest first), then whatever was already waiting, without
 * duplicates, cut to `limit` — the oldest wishes are the ones dropped.
 *
 * @param {readonly string[]} queue
 * @param {readonly string[]} keys
 * @param {number} limit
 */
function queuePrefetch(queue, keys, limit) {
  const next = [];
  const seen = new Set();
  for (const key of [...keys, ...queue]) {
    if (seen.has(key)) continue;
    seen.add(key);
    next.push(key);
  }
  return next.slice(0, limit);
}

/**
 * Headers for a range passed through from `/media/*`: only the ones a media
 * element reads, restated, because the upstream's carry Vercel's and
 * Cloudflare's own (cache status, cookies, timing) that mean nothing here. A
 * 206 that lost its Content-Length on the way is given one from its range.
 *
 * @param {Headers} upstream
 */
function passThroughHeaders(upstream) {
  const headers = new Headers();
  const contentType = upstream.get("content-type");
  if (contentType) headers.set("Content-Type", contentType);
  const contentRange = upstream.get("content-range");
  if (contentRange) headers.set("Content-Range", contentRange);
  let length = upstream.get("content-length");
  if (!length && contentRange) {
    const match = /^bytes (\d+)-(\d+)\//.exec(contentRange.trim());
    if (match) length = String(Number(match[2]) - Number(match[1]) + 1);
  }
  if (length) headers.set("Content-Length", length);
  headers.set("Accept-Ranges", upstream.get("accept-ranges") ?? "bytes");
  return headers;
}

/**
 * URLPattern inits for the static routes: the media origin's `cdn-cgi/`
 * previews, and the media origin as a whole (whose complement — the app's own
 * requests — goes to the network too). Unset components are wildcards.
 *
 * @param {string} mediaOrigin
 */
function routePatterns(mediaOrigin) {
  const media = new URL(mediaOrigin);
  const origin = {
    protocol: media.protocol.replace(/:$/, ""),
    hostname: media.hostname,
    port: media.port,
  };
  return { cdnCgi: { ...origin, pathname: "/cdn-cgi/*" }, media: origin };
}

/**
 * `promise`, unless `ms` pass first or `controller` is aborted for any other
 * reason; a timeout aborts `controller`, which tears down the fetch behind it.
 * Racing the signal as well means an abort ends the wait even where a body
 * stream does not honour it.
 *
 * @template T
 * @param {Promise<T>} promise
 * @param {number} ms
 * @param {AbortController} controller
 * @param {string} what
 * @returns {Promise<T>}
 */
function deadline(promise, ms, controller, what) {
  const signal = controller.signal;
  let timer = null;
  let onAbort = () => {};
  const guard = new Promise((_, reject) => {
    onAbort = () => reject(signal.reason ?? new Error("aborted"));
    if (signal.aborted) return onAbort();
    signal.addEventListener("abort", onAbort, { once: true });
    timer = setTimeout(() => controller.abort(new Error(`timed out waiting for ${what}`)), ms);
  });
  return Promise.race([promise, guard]).finally(() => {
    clearTimeout(timer);
    signal.removeEventListener("abort", onAbort);
  });
}

/**
 * Records `value` for `key` in an insertion-ordered Map used as an LRU: the
 * key moves to the newest end, and the oldest beyond `limit` are forgotten.
 *
 * @template V
 * @param {Map<string, V>} map
 * @param {string} key
 * @param {V} value
 * @param {number} limit
 */
function remember(map, key, value, limit) {
  map.delete(key);
  map.set(key, value);
  while (map.size > limit) map.delete(map.keys().next().value);
  return map;
}

/**
 * Pins `key` to `side` unless it is pinned already, and returns the side that
 * holds: the first claim wins, and a later one learns which side it must
 * follow instead. Refreshes the key's place in the LRU either way. Being
 * synchronous, a claim made right before a response is returned cannot be
 * overtaken by another request's.
 *
 * @template {string} S
 * @param {Map<string, S>} map
 * @param {string} key
 * @param {S} side
 * @param {number} limit
 * @returns {S}
 */
function claimSide(map, key, side, limit) {
  const held = map.get(key) ?? side;
  remember(map, key, held, limit);
  return held;
}

/**
 * `body` handed on chunk for chunk, with a deadline on every read from
 * upstream — a range can arrive with prompt headers and then stall, and a body
 * passed through untouched would hang the element with no timer left to
 * notice. Holds at most the chunk in hand. Only a read the consumer is waiting
 * for runs against the clock, so an element that stops pulling (buffer full,
 * paused) is not mistaken for a stall.
 *
 * A stall or an upstream error aborts `controller` (the fetch behind `body`),
 * reports through `onFailure`, and errors the stream. The consumer cancelling
 * reaches the network the same way, without counting as a failure.
 * `onSuccess` is the body arriving whole, or the consumer letting go after
 * bytes did flow (a tile that has its metadata) — not the headers alone,
 * which a path that stalls every body still sends promptly.
 *
 * @param {ReadableStream<Uint8Array>} body
 * @param {AbortController} controller
 * @param {number} ms
 * @param {(error: unknown) => void} onFailure
 * @param {() => void} [onSuccess]
 */
function watchedBody(body, controller, ms, onFailure, onSuccess = () => {}) {
  const reader = body.getReader();
  let cancelled = false;
  let flowed = false;
  return new ReadableStream({
    pull: async (out) => {
      let result;
      try {
        result = await deadline(reader.read(), ms, controller, "the next chunk");
      } catch (error) {
        if (cancelled) return;
        controller.abort(error);
        void reader.cancel(error).catch(() => {});
        onFailure(error);
        out.error(error);
        return;
      }
      if (cancelled) return;
      if (result.done) {
        onSuccess();
        out.close();
        return;
      }
      flowed = true;
      out.enqueue(result.value);
    },
    cancel: (reason) => {
      cancelled = true;
      if (flowed) onSuccess();
      controller.abort(reason ?? new Error("the page cancelled the body"));
      return reader.cancel(reason).catch(() => {});
    },
  });
}

const IS_WORKER =
  typeof ServiceWorkerGlobalScope !== "undefined" && self instanceof ServiceWorkerGlobalScope;
/**
 * Only a registration that asks for the cache (`enabled=1`, written by
 * lib/media-cache.ts when NEXT_PUBLIC_MEDIA_CACHE=on) runs it. Every other copy
 * of this script — in particular the registrations installed by 0.16.2.x,
 * which carry no such parameter — retires on its next update check: it stops
 * intercepting, frees the cache and the LRU index, and unregisters itself.
 *
 * Why it is off: the worker can only read media through the same-origin
 * `/media/*` rewrite, and Vercel's proxy streams from the media CDN at roughly
 * 70 KB/s (a 2 MB clip took 26–29 s, against 0.5 s from the CDN directly). With
 * a grid of clips that was minutes of spinners, and the slow streams shared the
 * page's own connection. It can come back once the media CDN sends CORS headers
 * and the worker fetches the CDN directly.
 */
const WORKER_ENABLED = IS_WORKER && new URL(self.location.href).searchParams.get("enabled") === "1";

if (IS_WORKER && !WORKER_ENABLED) {
  self.addEventListener("install", () => self.skipWaiting());
  self.addEventListener("activate", (event) => {
    event.waitUntil(
      (async () => {
        await self.clients.claim().catch(() => {});
        const names = await caches.keys().catch(() => []);
        await Promise.all(
          names
            .filter((name) => name.startsWith("artsnack-media-"))
            .map((name) => caches.delete(name).catch(() => false)),
        );
        await new Promise((resolve) => {
          const request = indexedDB.deleteDatabase(DB_NAME);
          request.onsuccess = request.onerror = request.onblocked = () => resolve(undefined);
        });
        await self.registration.unregister().catch(() => false);
      })(),
    );
  });
}

if (WORKER_ENABLED) {
  const mediaParam = new URL(self.location.href).searchParams.get("media");
  const MEDIA_ORIGIN = mediaParam ? new URL(mediaParam).origin : null;

  /** @type {Map<string, Download>} */
  const downloads = new Map();
  /**
   * Bumped by "clear". A download started before it still serves its readers
   * from memory but is not stored, so a clear stays a clear.
   */
  let cacheEpoch = 0;
  /** @type {Map<string, number>} */
  const lastTouched = new Map();
  let consecutiveFailures = 0;
  let bypassUntil = 0;
  let trimTimer = null;
  /**
   * Which side answered each clip: "worker" once it got a response the
   * worker built, "network" once one came from `fetch(request)` or the worker
   * stepped aside for it. Chromium (the HTML "verify a media response" step)
   * rejects a media resource whose ranges mix the two, so a clip stays with
   * the side its first answer came from: a "worker" clip is never handed to
   * the network or skipped by the bypass, and a "network" clip is never
   * intercepted again.
   *
   * The pin is taken by `claim`, synchronously, right before any clip answer
   * goes out; an answer whose claim loses (another range of the clip settled
   * first, on the other side) is dropped — its upstream cancelled — and
   * replaced by one from the pinned side. `respond` also makes concurrent
   * first ranges wait for one leader rather than race, so normally there is
   * nothing to drop.
   *
   * Caveat: this lives in memory only. When the browser stops an idle worker
   * (Chromium does after ~30 s without events) the map is lost, and the next
   * range of a clip still on screen is treated as a first contact — its normal
   * answer is still one the worker builds, so only a failure in that window,
   * or the bypass, can still mix. Persisting it would put an IndexedDB read in
   * front of every range.
   *
   * @type {Map<string, "worker" | "network">}
   */
  const clipSources = new Map();
  /** @param {"worker" | "network"} side */
  const claim = (key, side) => claimSide(clipSources, key, side, CLIP_SOURCE_LIMIT);
  /**
   * The answer in progress for each clip that has no side yet: the first
   * contact that will pin it. Other ranges of the clip wait for it.
   *
   * @type {Map<string, Promise<Response>>}
   */
  const firstContacts = new Map();

  const mediaKey = (rawUrl) => mediaKeyFor(rawUrl, MEDIA_ORIGIN);

  /** Where the worker downloads a media URL from: the same-origin rewrite. */
  const fillUrl = (key) => {
    const url = new URL(key);
    return `${self.location.origin}/media${url.pathname}${url.search}`;
  };

  /**
   * A failure of the download path itself — the rewrite erroring, stalling,
   * answering with something that is not media. Enough in a row and the
   * worker steps aside, so a broken rewrite costs a few slow loads, not all.
   */
  const noteFailure = () => {
    consecutiveFailures += 1;
    if (consecutiveFailures >= FAILURES_BEFORE_BYPASS) bypassUntil = Date.now() + BYPASS_MS;
  };
  const noteSuccess = () => {
    consecutiveFailures = 0;
  };

  // ---- LRU bookkeeping (IndexedDB) ----------------------------------------

  let dbPromise = null;
  const db = () => {
    dbPromise ??= new Promise((resolve, reject) => {
      const open = indexedDB.open(DB_NAME, 1);
      open.onupgradeneeded = () => open.result.createObjectStore(STORE, { keyPath: "url" });
      open.onsuccess = () => {
        const database = open.result;
        // The browser can close the connection (site data cleared); the next
        // call opens a fresh one instead of failing on the dead one forever.
        database.onclose = () => {
          dbPromise = null;
        };
        resolve(database);
      };
      open.onerror = () => reject(open.error);
    }).catch((error) => {
      // A failed open is not remembered: the next call tries again.
      dbPromise = null;
      throw error;
    });
    return dbPromise;
  };

  const idb = async (mode, run) => {
    const database = await db();
    return new Promise((resolve, reject) => {
      const tx = database.transaction(STORE, mode);
      const request = run(tx.objectStore(STORE));
      tx.oncomplete = () => resolve(request?.result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  };

  const record = (url, size) =>
    idb("readwrite", (store) => store.put({ url, size, used: Date.now() })).catch(() => {});

  const touch = (url, size) => {
    const now = Date.now();
    if (now - (lastTouched.get(url) ?? 0) < TOUCH_INTERVAL_MS) return;
    lastTouched.set(url, now);
    void record(url, size);
  };

  const allEntries = () => idb("readonly", (store) => store.getAll()).catch(() => []);

  const cacheLimit = async () => {
    const quota = (await navigator.storage?.estimate?.().catch(() => null))?.quota;
    return quota ? Math.min(MAX_CACHE_BYTES, quota * 0.6) : MAX_CACHE_BYTES;
  };

  const trim = async (limit) => {
    const cap = limit ?? (await cacheLimit());
    const victims = planEviction(await allEntries(), cap, cap * TRIM_TARGET);
    if (victims.length === 0) return;
    const cache = await caches.open(CACHE_NAME);
    for (const url of victims) {
      await cache.delete(url);
      await idb("readwrite", (store) => store.delete(url)).catch(() => {});
      lastTouched.delete(url);
    }
  };

  const scheduleTrim = () => {
    if (trimTimer) return;
    trimTimer = setTimeout(() => {
      trimTimer = null;
      void trim().catch(() => {});
    }, 5_000);
  };

  // ---- Downloads ----------------------------------------------------------

  /**
   * One whole object being downloaded through the rewrite — an original image
   * the page asked for, or a prefetch. Readers stream ranges out of `chunks`
   * as they arrive; when the last byte is in, the whole thing goes into Cache
   * Storage and the Download is forgotten.
   */
  class Download {
    /**
     * @param {string} key
     * @param {string | null} accept
     * @param {boolean} keep A prefetch: runs to the end even with nobody
     *   reading, since filling the cache is its whole point. A download the
     *   page started is abandoned once its readers have all gone.
     */
    constructor(key, accept, keep) {
      this.key = key;
      this.accept = accept;
      this.keep = keep;
      /** @type {Uint8Array[]} */
      this.chunks = [];
      /** Byte offset where each chunk starts. */
      this.offsets = [];
      this.received = 0;
      /** @type {number | null} */
      this.total = null;
      this.contentType = "application/octet-stream";
      /** @type {"pending" | "streaming" | "done" | "failed"} */
      this.state = "pending";
      /**
       * Cleared for an ending that says nothing about the download path — an
       * object that does not exist, one too big to keep, or one nobody wanted
       * any more — so it does not count toward switching the worker off.
       */
      this.pathFailure = true;
      /** Responses reading from this download, or about to. */
      this.readers = 0;
      this.abandonTimer = null;
      /** Out of `downloads` for good: no reader can join any more. */
      this.settled = false;
      /** @type {(() => void)[]} */
      this.waiters = [];
      /** @type {Promise<void> | null} */
      this.totalProbe = null;
      this.probed = false;
      this.epoch = cacheEpoch;
      this.controller = new AbortController();
      this.finished = this.run();
    }

    /** Resolves on the next change of `received`, `state`, or `total`. */
    changed() {
      return new Promise((resolve) => this.waiters.push(resolve));
    }

    /**
     * Resolves once `test()` holds. Every wait is bounded by the download's
     * own deadlines: a stall ends it as "failed", which wakes everyone.
     */
    async until(test) {
      while (!test()) await this.changed();
    }

    notify() {
      const waiters = this.waiters;
      this.waiters = [];
      for (const resolve of waiters) resolve();
    }

    /** A reader joins. Returns its (idempotent) way out. */
    attach() {
      this.readers += 1;
      clearTimeout(this.abandonTimer);
      this.abandonTimer = null;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        this.readers -= 1;
        if (this.readers > 0) return;
        this.releaseMemory();
        if (this.keep || this.state === "done" || this.state === "failed") return;
        this.abandonTimer = setTimeout(() => {
          this.abandonTimer = null;
          if (this.readers === 0 && !this.keep) this.abort("abandoned: nobody is reading it");
        }, ABANDON_GRACE_MS);
      };
    }

    /** Stops a download that is not the path's fault (abandoned, cleared). */
    abort(reason) {
      if (this.state === "done" || this.state === "failed") return;
      this.pathFailure = false;
      this.controller.abort(new Error(reason));
    }

    releaseMemory() {
      if (!this.settled || this.readers > 0) return;
      this.chunks = [];
      this.offsets = [];
    }

    /** Out of `downloads` — unless a newer download for the key replaced it. */
    settle() {
      this.settled = true;
      if (downloads.get(this.key) === this) downloads.delete(this.key);
      this.releaseMemory();
    }

    async run() {
      const controller = this.controller;
      let reader = null;
      try {
        const response = await deadline(
          fetch(fillUrl(this.key), {
            headers: this.accept ? { Accept: this.accept } : {},
            signal: controller.signal,
            // A prefetch is a guess; it must not hold up what is on screen.
            ...(this.keep ? { priority: "low" } : {}),
          }),
          HEADERS_TIMEOUT_MS,
          controller,
          "response headers",
        );
        const contentType = response.headers.get("content-type");
        if (response.status !== 200 || !response.body || !isMediaType(contentType)) {
          void response.body?.cancel().catch(() => {});
          if (response.status >= 400 && response.status < 500) this.pathFailure = false;
          throw new Error(`fill answered ${response.status} ${contentType}`);
        }
        const length = Number(response.headers.get("content-length"));
        this.total = Number.isFinite(length) && length > 0 ? length : null;
        if (this.total !== null && this.total > MAX_ENTRY_BYTES) {
          // Too big to hold in memory or keep; readers go elsewhere.
          void response.body.cancel().catch(() => {});
          this.pathFailure = false;
          throw new Error(`too big to cache: ${this.total} bytes`);
        }
        this.contentType = contentType;
        this.state = "streaming";
        this.notify();

        reader = response.body.getReader();
        for (;;) {
          const { done, value } = await deadline(
            reader.read(),
            IDLE_TIMEOUT_MS,
            controller,
            "the next chunk",
          );
          if (done) break;
          if (this.received + value.byteLength > MAX_ENTRY_BYTES) {
            // A chunked body says its size only by running past the limit;
            // stop buffering there rather than hold it all in memory.
            this.pathFailure = false;
            throw new Error(`too big to cache: over ${MAX_ENTRY_BYTES} bytes`);
          }
          this.offsets.push(this.received);
          this.chunks.push(value);
          this.received += value.byteLength;
          this.notify();
        }
        if (this.total !== null && this.received !== this.total) {
          throw new Error(`short body: ${this.received} of ${this.total}`);
        }
        this.total = this.received;
        this.state = "done";
        noteSuccess();
        this.notify();
      } catch (error) {
        controller.abort(error);
        void reader?.cancel().catch(() => {});
        this.state = "failed";
        // Out at once, so the next request starts afresh instead of joining
        // the corpse.
        this.settle();
        if (this.pathFailure) noteFailure();
        console.warn("[media-cache] download failed", this.key, error);
        this.notify();
        return;
      }
      // Stays in `downloads` until stored, so a request in between is still
      // answered from memory rather than starting the download over.
      if (this.epoch === cacheEpoch) {
        await this.store().catch((error) => console.warn("[media-cache] not stored", error));
      }
      this.settle();
    }

    /**
     * Learns the object's size when the body arrives chunked, without a
     * Content-Length: a one-byte range answers it in its Content-Range. Only a
     * range request needs it (an image does not); without it, the range could
     * be answered only once the whole download was in.
     */
    ensureTotal() {
      this.totalProbe ??= (async () => {
        const controller = new AbortController();
        try {
          const response = await deadline(
            fetch(fillUrl(this.key), {
              headers: { Range: "bytes=0-0" },
              signal: controller.signal,
            }),
            PROBE_TIMEOUT_MS,
            controller,
            "the size probe",
          );
          void response.body?.cancel().catch(() => {});
          const contentRange = response.headers.get("content-range") ?? "";
          const total = Number(/\/(\d+)\s*$/.exec(contentRange)?.[1]);
          if (response.status === 206 && total > 0 && this.total === null) this.total = total;
        } catch {
          // The reader waiting on it passes its range through instead.
          controller.abort();
        } finally {
          this.probed = true;
          this.notify();
        }
      })();
      return this.totalProbe;
    }

    async store() {
      const body = new Blob(this.chunks, { type: this.contentType });
      const entry = () =>
        new Response(body, {
          headers: { "Content-Type": this.contentType, "Content-Length": String(body.size) },
        });
      const put = (cache) =>
        cache.put(this.key, entry()).then(
          () => true,
          () => false,
        );
      const cache = await caches.open(CACHE_NAME);
      if (this.epoch !== cacheEpoch) return; // cleared while the cache opened
      let stored = await put(cache);
      if (!stored) {
        // Over quota: make room for this one and try once more.
        await trim((await cacheLimit()) - body.size).catch(() => {});
        if (this.epoch !== cacheEpoch) return;
        stored = await put(cache);
      }
      // An LRU row for an object that is not in the cache would count toward
      // the size forever and evict real entries to make room for nothing.
      if (!stored) return;
      await record(this.key, body.size);
      scheduleTrim();
    }

    /**
     * A stream of bytes [start, end] (end inclusive; null = to the end),
     * yielding each piece as soon as it has been downloaded. Calls `release`
     * however it ends — read to the end, failed, or cancelled by the page.
     */
    stream(start, end, release) {
      let position = start;
      let index = 0;
      return new ReadableStream({
        pull: async (controller) => {
          for (;;) {
            const last = end ?? (this.state === "done" ? this.received - 1 : Infinity);
            if (position > last) {
              release();
              controller.close();
              return;
            }
            if (position < this.received) {
              while (index + 1 < this.chunks.length && this.offsets[index + 1] <= position) index++;
              const chunk = this.chunks[index];
              const from = position - this.offsets[index];
              const to = Math.min(chunk.byteLength, last - this.offsets[index] + 1);
              controller.enqueue(chunk.subarray(from, to));
              position += to - from;
              return;
            }
            if (this.state === "failed") {
              release();
              controller.error(new Error("media download failed"));
              return;
            }
            await this.changed();
          }
        },
        cancel: () => release(),
      });
    }
  }

  const startDownload = (key, accept, keep) => {
    let download = downloads.get(key);
    if (!download) {
      download = new Download(key, accept, keep);
      downloads.set(key, download);
    }
    return download;
  };

  // ---- Responses ----------------------------------------------------------

  const headersFor = (contentType, length, extra) => {
    const headers = new Headers({ "Content-Type": contentType, "Accept-Ranges": "bytes" });
    if (length !== null) headers.set("Content-Length", String(length));
    for (const [name, value] of Object.entries(extra ?? {})) headers.set(name, value);
    return headers;
  };

  const unsatisfiable = (total) =>
    new Response(null, { status: 416, headers: { "Content-Range": `bytes */${total}` } });

  const fromBlob = (blob, contentType, range) => {
    if (!range) return new Response(blob, { headers: headersFor(contentType, blob.size) });
    const bytes = resolveRange(range, blob.size);
    if (!bytes) return unsatisfiable(blob.size);
    return new Response(blob.slice(bytes.start, bytes.end + 1), {
      status: 206,
      headers: headersFor(contentType, bytes.end - bytes.start + 1, {
        "Content-Range": `bytes ${bytes.start}-${bytes.end}/${blob.size}`,
      }),
    });
  };

  /**
   * Exactly the range the element asked for, fetched through the rewrite and
   * handed on as it arrives. The response is one the worker built, so it mixes
   * with cache and download answers for the same clip; and its body pulls from
   * the upstream's own stream (watchedBody), so an element that lets go
   * cancels the fetch and a body that stalls is cut off. Nothing is kept.
   * Default priority: this is what is playing. Only ever called for clips.
   */
  const passThrough = async (request, key, retried = false) => {
    const controller = new AbortController();
    const signal = request.signal;
    const cancel = () => controller.abort(new Error("the page cancelled the request"));
    signal?.addEventListener?.("abort", cancel, { once: true });
    const headers = {};
    const range = request.headers.get("range");
    if (range) headers.Range = range;
    const accept = request.headers.get("accept");
    if (accept) headers.Accept = accept;
    let upstream;
    try {
      upstream = await deadline(
        fetch(fillUrl(key), { headers, signal: controller.signal }),
        HEADERS_TIMEOUT_MS,
        controller,
        "response headers",
      );
    } catch (error) {
      if (signal?.aborted) throw error; // nobody left to answer
      signal?.removeEventListener?.("abort", cancel);
      noteFailure();
      console.warn("[media-cache] pass-through failed", key, error);
      return clipFallback(request, key, retried);
    }
    // From here the body is the page's to cancel, and cancelling it ends
    // the fetch; the signal only covered the wait for headers.
    signal?.removeEventListener?.("abort", cancel);
    const { status } = upstream;
    const media = (status === 200 || status === 206) && upstream.body !== null;
    // Success is judged by the body (watchedBody), not by these headers.
    if (!(media && isMediaType(upstream.headers.get("content-type"))) && status !== 416) {
      // A 4xx is usually the object's own answer (the network will repeat it)
      // but can be Next's 404 for a rewrite that is gone, so it is not trusted
      // and not counted; a 5xx, or an error page dressed as 200, means the
      // rewrite is unwell and counts toward the bypass. A 416 is handed on: it
      // is the object's answer to this range, whoever relayed it.
      void upstream.body?.cancel().catch(() => {});
      if (!(status >= 400 && status < 500)) noteFailure();
      console.warn("[media-cache] pass-through answered", status, key);
      return clipFallback(request, key, retried);
    }
    if (claim(key, "worker") !== "worker") {
      // Another range of this clip went to the network while this one waited
      // for headers, so this one goes there too.
      controller.abort(new Error("the clip is pinned to the network"));
      void upstream.body?.cancel().catch(() => {});
      return fetch(request);
    }
    const body =
      upstream.body &&
      watchedBody(
        upstream.body,
        controller,
        IDLE_TIMEOUT_MS,
        (error) => {
          noteFailure();
          console.warn("[media-cache] pass-through body failed", key, error);
        },
        noteSuccess,
      );
    return new Response(body, {
      status,
      statusText: upstream.statusText,
      headers: passThroughHeaders(upstream.headers),
    });
  };

  /**
   * Where a clip goes when its pass-through failed. On first contact the
   * network is safe, and from then on it is the network's (see clipSources).
   * A clip the worker has already answered must not get a network response
   * now: it is tried once more, then failed with a 504 the worker built, so
   * the element errors cleanly — and can retry — rather than reject a mix.
   */
  const clipFallback = (request, key, retried) => {
    if (claim(key, "network") === "network") return fetch(request);
    if (!retried) return passThrough(request, key, true);
    return new Response(null, { status: 504, statusText: "Media cache: upstream unavailable" });
  };

  /**
   * Answers from a download in progress. Nothing goes out until the first
   * byte of the answer has arrived, so a download that fails before then is
   * replaced by an answer from elsewhere; one that fails mid-answer errors it.
   */
  const fromDownload = async (download, request, key, range, clip) => {
    const release = download.attach();
    // While this waits, a page that gives up must still let go of the
    // download; once a stream exists, its own cancel does that.
    const signal = request.signal;
    signal?.addEventListener?.("abort", release, { once: true });
    const answer = (start, end, init) => {
      signal?.removeEventListener?.("abort", release);
      if (clip && claim(key, "worker") !== "worker") {
        release();
        return fetch(request);
      }
      return new Response(download.stream(start, end, release), init);
    };
    const elsewhere = () => {
      release();
      return clip ? passThrough(request, key) : fetch(request);
    };
    const behind = (start) =>
      download.state !== "done" && rangeIsAhead(start, download.received, AHEAD_BYTES);

    if (range?.start != null && behind(range.start)) return elsewhere();
    await download.until(() => download.state !== "pending");
    if (download.state === "failed") return elsewhere();

    if (!range) {
      await download.until(() => download.received > 0 || download.state !== "streaming");
      if (download.state === "failed") return elsewhere();
      return answer(0, null, { headers: headersFor(download.contentType, download.total) });
    }

    // A range answer needs the total for its Content-Range — a 200 would also
    // do for "bytes=0-", but Chromium then treats the clip as unseekable. A
    // chunked body has no Content-Length, so ask for the size separately.
    if (download.total === null) {
      void download.ensureTotal();
      await download.until(
        () => download.total !== null || download.state !== "streaming" || download.probed,
      );
    }
    if (download.state === "failed" || download.total === null) return elsewhere();
    const total = download.total;
    const bytes = resolveRange(range, total);
    if (!bytes) {
      release();
      return claim(key, "worker") === "worker" ? unsatisfiable(total) : fetch(request);
    }
    if (behind(bytes.start)) return elsewhere();
    await download.until(() => download.received > bytes.start || download.state !== "streaming");
    if (download.state === "failed") return elsewhere();
    return answer(bytes.start, bytes.end, {
      status: 206,
      headers: headersFor(download.contentType, bytes.end - bytes.start + 1, {
        "Content-Range": `bytes ${bytes.start}-${bytes.end}/${total}`,
      }),
    });
  };

  const answerRequest = async (event, key, range, clip) => {
    const request = event.request;
    let download;
    try {
      if (!downloads.has(key)) {
        const hit = await (await caches.open(CACHE_NAME)).match(key);
        if (hit) {
          const size = Number(hit.headers.get("content-length")) || 0;
          touch(key, size);
          const type = hit.headers.get("content-type") ?? "application/octet-stream";
          const response = fromBlob(await hit.blob(), type, range);
          if (clip && claim(key, "worker") !== "worker") return fetch(request);
          return response;
        }
      }
      // A clip on screen is never downloaded whole on its own account: a
      // tile reads its first few hundred KB and lets go.
      download =
        downloads.get(key) ??
        (clip ? null : startDownload(key, request.headers.get("accept"), false));
    } catch (error) {
      console.warn("[media-cache] cache unavailable", key, error);
    }
    if (!download) return clip ? passThrough(request, key) : fetch(request);
    event.waitUntil(download.finished);
    return fromDownload(download, request, key, range, clip);
  };

  /**
   * Ranges of a clip that has no side yet share one decision: the first is
   * its first contact, the rest wait for that answer and then follow the side
   * it pinned. Otherwise a tile and the lightbox asking at once each pick a
   * side — one failing fast to the network while the other is still waiting
   * on the rewrite. (`claim` still settles any race this does not see.)
   */
  const respond = async (event, key, range, clip) => {
    if (!clip) return answerRequest(event, key, range, clip);
    for (;;) {
      const side = clipSources.get(key);
      if (side === "network") return fetch(event.request);
      if (side === "worker") return answerRequest(event, key, range, clip);
      const leader = firstContacts.get(key);
      if (!leader) break;
      // Settles once the leader has answered (and so pinned a side) or given
      // up; if it pinned nothing, the next waiter becomes the leader.
      await leader.catch(() => {});
    }
    const decision = answerRequest(event, key, range, clip);
    firstContacts.set(key, decision);
    decision
      .finally(() => {
        if (firstContacts.get(key) === decision) firstContacts.delete(key);
      })
      .catch(() => {});
    return decision;
  };

  // ---- Prefetch -----------------------------------------------------------

  /** Next to start first. */
  let prefetchQueue = [];
  /** @type {Promise<void> | null} */
  let pump = null;
  /** @type {(() => void) | null} */
  let wakePump = null;

  const prefetchOne = async (key) => {
    if (Date.now() < bypassUntil) return;
    const inFlight = downloads.get(key);
    if (inFlight) {
      inFlight.keep = true;
      return;
    }
    if (await (await caches.open(CACHE_NAME)).match(key)) return;
    const download = startDownload(key, null, true);
    download.keep = true;
    await download.finished;
  };

  /**
   * The one loop that starts prefetches. A slot is taken synchronously, before
   * anything is awaited, and given back in `finally` — so however many
   * messages arrive at once, no more than PREFETCH_CONCURRENCY run. Resolves
   * when the queue is empty and the last one has finished.
   */
  const runPrefetch = () => {
    pump ??= (async () => {
      /** @type {Set<Promise<void>>} */
      const active = new Set();
      try {
        for (;;) {
          while (active.size < PREFETCH_CONCURRENCY && prefetchQueue.length > 0) {
            const key = prefetchQueue.shift();
            const task = prefetchOne(key)
              .catch(() => {})
              .finally(() => active.delete(task));
            active.add(task);
          }
          if (active.size === 0) return;
          await Promise.race([...active, new Promise((resolve) => (wakePump = resolve))]);
          wakePump = null;
        }
      } finally {
        pump = null;
        wakePump = null;
      }
    })();
    return pump;
  };

  // ---- Events -------------------------------------------------------------

  self.addEventListener("install", (event) => {
    void self.skipWaiting();
    // Static routes send everything that is not a media original straight to
    // the network, without dispatching a fetch event — and so without waiting
    // for this worker to start after it went idle. Browsers without the API
    // (or without `not`) still reach the checks in the fetch handler.
    if (
      !MEDIA_ORIGIN ||
      typeof event.addRoutes !== "function" ||
      typeof URLPattern !== "function"
    ) {
      return;
    }
    const patterns = routePatterns(MEDIA_ORIGIN);
    // One call per rule: a condition this browser does not support rejects
    // only its own rule.
    const add = (rule) => {
      try {
        return Promise.resolve(event.addRoutes(rule())).catch((error) => {
          console.warn("[media-cache] static route not added", error);
        });
      } catch (error) {
        console.warn("[media-cache] static route not added", error);
        return Promise.resolve();
      }
    };
    event.waitUntil(
      Promise.all([
        add(() => ({
          condition: { urlPattern: new URLPattern(patterns.cdnCgi) },
          source: "network",
        })),
        add(() => ({
          condition: { not: { urlPattern: new URLPattern(patterns.media) } },
          source: "network",
        })),
      ]),
    );
  });

  self.addEventListener("activate", (event) => {
    event.waitUntil(
      (async () => {
        const names = await caches.keys();
        await Promise.all(
          names
            .filter((name) => name.startsWith("artsnack-media-") && name !== CACHE_NAME)
            .map((name) => caches.delete(name)),
        );
        await self.clients.claim();
      })(),
    );
  });

  self.addEventListener("fetch", (event) => {
    const request = event.request;
    if (request.method !== "GET") return;
    const key = mediaKey(request.url);
    if (!key) return;
    const range = parseRange(request.headers.get("range"));
    if (range === undefined) return;
    const clip = isClipRequest(request.destination, range);
    // A clip stays with the side that answered it first (see clipSources):
    // the bypass skips only what the worker has not answered yet, and not a
    // clip whose first range is still being answered — that one decides.
    const source = clip ? clipSources.get(key) : undefined;
    if (source === "network") {
      claim(key, "network");
      return;
    }
    if (source !== "worker" && Date.now() < bypassUntil) {
      if (!clip) return;
      if (!firstContacts.has(key)) {
        claim(key, "network");
        return;
      }
    }
    event.respondWith(respond(event, key, range, clip));
  });

  self.addEventListener("message", (event) => {
    const message = event.data ?? {};
    const reply = (value) => event.ports[0]?.postMessage(value);

    if (message.type === "prefetch" && Array.isArray(message.urls)) {
      if (Date.now() < bypassUntil) return;
      const keys = [];
      for (const url of message.urls) {
        const key = typeof url === "string" ? mediaKey(url) : null;
        if (!key) continue;
        // Already downloading: just make sure it is finished and kept.
        const inFlight = downloads.get(key);
        if (inFlight) inFlight.keep = true;
        else keys.push(key);
      }
      if (keys.length === 0) return;
      prefetchQueue = queuePrefetch(prefetchQueue, keys, PREFETCH_QUEUE_LIMIT);
      wakePump?.();
      event.waitUntil(runPrefetch());
    } else if (message.type === "stats") {
      event.waitUntil(
        (async () => {
          const entries = await allEntries();
          reply({
            bytes: entries.reduce((sum, entry) => sum + entry.size, 0),
            count: entries.length,
            limit: await cacheLimit(),
          });
        })(),
      );
    } else if (message.type === "clear") {
      event.waitUntil(
        (async () => {
          // Downloads in flight keep serving whoever is reading them, but
          // neither they nor the queued prefetches may refill the cache — and
          // one nobody is reading has no reason to go on.
          cacheEpoch += 1;
          prefetchQueue = [];
          for (const download of downloads.values()) {
            if (download.readers === 0) download.abort("the cache was cleared");
          }
          await caches.delete(CACHE_NAME);
          await idb("readwrite", (store) => store.clear()).catch(() => {});
          lastTouched.clear();
          reply({ ok: true });
        })(),
      );
    }
  });
}

if (typeof module === "object" && module.exports) {
  module.exports = {
    parseRange,
    resolveRange,
    planEviction,
    isMediaType,
    mediaKeyFor,
    isClipRequest,
    rangeIsAhead,
    queuePrefetch,
    passThroughHeaders,
    routePatterns,
    deadline,
    remember,
    claimSide,
    watchedBody,
  };
}
