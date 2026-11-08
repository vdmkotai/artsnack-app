import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { DEFAULT_SEARCH_INTENT, type SearchDocument } from "@/lib/search";
import {
  advanceSearchAuth,
  createSearchCatalogStore,
  createSearchViewCache,
  initialSearchAuth,
  mergeCatalogFeed,
  searchCatalogMayLoad,
  stabilizeCatalogDocuments,
  type SearchCatalogClock,
} from "@/lib/search-catalog";
import { TOP_SEARCH_SCROLL } from "@/lib/search-window";

function doc(id: string, createdAt: number, patch: Partial<SearchDocument> = {}): SearchDocument {
  return {
    id,
    source: "self-hosted",
    provider: "self-hosted",
    mediaType: "image",
    createdAt,
    prompt: `prompt ${id}`,
    assets: [{ id: "0", key: `${id}.webp` }],
    checkpoints: [],
    loras: [],
    hasReferences: false,
    ...patch,
  };
}

const copy = (documents: SearchDocument[]) => documents.map((document) => ({ ...document }));

function fakeClock() {
  let now = 0;
  let next = 1;
  const timers = new Map<number, { at: number; callback: () => void }>();
  const clock: SearchCatalogClock = {
    now: () => now,
    setTimeout(callback, ms) {
      const handle = next++;
      timers.set(handle, { at: now + ms, callback });
      return handle;
    },
    clearTimeout(handle) {
      timers.delete(handle as number);
    },
  };
  const advance = (ms: number) => {
    now += ms;
    for (const [handle, timer] of [...timers]) {
      if (timer.at <= now) {
        timers.delete(handle);
        timer.callback();
      }
    }
  };
  return { clock, advance, pending: () => timers.size };
}

describe("catalogue snapshot merge", () => {
  const retained = [doc("c", 30), doc("b", 20), doc("a", 10)];

  test("a finished feed is the whole truth", () => {
    const fresh = [doc("c", 30)];
    assert.equal(mergeCatalogFeed({ documents: fresh, done: true }, retained), fresh);
  });

  test("an empty, still-loading feed keeps the snapshot", () => {
    assert.equal(mergeCatalogFeed({ documents: [], done: false }, retained), retained);
  });

  test("fresh pages replace their region and the snapshot fills in the older rest", () => {
    const merged = mergeCatalogFeed(
      { documents: [doc("d", 40), doc("b", 20)], done: false },
      retained,
    );
    // c sits inside the fresh region but is no longer in it: deleted, so dropped.
    assert.deepEqual(
      merged.map((document) => document.id),
      ["d", "b", "a"],
    );
  });
});

describe("catalogue document identity", () => {
  test("reuses unchanged documents and the previous array", () => {
    const first = [doc("a", 1), doc("b", 2)];
    const known = new Map(first.map((document) => [document.id, document]));
    const same = stabilizeCatalogDocuments(known, first, copy(first));
    assert.equal(same.documents, first);

    const edited = [{ ...first[0] }, doc("b", 2, { prompt: "edited" })];
    const changed = stabilizeCatalogDocuments(known, first, edited);
    assert.notEqual(changed.documents, first);
    assert.equal(changed.documents[0], first[0]);
    assert.equal(changed.documents[1], edited[1]);
    assert.equal(changed.known.get("b"), edited[1]);
  });
});

describe("catalogue store", () => {
  const page = (documents: SearchDocument[], done = false) => ({ documents, done });

  test("throttles a catalogue that is still paging in, and publishes completion at once", () => {
    const { clock, advance, pending } = fakeClock();
    const store = createSearchCatalogStore(clock, 500);
    let notified = 0;
    store.subscribe(() => {
      notified += 1;
    });
    store.connect();
    notified = 0;

    const first = [doc("a", 3)];
    store.push({ local: page(first), hosted: page([]) });
    assert.equal(notified, 1, "the first page is shown immediately");
    assert.deepEqual(store.getSnapshot().documents, first);

    const second = [...first, doc("b", 2)];
    store.push({ local: page(second), hosted: page([]) });
    advance(100);
    const third = [...second, doc("c", 1)];
    store.push({ local: page(third), hosted: page([]) });
    assert.equal(notified, 1, "pages inside the throttle window wait");
    assert.equal(pending(), 1, "and share one timer");
    advance(400);
    assert.equal(notified, 2);
    assert.deepEqual(
      store.getSnapshot().documents.map((document) => document.id),
      ["a", "b", "c"],
    );

    advance(10);
    store.push({ local: page(third, true), hosted: page([doc("h", 5)], true) });
    assert.equal(notified, 3, "completion is not throttled");
    assert.equal(store.getSnapshot().loading, false);

    store.push({ local: page([doc("new", 9), ...third], true), hosted: page([doc("h", 5)], true) });
    assert.equal(notified, 4, "live changes after completion are not throttled");
  });

  test("keeps the documents as a snapshot across a released subscription", () => {
    const { clock } = fakeClock();
    const store = createSearchCatalogStore(clock, 500);
    const history = [doc("b", 2), doc("a", 1)];
    store.connect();
    store.push({ local: page(history, true), hosted: page([], true) });
    store.disconnect();
    const snapshot = store.getSnapshot();
    assert.equal(snapshot.loading, false);
    assert.deepEqual(snapshot.documents, history);

    store.connect();
    assert.equal(store.getSnapshot().refreshing, true);
    assert.equal(store.getSnapshot().documents, snapshot.documents);

    // The re-subscription starts from nothing; the snapshot stays on screen.
    store.push({ local: page([]), hosted: page([]) });
    assert.equal(store.getSnapshot().documents, snapshot.documents);

    // Its first page re-sends equal documents as new objects: identity survives.
    store.push({ local: page(copy([history[0]])), hosted: page([], true) });
    assert.equal(store.getSnapshot().documents, snapshot.documents);
    assert.equal(store.getSnapshot().refreshing, true);

    store.push({ local: page(copy(history), true), hosted: page([], true) });
    assert.equal(store.getSnapshot().documents, snapshot.documents);
    assert.equal(store.getSnapshot().refreshing, false);
    assert.equal(store.getSnapshot().loading, false);
  });

  test("a first load is loading, not refreshing", () => {
    const store = createSearchCatalogStore(fakeClock().clock, 500);
    store.connect();
    store.push({ local: page([doc("a", 1)]), hosted: page([]) });
    assert.equal(store.getSnapshot().loading, true);
    assert.equal(store.getSnapshot().refreshing, false);
  });

  test("a failed subscription keeps what it loaded, and a new one clears the error", () => {
    const store = createSearchCatalogStore(fakeClock().clock, 500);
    store.connect();
    store.push({ local: page([doc("a", 1)]), hosted: page([]) });
    store.disconnect();
    store.fail(new Error("Too many bytes read"));
    assert.equal(store.getSnapshot().error?.message, "Too many bytes read");
    assert.equal(store.getSnapshot().documents.length, 1);
    store.connect();
    assert.equal(store.getSnapshot().error, null);
  });
});

describe("search view cache", () => {
  test("returns the same output for an unchanged catalogue and intent", () => {
    const cache = createSearchViewCache();
    const documents = [doc("a", 1), doc("b", 2)];
    const first = cache.compute(documents, DEFAULT_SEARCH_INTENT);
    assert.equal(cache.compute(documents, { ...DEFAULT_SEARCH_INTENT }), first);
  });

  test("keeps result objects across a new search that still shows them", () => {
    const cache = createSearchViewCache();
    const documents = [doc("a", 1, { prompt: "girl" }), doc("b", 2, { prompt: "girl" })];
    const newest = cache.compute(documents, { ...DEFAULT_SEARCH_INTENT, sort: "newest" });
    const oldest = cache.compute(documents, { ...DEFAULT_SEARCH_INTENT, sort: "oldest" });
    assert.equal(oldest.results[0], newest.results[1]);
    assert.equal(oldest.results[1], newest.results[0]);
  });
});

describe("search session per signed-in user", () => {
  const page = (documents: SearchDocument[], done = false) => ({ documents, done });

  /** User A, confirmed by Convex, with a loaded catalogue, a search and a scroll anchor. */
  function signedInAsA() {
    const ready = advanceSearchAuth(initialSearchAuth("A"), "A", true);
    assert.equal(ready.phase, "ready");
    assert.equal(searchCatalogMayLoad(ready, true), true);
    const { catalog, views, scroll } = ready.session;
    catalog.connect();
    catalog.push({
      local: page([doc("a-private", 2), doc("a-old", 1)], true),
      hosted: page([], true),
    });
    catalog.disconnect();
    views.compute(catalog.getSnapshot().documents, DEFAULT_SEARCH_INTENT);
    scroll.remember({ intentKey: "", anchorKey: "a-private:0", anchorIndex: 0, anchorOffset: 90 });
    return ready;
  }

  test("a different user gets a blank session and waits for Convex to re-authenticate", () => {
    const a = signedInAsA();
    // The render where Clerk already reports B, while Convex still reports
    // the old token as authenticated: that report is about A.
    const switched = advanceSearchAuth(a, "B", true);
    assert.notEqual(switched.session, a.session);
    assert.equal(switched.session.user, "B");
    assert.equal(switched.phase, "stale");
    assert.equal(searchCatalogMayLoad(switched, true), false, "A's token must not load B's search");

    const fresh = switched.session;
    assert.deepEqual(fresh.catalog.getSnapshot().documents, [], "no snapshot carried over");
    assert.equal(fresh.scroll.read(), TOP_SEARCH_SCROLL, "no scroll anchor carried over");
    assert.equal(
      fresh.views.compute(fresh.catalog.getSnapshot().documents, DEFAULT_SEARCH_INTENT).results
        .length,
      0,
      "no cached output carried over",
    );

    // A re-subscription for B starts from B's own empty snapshot: nothing of
    // A's history can be merged in while B's pages are still arriving.
    fresh.catalog.connect();
    assert.equal(fresh.catalog.getSnapshot().refreshing, false);
    fresh.catalog.push({ local: page([doc("b-new", 5)]), hosted: page([]) });
    assert.deepEqual(
      fresh.catalog.getSnapshot().documents.map((document) => document.id),
      ["b-new"],
    );
    // A late page for A lands in A's discarded store, not B's.
    a.session.catalog.connect();
    a.session.catalog.push({ local: page([doc("a-late", 9)], true), hosted: page([], true) });
    assert.deepEqual(
      fresh.catalog.getSnapshot().documents.map((document) => document.id),
      ["b-new"],
    );

    assert.equal(advanceSearchAuth(switched, "B", true), switched, "still the old report");
    const pending = advanceSearchAuth(switched, "B", false);
    assert.equal(pending.phase, "pending");
    assert.equal(pending.session, fresh);
    assert.equal(searchCatalogMayLoad(pending, false), false);
    const confirmed = advanceSearchAuth(pending, "B", true);
    assert.equal(confirmed.phase, "ready");
    assert.equal(searchCatalogMayLoad(confirmed, true), true);
  });

  test("signing out drops the session, and signing in again starts clean", () => {
    const a = signedInAsA();
    const signedOut = advanceSearchAuth(a, null, false);
    assert.equal(signedOut.session.user, null);
    assert.deepEqual(signedOut.session.catalog.getSnapshot().documents, []);
    assert.equal(searchCatalogMayLoad(signedOut, false), false);
    const b = advanceSearchAuth(advanceSearchAuth(signedOut, "B", false), "B", true);
    assert.equal(b.session.user, "B");
    assert.equal(b.phase, "ready");
    assert.deepEqual(b.session.catalog.getSnapshot().documents, []);
  });

  test("keeps the session while Clerk loads and while the same user's token is renewed", () => {
    const a = signedInAsA();
    assert.equal(advanceSearchAuth(a, undefined, false), a, "Clerk still loading");
    const dropped = advanceSearchAuth(a, "A", false);
    assert.equal(dropped.session, a.session, "the same user keeps their snapshot");
    assert.equal(searchCatalogMayLoad(dropped, false), false, "but nothing loads unauthenticated");
    assert.equal(searchCatalogMayLoad(advanceSearchAuth(dropped, "A", true), true), true);
  });
});
