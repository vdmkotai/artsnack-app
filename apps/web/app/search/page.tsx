"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useMutation } from "convex/react";
import { useQuery as useCachedQuery } from "@/lib/convex-cache";
import { useRouter } from "next/navigation";
import {
  Bookmark,
  GripVertical,
  HelpCircle,
  ImageIcon,
  Loader2,
  Search,
  SlidersHorizontal,
  Trash2,
  X,
} from "lucide-react";
import { toast } from "sonner";

import { SearchFiltersButton } from "@/components/search-filters";
import {
  encodedIntent,
  readLocalSearchHistory,
  useSearch,
  useSearchView,
  type SearchScrollPosition,
} from "@/components/search-provider";
import { SearchResults } from "@/components/search-results";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { mediaUrl, thumbUrl } from "@/lib/media-url";
import { queueApiReferences } from "@/lib/reference-handoff";
import type { SearchSession } from "@/lib/search-catalog";
import {
  deserializeSearchIntent,
  sameSearchIntent,
  serializeSearchIntent,
  type SearchFilters,
  type SearchIntent,
} from "@/lib/search";

/**
 * The search the page was opened for, when its URL asks for something other
 * than what SearchProvider already holds — a shared link or a saved-search URL.
 * An identical URL (a return from the composer) is left alone so the session's
 * results and scroll anchor survive.
 */
function linkedIntentFromUrl(current: SearchIntent): SearchIntent | null {
  if (typeof window === "undefined") return null;
  const params = new URLSearchParams(window.location.search);
  if (params.size === 0) return null;
  const linked = deserializeSearchIntent(params);
  return sameSearchIntent(linked, current) ? null : linked;
}

export default function SearchPage() {
  const router = useRouter();
  const search = useSearch();
  const { output, resultsIntent, catalog, previewFilterCount } = useSearchView();
  const {
    intent,
    inputValue,
    syntaxError,
    selected,
    setInputValue,
    replaceIntent,
    applyFilters: applySearchFilters,
    toggleSelected,
    rememberScrollPosition,
    retryCatalog,
  } = search;
  const resultsKey = useMemo(() => serializeSearchIntent(resultsIntent), [resultsIntent]);
  const [selectionMode, setSelectionMode] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [savedOpen, setSavedOpen] = useState(false);
  const [linkedIntent] = useState(() => linkedIntentFromUrl(intent));
  // Tied to the session it was read from: a position from before a change of
  // signed-in user must not be applied to the next user's grid.
  const [pendingRestore, setPendingRestore] = useState<{
    session: SearchSession;
    position: SearchScrollPosition;
  } | null>(() => {
    if (linkedIntent) return null;
    const saved = search.readScrollPosition();
    return saved.anchorKey !== null && saved.intentKey === resultsKey
      ? { session: search.session, position: saved }
      : null;
  });
  const restore = pendingRestore?.session === search.session ? pendingRestore.position : null;
  const clearRestore = useCallback(() => setPendingRestore(null), []);
  const initializedUrl = useRef(false);
  const skipInitialUrlWrite = useRef(false);
  const shownResultsKey = useRef(resultsKey);

  useEffect(() => {
    if (initializedUrl.current) return;
    initializedUrl.current = true;
    if (!linkedIntent) return;
    window.scrollTo(0, 0);
    skipInitialUrlWrite.current = true;
    replaceIntent(linkedIntent, { immediate: true });
  }, [linkedIntent, replaceIntent]);

  useEffect(() => {
    if (!initializedUrl.current || window.location.pathname !== "/search") return;
    if (skipInitialUrlWrite.current) {
      skipInitialUrlWrite.current = false;
      return;
    }
    const query = serializeSearchIntent(intent);
    window.history.replaceState(null, "", query ? `/search?${query}` : "/search");
  }, [intent]);

  // New results start at the top. Keyed on the intent the results were
  // computed for, so a query with a syntax error (which keeps the previous
  // results on screen) does not move the page.
  useEffect(() => {
    if (shownResultsKey.current === resultsKey) return;
    shownResultsKey.current = resultsKey;
    window.scrollTo(0, 0);
  }, [resultsKey]);

  const applyFilters = useCallback(
    (filters: SearchFilters, negativePromptQuery: string) => {
      replaceIntent({ ...intent, filters, negativePromptQuery });
      window.scrollTo({ top: 0, behavior: "smooth" });
    },
    [intent, replaceIntent],
  );

  const removeChip = useCallback(
    (kind: keyof SearchFilters | "negative", value?: string) => {
      if (kind === "negative") {
        replaceIntent({ ...intent, negativePromptQuery: "" });
        return;
      }
      const current = intent.filters[kind];
      if (Array.isArray(current)) {
        applySearchFilters({
          ...intent.filters,
          [kind]: current.filter((entry) => entry !== value),
        });
      } else applySearchFilters({ ...intent.filters, [kind]: undefined });
    },
    [intent, replaceIntent, applySearchFilters],
  );

  const selectedIds = useMemo(() => new Set(selected.map((result) => result.id)), [selected]);
  // The grid records its scroll anchor as it unmounts, so navigating is enough.
  const attachSelected = useCallback(() => {
    if (selected.length === 0) return;
    queueApiReferences(selected.map((result) => mediaUrl(result.asset.key)));
    router.push("/generate?tab=api");
  }, [selected, router]);

  const parsed = output.parsed;
  const title = intent.query.trim() ? "Search results" : "Recent generations";
  const catalogStatus = catalog.refreshing
    ? " · refreshing…"
    : catalog.loading
      ? ` · indexing ${catalog.documents.length.toLocaleString()}…`
      : "";

  return (
    <div data-testid="search-page" className="min-h-[70vh] pb-32">
      <div className="sticky top-14 z-30 border-b border-border/70 bg-background/90 px-4 py-4 backdrop-blur-xl lg:px-8">
        <div className="mx-auto max-w-6xl space-y-3">
          <div className="flex gap-2">
            <div className="relative min-w-0 flex-1">
              <Search className="pointer-events-none absolute left-4 top-1/2 h-5 w-5 -translate-y-1/2 text-muted-foreground" />
              <input
                type="text"
                value={inputValue}
                onChange={(event) => setInputValue(event.target.value)}
                placeholder='dog, beach, -scarf or "red dress"'
                aria-label="Search generation prompts"
                className={`h-11 w-full rounded-xl border bg-muted/40 pl-11 pr-10 text-base outline-none transition-shadow focus:ring-2 ${syntaxError ? "border-destructive focus:ring-destructive/30" : "border-input focus:ring-ring/30"}`}
              />
              {inputValue ? (
                <button
                  type="button"
                  onClick={() => setInputValue("")}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                  aria-label="Clear search"
                >
                  <X className="h-4 w-4" />
                </button>
              ) : null}
            </div>
            <SearchFiltersButton
              filters={intent.filters}
              negativePromptQuery={intent.negativePromptQuery}
              facets={output.facets}
              previewCount={previewFilterCount}
              onApply={applyFilters}
            />
            <Button
              variant="outline"
              size="lg"
              aria-label="Search syntax help"
              onClick={() => setHelpOpen(true)}
            >
              <HelpCircle />
            </Button>
          </div>

          <div className="flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
            {syntaxError ? (
              <span className="text-destructive">{syntaxError}</span>
            ) : (
              <>
                {parsed.required.length > 0 ? (
                  <span>
                    <strong className="text-foreground">Required:</strong>{" "}
                    {parsed.required.join(" · ")}
                  </span>
                ) : (
                  <span>Showing newest media. Add prompt words to narrow it.</span>
                )}
                {parsed.excluded.length > 0 ? (
                  <span>
                    <strong className="text-foreground">Excluded:</strong>{" "}
                    {parsed.excluded.join(" · ")}
                  </span>
                ) : null}
              </>
            )}
            <span className="ml-auto flex items-center gap-2">
              <Switch
                size="sm"
                checked={intent.allowTypos}
                onCheckedChange={(checked) => replaceIntent({ ...intent, allowTypos: checked })}
              />{" "}
              Allow typos
            </span>
            <select
              aria-label="Sort search results"
              value={intent.sort}
              onChange={(event) =>
                replaceIntent({
                  ...intent,
                  sort: event.target.value as SearchIntent["sort"],
                })
              }
              className="h-7 rounded-md border border-input bg-background px-2 text-xs"
            >
              <option value="relevance">Relevance</option>
              <option value="newest">Newest</option>
              <option value="oldest">Oldest</option>
            </select>
            <Button variant="ghost" size="sm" onClick={() => setSavedOpen(true)}>
              <Bookmark />
              Saved
            </Button>
          </div>

          <ActiveFilterChips intent={intent} remove={removeChip} />
        </div>
      </div>

      <main className={`px-4 py-5 transition-opacity lg:px-8 ${syntaxError ? "opacity-55" : ""}`}>
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-xl font-semibold">{title}</h1>
            <p className="text-xs text-muted-foreground">
              {output.results.length.toLocaleString()} media from{" "}
              {output.documents.length.toLocaleString()} generations
              {catalogStatus}
            </p>
          </div>
          <Button
            variant={selectionMode ? "secondary" : "outline"}
            onClick={() => setSelectionMode((value) => !value)}
          >
            <ImageIcon />
            {selectionMode ? "Done selecting" : "Select references"}
          </Button>
        </div>
        {catalog.error ? (
          <div
            role="alert"
            className="mb-4 flex items-center gap-3 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs"
          >
            <span className="min-w-0 flex-1">
              {catalog.documents.length > 0
                ? "Your history could not be fully loaded; results may be incomplete."
                : "Your history could not be loaded."}{" "}
              <span className="text-muted-foreground">{catalog.error.message}</span>
            </span>
            <Button variant="outline" size="sm" onClick={retryCatalog}>
              Retry
            </Button>
          </div>
        ) : null}
        {output.results.length > 0 ? (
          <SearchResults
            // A different signed-in user's grid starts over: window, detail, anchor.
            key={search.session.user ?? ""}
            results={output.results}
            resetKey={resultsKey}
            restore={restore}
            onRestored={clearRestore}
            onRememberScroll={rememberScrollPosition}
            selectionMode={selectionMode}
            selectedIds={selectedIds}
            onToggleSelected={toggleSelected}
          />
        ) : catalog.loading ? (
          <div className="flex min-h-[45vh] items-center justify-center text-muted-foreground">
            <Loader2 className="mr-2 h-5 w-5 animate-spin" />
            Building your search catalogue…
          </div>
        ) : catalog.error && catalog.documents.length === 0 ? null : (
          <EmptySearch input={inputValue} onPick={setInputValue} />
        )}
      </main>

      <ReferenceTray
        selected={selected}
        remove={search.removeSelected}
        reorder={search.reorderSelected}
        clear={search.clearSelected}
        attach={attachSelected}
      />
      <SearchHelp open={helpOpen} onOpenChange={setHelpOpen} />
      <SavedSearches
        open={savedOpen}
        onOpenChange={setSavedOpen}
        intent={intent}
        onLoad={(next) => {
          replaceIntent(next, { immediate: true });
          setSavedOpen(false);
        }}
      />
    </div>
  );
}

function ActiveFilterChips({
  intent,
  remove,
}: {
  intent: SearchIntent;
  remove: (kind: keyof SearchFilters | "negative", value?: string) => void;
}) {
  const chips: Array<{ kind: keyof SearchFilters | "negative"; value?: string; label: string }> =
    [];
  const labels: Partial<Record<keyof SearchFilters, string>> = {
    mediaTypes: "Media",
    sources: "Source",
    providers: "Provider",
    models: "Model",
    modelFamilies: "Family",
    checkpoints: "Checkpoint",
    loras: "LoRA",
    orientations: "Orientation",
    resolutions: "Resolution",
    qualities: "Quality",
    samplers: "Sampler",
    schedulers: "Scheduler",
  };
  for (const [kind, label] of Object.entries(labels) as Array<[keyof SearchFilters, string]>) {
    const values = intent.filters[kind];
    if (Array.isArray(values))
      for (const value of values) chips.push({ kind, value, label: `${label}: ${value}` });
  }
  if (intent.negativePromptQuery)
    chips.push({ kind: "negative", label: `Negative prompt: ${intent.negativePromptQuery}` });
  if (chips.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-1.5">
      {chips.map((chip) => (
        <button
          key={`${chip.kind}:${chip.value ?? ""}`}
          onClick={() => remove(chip.kind, chip.value)}
          className="inline-flex items-center gap-1 rounded-full border border-border bg-muted/50 px-2 py-1 text-[10px] hover:bg-muted"
        >
          {chip.label}
          <X className="h-2.5 w-2.5" />
        </button>
      ))}
    </div>
  );
}

function ReferenceTray({
  selected,
  remove,
  reorder,
  clear,
  attach,
}: {
  selected: ReturnType<typeof useSearch>["selected"];
  remove: (id: string) => void;
  reorder: (from: number, to: number) => void;
  clear: () => void;
  attach: () => void;
}) {
  const dragging = useRef<number | null>(null);
  if (selected.length === 0) return null;
  return (
    <div className="fixed inset-x-3 bottom-3 z-40 mx-auto flex max-w-4xl items-center gap-3 rounded-2xl border border-border bg-background/95 p-2 shadow-2xl backdrop-blur-xl">
      <div className="flex min-w-0 flex-1 gap-2 overflow-x-auto">
        {selected.map((result, index) => (
          <div
            key={result.id}
            draggable
            onDragStart={() => {
              dragging.current = index;
            }}
            onDragOver={(event) => event.preventDefault()}
            onDrop={() => {
              if (dragging.current !== null) reorder(dragging.current, index);
              dragging.current = null;
            }}
            className="relative h-14 w-14 flex-none cursor-grab overflow-hidden rounded-lg border border-border"
          >
            <img
              src={thumbUrl(result.asset.key)}
              alt={`Reference ${index + 1}`}
              className="h-full w-full object-cover"
            />
            <span className="absolute left-1 top-1 grid h-5 w-5 place-items-center rounded-full bg-primary text-[10px] font-bold text-primary-foreground">
              {index + 1}
            </span>
            <GripVertical className="absolute bottom-1 left-1 h-3 w-3 text-white drop-shadow" />
            <button
              onClick={() => remove(result.id)}
              className="absolute right-1 top-1 rounded-full bg-black/65 p-0.5 text-white"
              aria-label={`Remove reference ${index + 1}`}
            >
              <X className="h-3 w-3" />
            </button>
          </div>
        ))}
      </div>
      <span className="hidden text-xs text-muted-foreground sm:block">{selected.length}/9</span>
      <Button variant="ghost" size="sm" onClick={clear}>
        Clear
      </Button>
      <Button size="lg" onClick={attach}>
        Use {selected.length} as references
      </Button>
    </div>
  );
}

function SearchHelp({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const examples = [
    ["dog, beach, scarf", "all three broad terms"],
    ["dog|fox, beach", "dog OR fox, plus beach"],
    ["dog, beach, -scarf", "exclude scarf, silkscarf, etc."],
    ['"dog"', "exact token; does not match 2dogs"],
    ['"red dress"', "exact normalized phrase"],
    ['-"scarf"', "exclude only the exact token"],
  ];
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Power search syntax</DialogTitle>
          <DialogDescription>
            Search runs against positive prompts by default. Commas and spaces both mean AND;
            punctuation and underscores in stored prompts are normalized.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          {examples.map(([query, meaning]) => (
            <div
              key={query}
              className="grid grid-cols-[minmax(9rem,0.8fr)_1.2fr] gap-3 rounded-lg border border-border p-2"
            >
              <code className="break-all text-xs text-primary">{query}</code>
              <span className="text-xs text-muted-foreground">{meaning}</span>
            </div>
          ))}
        </div>
        <div className="space-y-2 rounded-lg bg-muted/50 p-3 text-xs text-muted-foreground">
          <p>
            <strong className="text-foreground">Ranking:</strong> exact phrase → exact token → broad
            contains → optional one-character typo. Newest only breaks ties.
          </p>
          <p>
            <strong className="text-foreground">Filters:</strong> provider, API model, checkpoint
            and LoRA values come from your real history, so retired entries remain findable.
          </p>
          <p>
            <strong className="text-foreground">Invalid syntax:</strong> an unclosed quote or
            dangling | shows an error and keeps the previous results on screen.
          </p>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function SavedSearches({
  open,
  onOpenChange,
  intent,
  onLoad,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  intent: SearchIntent;
  onLoad: (intent: SearchIntent) => void;
}) {
  const saved = useCachedQuery(api.savedSearches.list);
  const save = useMutation(api.savedSearches.save);
  const remove = useMutation(api.savedSearches.remove);
  const [title, setTitle] = useState("");
  const [history, setHistory] = useState<string[]>([]);
  useEffect(() => {
    if (open) setHistory(readLocalSearchHistory());
  }, [open]);
  // Decoded once per list change rather than twice per entry per render.
  const entries = useMemo(
    () => saved?.map((entry) => ({ entry, intent: deserializeSearchIntent(entry.intent) })),
    [saved],
  );
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Saved searches</DialogTitle>
          <DialogDescription>
            Named searches sync through Convex to web and mobile. Your last 20 raw searches stay
            only on this device.
          </DialogDescription>
        </DialogHeader>
        <div className="flex gap-2">
          <Input
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            placeholder="Name this search"
          />
          <Button
            onClick={() => {
              void save({ title, intent: encodedIntent(intent) })
                .then(() => {
                  setTitle("");
                  toast.success("Search saved");
                })
                .catch((error: Error) => toast.error(error.message));
            }}
            disabled={!title.trim()}
          >
            <Bookmark />
            Save
          </Button>
        </div>
        <div className="max-h-72 space-y-1 overflow-y-auto">
          {entries?.map(({ entry, intent: savedIntent }) => (
            <div
              key={entry._id}
              className="flex items-center gap-2 rounded-lg border border-border p-2"
            >
              <button className="min-w-0 flex-1 text-left" onClick={() => onLoad(savedIntent)}>
                <span className="block truncate text-sm font-medium">{entry.title}</span>
                <span className="block truncate text-[10px] text-muted-foreground">
                  {savedIntent.query || "Recent generations with filters"}
                </span>
              </button>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={`Delete ${entry.title}`}
                onClick={() => void remove({ id: entry._id as Id<"savedSearches"> })}
              >
                <Trash2 />
              </Button>
            </div>
          ))}
          {saved?.length === 0 ? (
            <p className="py-8 text-center text-xs text-muted-foreground">No named searches yet.</p>
          ) : null}
          {history.length > 0 ? (
            <div className="pt-3">
              <p className="mb-2 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                Recent on this device
              </p>
              <div className="flex flex-wrap gap-1.5">
                {history.map((query) => (
                  <button
                    key={query}
                    onClick={() => onLoad({ ...intent, query })}
                    className="max-w-full truncate rounded-full border border-border px-2.5 py-1 text-[11px] hover:bg-muted"
                  >
                    {query}
                  </button>
                ))}
              </div>
            </div>
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function EmptySearch({ input, onPick }: { input: string; onPick: (query: string) => void }) {
  // Cached by the stored string: re-parsed only when the history changed.
  const history = readLocalSearchHistory();
  return (
    <div className="flex min-h-[45vh] flex-col items-center justify-center text-center">
      <div className="mb-4 rounded-full bg-muted p-5">
        <SlidersHorizontal className="h-9 w-9 text-muted-foreground" />
      </div>
      <h2 className="text-lg font-semibold">{input ? "Nothing matched" : "No generations yet"}</h2>
      <p className="mt-1 max-w-md text-sm text-muted-foreground">
        {input
          ? "Remove a filter, try a broad term, or enable one-character typo matching."
          : "Your generated images and videos will appear here."}
      </p>
      {history.length > 0 ? (
        <div className="mt-5 flex max-w-xl flex-wrap justify-center gap-2">
          {history.slice(0, 8).map((query) => (
            <button
              key={query}
              onClick={() => onPick(query)}
              className="rounded-full border border-border px-3 py-1 text-xs hover:bg-muted"
            >
              {query}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
