import {
  emptySearchOutput,
  sameSearchIntent,
  searchDocuments,
  stabilizeSearchResults,
  type SearchDocument,
  type SearchIntent,
  type SearchOutput,
} from "@/lib/search";
import { TOP_SEARCH_SCROLL, type SearchScrollPosition } from "@/lib/search-window";

/**
 * The search catalogue outside React: what the two paginated Convex
 * subscriptions have delivered, kept after they are released.
 *
 * The provider lives in the root layout, so anything it renders runs on every
 * page. Keeping the catalogue here instead means a catalogue change notifies
 * only the search page (through `useSyncExternalStore`), and nothing at all
 * while the user is elsewhere. It also outlives the subscriptions: once they are
 * released the last documents stay as a snapshot, so a return to /search draws
 * the full history at once and refreshes it in the background.
 */

/** One table's subscription, as `usePaginatedQuery` reports it. */
export type SearchCatalogFeed = {
  documents: readonly SearchDocument[];
  /** The subscription has read the table to the end. */
  done: boolean;
};

export type SearchCatalogFeeds = { local: SearchCatalogFeed; hosted: SearchCatalogFeed };

export type SearchCatalogState = {
  documents: SearchDocument[];
  /** A subscription is live and has not yet read both tables to the end. */
  loading: boolean;
  /** Loading, and part of what is shown is the snapshot of an earlier subscription. */
  refreshing: boolean;
  error: Error | null;
};

export type SearchCatalogClock = {
  now: () => number;
  setTimeout: (callback: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
};

const browserClock: SearchCatalogClock = {
  now: () => Date.now(),
  setTimeout: (callback, ms) => globalThis.setTimeout(callback, ms),
  clearTimeout: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/** How often a catalogue that is still paging in may re-run the search. */
export const SEARCH_CATALOG_THROTTLE_MS = 500;

const INITIAL_STATE: SearchCatalogState = {
  documents: [],
  loading: true,
  refreshing: false,
  error: null,
};

/**
 * Fresh pages first, then the retained documents older than anything fresh —
 * the part of the history a re-subscription has not paged back to yet.
 *
 * Both tables are read newest first, so "older than the oldest fresh document"
 * is exactly the region the fresh pages cannot speak for. A retained document
 * inside the fresh region that is no longer in it was deleted or failed, and is
 * dropped. Once the feed is done the fresh pages are the whole truth.
 */
export function mergeCatalogFeed(
  fresh: SearchCatalogFeed,
  retained: readonly SearchDocument[],
): SearchDocument[] {
  if (fresh.done || retained.length === 0) return fresh.documents as SearchDocument[];
  if (fresh.documents.length === 0) return retained as SearchDocument[];
  let oldest = Infinity;
  const ids = new Set<string>();
  for (const document of fresh.documents) {
    ids.add(document.id);
    if (document.createdAt < oldest) oldest = document.createdAt;
  }
  const merged = fresh.documents.slice();
  for (const document of retained) {
    if (document.createdAt < oldest && !ids.has(document.id)) merged.push(document);
  }
  return merged;
}

/**
 * Returns the previously seen object for every document whose content did not
 * change, and `previous` itself when the list is element-for-element the same.
 *
 * Convex hands back new objects whenever a page re-runs — a progress write on
 * one running job re-sends its whole page — and a new object costs twice
 * downstream: search re-normalises its prompt (the per-document text index is
 * keyed by identity), and its results get new identities, so every tile
 * re-renders. Untouched pages keep their objects, so the JSON comparison only
 * runs for documents whose page was re-sent.
 */
export function stabilizeCatalogDocuments(
  known: ReadonlyMap<string, SearchDocument>,
  previous: readonly SearchDocument[],
  next: readonly SearchDocument[],
): { documents: SearchDocument[]; known: Map<string, SearchDocument> } {
  const nextKnown = new Map<string, SearchDocument>();
  const documents: SearchDocument[] = [];
  let unchanged = previous.length === next.length;
  for (let index = 0; index < next.length; index += 1) {
    const document = next[index];
    const before = known.get(document.id);
    // Serialised per comparison rather than cached: a stored signature for
    // every document would double the catalogue's memory.
    const kept =
      before !== undefined &&
      before !== document &&
      JSON.stringify(before) === JSON.stringify(document)
        ? before
        : document;
    nextKnown.set(kept.id, kept);
    documents.push(kept);
    if (unchanged && previous[index] !== kept) unchanged = false;
  }
  return { documents: unchanged ? (previous as SearchDocument[]) : documents, known: nextKnown };
}

export type SearchCatalogStore = ReturnType<typeof createSearchCatalogStore>;

export function createSearchCatalogStore(
  clock: SearchCatalogClock = browserClock,
  throttleMs = SEARCH_CATALOG_THROTTLE_MS,
) {
  let state = INITIAL_STATE;
  const listeners = new Set<() => void>();
  let retained: { local: SearchDocument[]; hosted: SearchDocument[] } = { local: [], hosted: [] };
  let known = new Map<string, SearchDocument>();
  let pending: SearchCatalogFeeds | null = null;
  let timer: unknown = null;
  let lastFlush = -Infinity;
  let connected = false;
  let resumedFromSnapshot = false;

  const emit = (next: SearchCatalogState) => {
    if (
      next.documents === state.documents &&
      next.loading === state.loading &&
      next.refreshing === state.refreshing &&
      next.error === state.error
    ) {
      return;
    }
    state = next;
    for (const listener of listeners) listener();
  };

  const cancelTimer = () => {
    if (timer !== null) clock.clearTimeout(timer);
    timer = null;
  };

  const flush = () => {
    cancelTimer();
    if (!pending) return;
    const feeds = pending;
    pending = null;
    lastFlush = clock.now();
    const local = mergeCatalogFeed(feeds.local, retained.local);
    const hosted = mergeCatalogFeed(feeds.hosted, retained.hosted);
    retained = { local, hosted };
    const stable = stabilizeCatalogDocuments(known, state.documents, [...local, ...hosted]);
    known = stable.known;
    const loading = connected && !(feeds.local.done && feeds.hosted.done);
    emit({
      documents: stable.documents,
      loading,
      refreshing: loading && resumedFromSnapshot,
      error: state.error,
    });
  };

  return {
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getSnapshot: () => state,
    getServerSnapshot: () => INITIAL_STATE,

    /** A subscription started: it will page both tables in from the top. */
    connect() {
      connected = true;
      lastFlush = -Infinity;
      resumedFromSnapshot = retained.local.length + retained.hosted.length > 0;
      emit({ ...state, loading: true, refreshing: resumedFromSnapshot, error: null });
    },

    /** The subscription was released. What it delivered stays as the snapshot. */
    disconnect() {
      flush();
      connected = false;
      emit({ ...state, loading: false, refreshing: false });
    },

    /**
     * The latest pages. While either table is still paging in, the search
     * re-runs at most every `throttleMs`; the page that completes the catalogue
     * and every live change after it are published at once.
     */
    push(feeds: SearchCatalogFeeds) {
      pending = feeds;
      const complete = feeds.local.done && feeds.hosted.done;
      const wait = lastFlush + throttleMs - clock.now();
      if (complete || wait <= 0) {
        flush();
        return;
      }
      if (timer === null) {
        timer = clock.setTimeout(() => {
          timer = null;
          flush();
        }, wait);
      }
    },

    fail(error: Error) {
      flush();
      emit({ ...state, loading: false, refreshing: false, error });
    },
  };
}

export type SearchViewCache = ReturnType<typeof createSearchViewCache>;

/**
 * Remembers the last search, so a search page that remounts over an unchanged
 * catalogue and intent gets the same output object back without searching, and
 * a new search keeps the result objects of everything that did not change.
 */
export function createSearchViewCache() {
  let last: {
    documents: readonly SearchDocument[];
    intent: SearchIntent;
    output: SearchOutput;
  } | null = null;
  return {
    compute(documents: readonly SearchDocument[], intent: SearchIntent): SearchOutput {
      if (
        last &&
        last.documents === documents &&
        (last.intent === intent || sameSearchIntent(last.intent, intent))
      ) {
        return last.output;
      }
      const computed = searchDocuments(documents as SearchDocument[], intent);
      const previous = last?.output ?? emptySearchOutput();
      const output: SearchOutput =
        "results" in computed
          ? { ...computed, results: stabilizeSearchResults(previous.results, computed.results) }
          : previous;
      last = { documents, intent, output };
      return output;
    },
  };
}

/**
 * Everything search remembers for one signed-in user: the catalogue and its
 * snapshot, the last search output and the scroll anchor. A different user —
 * a Clerk session switch, sign-out, sign-in as someone else, all without a page
 * reload — gets a new session rather than a cleared one, so a late page from
 * the old subscription can only ever land in the old, discarded store.
 */
export type SearchSession = {
  /** The Clerk user id the session belongs to; null while signed out. */
  user: string | null;
  catalog: SearchCatalogStore;
  views: SearchViewCache;
  scroll: { read: () => SearchScrollPosition; remember: (position: SearchScrollPosition) => void };
};

export function createSearchSession(user: string | null): SearchSession {
  let position = TOP_SEARCH_SCROLL;
  return {
    user,
    catalog: createSearchCatalogStore(),
    views: createSearchViewCache(),
    scroll: {
      read: () => position,
      remember: (next) => {
        position = next;
      },
    },
  };
}

/**
 * Whether Convex is known to be authenticated as the session's user.
 *
 * - `stale`: the session's user changed while Convex still reported the
 *   previous user as authenticated. That report is about the old token, so it
 *   proves nothing; Convex drops it (the old fetcher's effect cleanup) before
 *   authenticating the new one.
 * - `pending`: waiting for Convex to report this user authenticated.
 * - `ready`: it did.
 *
 * There is deliberately no timeout out of `stale`: if Convex never re-auths,
 * the catalogue stays unloaded rather than risk loading the previous user's.
 */
export type SearchAuthPhase = "stale" | "pending" | "ready";

export type SearchAuthState = { session: SearchSession; phase: SearchAuthPhase };

/** At mount there is no previous identity a Convex report could belong to. */
export function initialSearchAuth(user: string | null): SearchAuthState {
  return { session: createSearchSession(user), phase: "pending" };
}

/**
 * @param identity the Clerk user id, null when signed out, undefined while
 *   Clerk is still loading (which changes nothing).
 * @param convexReady `useConvexAuth()` reports authenticated and not loading.
 */
export function advanceSearchAuth(
  state: SearchAuthState,
  identity: string | null | undefined,
  convexReady: boolean,
): SearchAuthState {
  if (identity !== undefined && identity !== state.session.user) {
    return { session: createSearchSession(identity), phase: convexReady ? "stale" : "pending" };
  }
  if (state.phase === "stale" && !convexReady) return { ...state, phase: "pending" };
  if (state.phase === "pending" && convexReady) return { ...state, phase: "ready" };
  return state;
}

/** The catalogue may be subscribed: a user, confirmed by Convex, and still authenticated. */
export function searchCatalogMayLoad(state: SearchAuthState, convexReady: boolean): boolean {
  return state.session.user !== null && state.phase === "ready" && convexReady;
}
