"use client";

import {
  createContext,
  use,
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { useAuth } from "@clerk/nextjs";
import { useConvexAuth } from "convex/react";
import { usePathname } from "next/navigation";

import { SearchCatalogSubscription } from "@/components/search-catalog";
import {
  addSearchHistory,
  countSearchMatches,
  DEFAULT_SEARCH_INTENT,
  parseSearchHistory,
  reorderSearchReferences,
  sameSearchIntent,
  searchIntentError,
  serializeSearchIntent,
  toggleSearchReference,
  type SearchFilters,
  type SearchIntent,
  type SearchResult,
} from "@/lib/search";
import {
  advanceSearchAuth,
  initialSearchAuth,
  searchCatalogMayLoad,
  type SearchSession,
} from "@/lib/search-catalog";
import type { SearchScrollPosition } from "@/lib/search-window";

export type { SearchScrollPosition } from "@/lib/search-window";

/**
 * Search state that outlives the search page: the query, the reference
 * selection, the scroll anchor and the catalogue.
 *
 * The provider sits in the root layout so all of that survives a trip to the
 * composer and back, but it does no search work of its own. The catalogue is
 * subscribed only while the user is on /search and for `CATALOG_GRACE_MS`
 * after leaving; after that the subscriptions are released and the documents
 * they delivered stay in the store as a snapshot. The search itself runs in
 * `useSearchView`, which only the search page calls.
 *
 * All of it belongs to one signed-in user. When the Clerk user changes without
 * a reload (session switch, sign-out, signing in as someone else) everything is
 * replaced — catalogue, snapshot, output cache, scroll anchor, references and
 * query — and the catalogue is not subscribed again until Convex has confirmed
 * the new identity, so nothing loaded as the previous user reaches the next.
 */

type SearchState = {
  inputValue: string;
  /** What the user asked for, possibly with a syntax error. */
  intent: SearchIntent;
  /** The last intent that parsed — the one the results are for. */
  validIntent: SearchIntent;
  syntaxError: string | null;
  selected: SearchResult[];
};

type SearchActions = {
  setInputValue: (value: string) => void;
  replaceIntent: (intent: SearchIntent, options?: { immediate?: boolean }) => void;
  applyFilters: (filters: SearchFilters) => void;
  toggleSelected: (result: SearchResult) => void;
  removeSelected: (id: string) => void;
  reorderSelected: (from: number, to: number) => void;
  clearSelected: () => void;
  readScrollPosition: () => SearchScrollPosition;
  rememberScrollPosition: (position: SearchScrollPosition) => void;
  retryCatalog: () => void;
  /** The signed-in user's catalogue, output cache and scroll anchor. */
  session: SearchSession;
};

const SearchStateContext = createContext<SearchState | null>(null);
const SearchActionsContext = createContext<SearchActions | null>(null);

/** Stable while the signed-in user stays the same: safe to depend on anywhere. */
export function useSearchActions(): SearchActions {
  const context = use(SearchActionsContext);
  if (!context) throw new Error("useSearchActions must be used inside SearchProvider");
  return context;
}

export function useSearchState(): SearchState {
  const context = use(SearchStateContext);
  if (!context) throw new Error("useSearchState must be used inside SearchProvider");
  return context;
}

export function useSearch(): SearchState & SearchActions {
  const state = useSearchState();
  const actions = useSearchActions();
  return useMemo(() => ({ ...state, ...actions }), [state, actions]);
}

/**
 * The search over the catalogue, for the search page only.
 *
 * Both inputs are deferred: a catalogue page landing or a debounced keystroke
 * re-renders urgently with the previous output, and the search runs in a
 * background render that a newer keystroke or click can interrupt. Except
 * across a change of user: the deferred values would still be the previous
 * user's documents and query, so the new session's are used at once.
 */
export function useSearchView() {
  const { session } = useSearchActions();
  const { intent, validIntent } = useSearchState();
  const { catalog, views } = session;
  const state = useSyncExternalStore(
    catalog.subscribe,
    catalog.getSnapshot,
    catalog.getServerSnapshot,
  );
  const deferredSession = useDeferredValue(session);
  const deferredDocuments = useDeferredValue(state.documents);
  const deferredIntent = useDeferredValue(validIntent);
  const switchedUser = deferredSession !== session;
  const documents = switchedUser ? state.documents : deferredDocuments;
  const resultsIntent = switchedUser ? validIntent : deferredIntent;
  const output = useMemo(
    () => views.compute(documents, resultsIntent),
    [views, documents, resultsIntent],
  );
  const currentDocuments = state.documents;
  const previewFilterCount = useCallback(
    (filters: SearchFilters, negativePromptQuery: string) =>
      countSearchMatches(currentDocuments, { ...intent, filters, negativePromptQuery }),
    [currentDocuments, intent],
  );
  return {
    output,
    /** The intent `output` was computed for. */
    resultsIntent,
    catalog: state,
    previewFilterCount,
  };
}

const DEBOUNCE_MS = 300;
const HISTORY_KEY = "artsnack.search.history.v1";
const HISTORY_LIMIT = 20;
/** How long the catalogue stays subscribed after leaving /search. */
const CATALOG_GRACE_MS = 3 * 60 * 1000;

type Intents = { intent: SearchIntent; valid: SearchIntent };

const INITIAL_INTENTS: Intents = { intent: DEFAULT_SEARCH_INTENT, valid: DEFAULT_SEARCH_INTENT };

function withIntent(current: Intents, intent: SearchIntent): Intents {
  if (intent === current.intent) return current;
  return { intent, valid: searchIntentError(intent) === null ? intent : current.valid };
}

export function SearchProvider({ children }: { children: ReactNode }) {
  const onSearch = usePathname() === "/search";
  // True while on /search and for the grace period after leaving it.
  const [warm, setWarm] = useState(onSearch);
  if (onSearch && !warm) setWarm(true);
  useEffect(() => {
    if (onSearch || !warm) return;
    const timer = window.setTimeout(() => setWarm(false), CATALOG_GRACE_MS);
    return () => window.clearTimeout(timer);
  }, [onSearch, warm]);

  const [catalogAttempt, setCatalogAttempt] = useState(0);
  const [inputValue, setInputValueState] = useState("");
  const [intents, setIntents] = useState<Intents>(INITIAL_INTENTS);
  const [selected, setSelected] = useState<SearchResult[]>([]);

  // Whose search this is. `identity` is undefined while Clerk is still
  // loading, which keeps the current session as it is.
  const { isLoaded: clerkLoaded, userId } = useAuth();
  const { isAuthenticated, isLoading: convexAuthLoading } = useConvexAuth();
  const convexReady = isAuthenticated && !convexAuthLoading;
  const identity = clerkLoaded ? (userId ?? null) : undefined;
  const [auth, setAuth] = useState(() => initialSearchAuth(identity ?? null));
  const nextAuth = advanceSearchAuth(auth, identity, convexReady);
  if (nextAuth !== auth) {
    setAuth(nextAuth);
    if (nextAuth.session !== auth.session) {
      // A new user starts from a blank search, not the last user's query and
      // reference selection.
      setInputValueState("");
      setIntents(INITIAL_INTENTS);
      setSelected([]);
    }
  }
  const session = nextAuth.session;
  const catalogMayLoad = searchCatalogMayLoad(nextAuth, convexReady);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setIntents((current) =>
        current.intent.query === inputValue
          ? current
          : withIntent(current, { ...current.intent, query: inputValue }),
      );
      if (inputValue.trim()) rememberLocalSearch(inputValue);
    }, DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [inputValue]);

  const setInputValue = useCallback((value: string) => setInputValueState(value), []);

  const replaceIntent = useCallback((next: SearchIntent, options?: { immediate?: boolean }) => {
    setInputValueState(next.query);
    setIntents((current) =>
      sameSearchIntent(current.intent, next) ? current : withIntent(current, next),
    );
    if (options?.immediate && next.query.trim()) rememberLocalSearch(next.query);
  }, []);

  const applyFilters = useCallback((filters: SearchFilters) => {
    setIntents((current) => withIntent(current, { ...current.intent, filters }));
  }, []);

  const toggleSelected = useCallback((result: SearchResult) => {
    setSelected((current) => toggleSearchReference(current, result));
  }, []);
  const removeSelected = useCallback((id: string) => {
    setSelected((current) => current.filter((entry) => entry.id !== id));
  }, []);
  const reorderSelected = useCallback((from: number, to: number) => {
    setSelected((current) => reorderSearchReferences(current, from, to));
  }, []);
  const clearSelected = useCallback(() => setSelected([]), []);

  // A position belongs to the results it was taken on; the search page ignores
  // one whose intent key no longer matches, so no reset is needed here.
  const readScrollPosition = session.scroll.read;
  const rememberScrollPosition = session.scroll.remember;
  const retryCatalog = useCallback(() => setCatalogAttempt((attempt) => attempt + 1), []);

  const actions = useMemo<SearchActions>(
    () => ({
      setInputValue,
      replaceIntent,
      applyFilters,
      toggleSelected,
      removeSelected,
      reorderSelected,
      clearSelected,
      readScrollPosition,
      rememberScrollPosition,
      retryCatalog,
      session,
    }),
    [
      setInputValue,
      replaceIntent,
      applyFilters,
      toggleSelected,
      removeSelected,
      reorderSelected,
      clearSelected,
      readScrollPosition,
      rememberScrollPosition,
      retryCatalog,
      session,
    ],
  );

  const intent = intents.intent;
  const validIntent = intents.valid;
  const syntaxError = useMemo(() => searchIntentError(intent), [intent]);
  const state = useMemo<SearchState>(
    () => ({ inputValue, intent, validIntent, syntaxError, selected }),
    [inputValue, intent, validIntent, syntaxError, selected],
  );

  return (
    <SearchActionsContext value={actions}>
      <SearchStateContext value={state}>
        {warm && catalogMayLoad ? (
          // Keyed by user as well: a subscription must never carry its pages
          // over into another user's store.
          <SearchCatalogSubscription
            key={`${session.user}:${catalogAttempt}`}
            store={session.catalog}
          />
        ) : null}
        {children}
      </SearchStateContext>
    </SearchActionsContext>
  );
}

function rememberLocalSearch(query: string) {
  try {
    const raw = window.localStorage.getItem(HISTORY_KEY);
    const previous = parseSearchHistory(raw, HISTORY_LIMIT);
    const next = addSearchHistory(previous, query, HISTORY_LIMIT);
    window.localStorage.setItem(HISTORY_KEY, JSON.stringify(next));
  } catch {
    // History is a convenience; private mode or a full store must not break search.
  }
}

let historyCache: { raw: string | null; entries: string[] } = { raw: null, entries: [] };

/**
 * The device-local search history. Parsed only when the stored string changed,
 * so a component may call this while rendering.
 */
export function readLocalSearchHistory(): string[] {
  try {
    const raw = window.localStorage.getItem(HISTORY_KEY);
    if (raw !== historyCache.raw) {
      historyCache = { raw, entries: parseSearchHistory(raw, HISTORY_LIMIT) };
    }
    return historyCache.entries;
  } catch {
    return [];
  }
}

export function encodedIntent(intent: SearchIntent): string {
  return serializeSearchIntent(intent);
}
