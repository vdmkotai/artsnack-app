"use client";

import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useTransition,
  type CSSProperties,
} from "react";
import { flushSync } from "react-dom";
import { useMutation } from "convex/react";
import { useQuery as useCachedQuery } from "@/lib/convex-cache";
import { useRouter } from "next/navigation";
import {
  Check,
  Copy,
  Download,
  Heart,
  ImagePlus,
  Loader2,
  Play,
  RefreshCw,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { useToggleFavorite } from "@/hooks/use-toggle-favorite";
import { copyText } from "@/lib/copy-text";
import { downloadMedia } from "@/lib/download-media";
import { mediaUrl, thumbUrl, videoPosterUrl, videoUrl } from "@/lib/media-url";
import { queueApiReference } from "@/lib/reference-handoff";
import type { SearchResult } from "@/lib/search";
import {
  FRESH_SEARCH_WINDOW,
  firstVisibleIndex,
  growSearchWindowAfter,
  growSearchWindowBefore,
  resolveSearchWindow,
  restoredAnchorIndex,
  restoredSearchWindow,
  type SearchScrollPosition,
  type SearchWindow,
} from "@/lib/search-window";

/** How far outside the viewport a sentinel starts mounting the next page. */
const SENTINEL_MARGIN = "800px 0px";

/**
 * The search grid.
 *
 * It mounts a window of the results (see lib/search-window.ts) that grows a
 * page at a time towards whichever edge the user scrolls to. An ordinary visit
 * starts at the top and only grows down. A return to a deep scroll position
 * starts at the remembered anchor instead: results from the anchor on go into
 * the normal container, and the few above it into a second one that is laid
 * out bottom-up (`flex-wrap-reverse` + `flex-row-reverse`, items in descending
 * order), so prepending earlier results only ever adds rows at its top and
 * never re-wraps a row the user can see.
 */
export function SearchResults({
  results,
  resetKey,
  restore,
  onRestored,
  onRememberScroll,
  selectionMode,
  selectedIds,
  onToggleSelected,
}: {
  results: SearchResult[];
  /** Identity of the search the results are for; a new one starts again at the top. */
  resetKey: string;
  /** Where an earlier visit to this search left the grid. */
  restore: SearchScrollPosition | null;
  /** Called once `restore` has been applied (or found not to apply). */
  onRestored: () => void;
  onRememberScroll: (position: SearchScrollPosition) => void;
  selectionMode: boolean;
  selectedIds: ReadonlySet<string>;
  onToggleSelected: (result: SearchResult) => void;
}) {
  const [initial] = useState(() => {
    if (!restore || restore.intentKey !== resetKey || results.length === 0) return null;
    const index = restoredAnchorIndex(results, restore);
    return { index, window: restoredSearchWindow(results, index) };
  });
  const [view, setView] = useState<{ key: string; window: SearchWindow }>(() => ({
    key: resetKey,
    window: initial?.window ?? FRESH_SEARCH_WINDOW,
  }));
  // A new search starts from the top. Reset as state rather than derived, so a
  // search that comes back (typing a letter and deleting it) does not revive a
  // window that was anchored deep in its old results.
  if (view.key !== resetKey) setView({ key: resetKey, window: FRESH_SEARCH_WINDOW });
  const current = view.key === resetKey ? view.window : FRESH_SEARCH_WINDOW;
  const range = useMemo(() => resolveSearchWindow(results, current), [results, current]);
  const earlier = useMemo(
    () => results.slice(range.start, range.pivot).reverse(),
    [results, range.start, range.pivot],
  );
  const shown = useMemo(
    () => results.slice(range.pivot, range.end),
    [results, range.pivot, range.end],
  );
  const hasEarlier = range.start > 0;
  const more = range.end < results.length;

  const earlierRef = useRef<HTMLDivElement>(null);
  const shownRef = useRef<HTMLDivElement>(null);
  const [growing, startGrowing] = useTransition();
  const [detail, setDetail] = useState<SearchResult | null>(null);
  const favoriteKeys = useCachedQuery(api.favorites.myKeys);
  const favorites = useMemo(() => new Set(favoriteKeys ?? []), [favoriteKeys]);
  const toggleFavorite = useToggleFavorite();
  const onToggleFavorite = (result: SearchResult) => {
    const { document, asset } = result;
    if (document.source === "api") {
      void toggleFavorite({
        apiGenerationId: document.id as Id<"grokGenerations">,
        b2Key: asset.key,
      });
    } else if (document.mediaType === "image") {
      void toggleFavorite({ generationId: document.id as Id<"generations">, b2Key: asset.key });
    }
  };

  const updateWindow = (update: (previous: SearchWindow) => SearchWindow) =>
    setView((previous) => ({ key: previous.key, window: update(previous.window) }));

  // Downwards in a transition: mounting a page of tiles must not hold up input.
  const loadMore = () => {
    if (more && !growing) startGrowing(() => updateWindow(growSearchWindowAfter));
  };
  // Upwards synchronously, because the scroll offset has to be corrected in the
  // same frame the rows above appear, or the viewport visibly jumps.
  const loadEarlier = () => {
    const below = shownRef.current;
    if (!hasEarlier || !below) return;
    const top = below.getBoundingClientRect().top;
    flushSync(() => updateWindow((previous) => growSearchWindowBefore(previous, range.pivot)));
    // Measured after the commit, so a browser that already anchored the scroll
    // (CSS scroll anchoring) leaves nothing to correct.
    const shift = below.getBoundingClientRect().top - top;
    if (shift !== 0) window.scrollBy(0, shift);
  };
  const bottomSentinel = useSearchSentinel(loadMore, more, growing, range.end);
  const topSentinel = useSearchSentinel(loadEarlier, hasEarlier, false, range.start);

  const keyRef = useRef(resetKey);
  useLayoutEffect(() => {
    keyRef.current = resetKey;
  }, [resetKey]);
  const capture = useCallback(() => {
    const anchor = readScrollAnchor(earlierRef.current, shownRef.current);
    if (anchor) onRememberScroll({ ...anchor, intentKey: keyRef.current });
  }, [onRememberScroll]);

  // The last position is taken as the grid unmounts — its DOM is still laid
  // out during layout-effect cleanup — so every way of leaving /search is
  // covered, and at the end of each scroll in case the page is left some other
  // way. Neither runs per scroll frame.
  useLayoutEffect(() => () => capture(), [capture]);
  useEffect(() => {
    if (typeof window === "undefined") return;
    // Safari before 26 has no `scrollend`; a short debounce stands in for it.
    if ("onscrollend" in (window as object)) {
      window.addEventListener("scrollend", capture, { passive: true });
      return () => window.removeEventListener("scrollend", capture);
    }
    let timer = 0;
    const onScroll = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(capture, 150);
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      window.removeEventListener("scroll", onScroll);
      window.clearTimeout(timer);
    };
  }, [capture]);

  useLayoutEffect(() => {
    if (!restore) return;
    const target = initial;
    const offset = restore.anchorOffset;
    const anchorKey = restore.anchorKey;
    // Deferred to a microtask: Next.js's own scroll handling for the route runs
    // in an ancestor's layout effect, after this one, and would scroll back to
    // the top. A microtask still runs before the browser paints.
    queueMicrotask(() => {
      const grid = shownRef.current;
      if (target && grid) {
        const tile =
          (anchorKey ? findTile(grid, "data-gallery-image-key", anchorKey) : null) ??
          findTile(grid, "data-search-index", String(target.index));
        if (tile) window.scrollBy(0, tile.getBoundingClientRect().top - offset);
      }
      onRestored();
    });
  }, [restore, initial, onRestored]);

  const tile = (result: SearchResult, index: number) => (
    <SearchTile
      key={result.id}
      result={result}
      index={index}
      selectionMode={selectionMode}
      selected={selectedIds.has(result.id)}
      onToggleSelected={onToggleSelected}
      onOpen={setDetail}
      favorited={favorites.has(result.asset.key)}
      onToggleFavorite={onToggleFavorite}
    />
  );

  return (
    <>
      {hasEarlier ? (
        <div
          ref={topSentinel}
          className="flex h-20 items-center justify-center text-muted-foreground"
        >
          <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          Rendering earlier
        </div>
      ) : null}
      {earlier.length > 0 ? (
        <div
          ref={earlierRef}
          className="mb-2 flex flex-row-reverse flex-wrap-reverse justify-end gap-2 md:mb-3 md:gap-3"
        >
          {earlier.map((result, offset) => tile(result, range.pivot - 1 - offset))}
        </div>
      ) : null}
      <div ref={shownRef} className="flex flex-wrap gap-2 md:gap-3">
        {shown.map((result, offset) => tile(result, range.pivot + offset))}
      </div>
      <div
        ref={bottomSentinel}
        className="flex h-20 items-center justify-center text-muted-foreground"
      >
        {more ? (
          <>
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            Rendering more
          </>
        ) : null}
      </div>
      <SearchDetail
        result={detail}
        open={Boolean(detail)}
        onOpenChange={(open) => !open && setDetail(null)}
        selected={detail ? selectedIds.has(detail.id) : false}
        onToggleSelected={onToggleSelected}
        onBeforeNavigate={capture}
        favorited={detail ? favorites.has(detail.asset.key) : false}
        onToggleFavorite={onToggleFavorite}
      />
    </>
  );
}

/**
 * Calls `onVisible` while the sentinel is within `SENTINEL_MARGIN` of the
 * viewport, and keeps calling it after each page while it still is.
 *
 * A fresh observer per page is what makes "still visible" work: an observer
 * only reports changes, but always reports the current state of an element it
 * starts observing. None is created while `busy`, so a page cannot be asked
 * for twice.
 */
function useSearchSentinel(
  onVisible: () => void,
  enabled: boolean,
  busy: boolean,
  revision: number,
): (node: HTMLElement | null) => void {
  const [node, setNode] = useState<HTMLElement | null>(null);
  const latest = useRef(onVisible);
  useLayoutEffect(() => {
    latest.current = onVisible;
  });
  useEffect(() => {
    if (!node || !enabled || busy || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) latest.current();
      },
      { rootMargin: SENTINEL_MARGIN },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [node, enabled, busy, revision]);
  return setNode;
}

/** The first tile at or below the header, in reading order across both containers. */
function readScrollAnchor(
  earlier: HTMLElement | null,
  shown: HTMLElement | null,
): Omit<SearchScrollPosition, "intentKey"> | null {
  // Hidden or not laid out: there is no position to take, keep the last one.
  if (!shown || shown.getClientRects().length === 0) return null;
  const tiles = earlier ? (Array.from(earlier.children) as HTMLElement[]).reverse() : [];
  for (const child of shown.children) tiles.push(child as HTMLElement);
  if (tiles.length === 0) return null;
  const headerBottom = document.querySelector("header")?.getBoundingClientRect().bottom ?? 0;
  const visible = firstVisibleIndex(tiles, headerBottom);
  const anchor = tiles[visible >= 0 ? visible : tiles.length - 1];
  return {
    anchorKey: anchor.dataset.galleryImageKey ?? null,
    anchorIndex: Number(anchor.dataset.searchIndex ?? 0),
    anchorOffset: anchor.getBoundingClientRect().top,
  };
}

function findTile(grid: HTMLElement, attribute: string, value: string): HTMLElement | null {
  return grid.querySelector<HTMLElement>(`[${attribute}="${CSS.escape(value)}"]`);
}

const SearchTile = memo(function SearchTile({
  result,
  index,
  selectionMode,
  selected,
  onToggleSelected,
  onOpen,
  favorited,
  onToggleFavorite,
}: {
  result: SearchResult;
  index: number;
  selectionMode: boolean;
  selected: boolean;
  onToggleSelected: (result: SearchResult) => void;
  onOpen: (result: SearchResult) => void;
  favorited: boolean;
  onToggleFavorite: (result: SearchResult) => void;
}) {
  const { document, asset } = result;
  const aspect = aspectOf(result);
  const full = document.mediaType === "video" ? videoUrl(asset.key) : mediaUrl(asset.key);
  const preview =
    document.mediaType === "video"
      ? asset.thumbnailKey
        ? thumbUrl(asset.thumbnailKey)
        : videoPosterUrl(asset.key)
      : thumbUrl(asset.key);
  const selectionAllowed = document.mediaType === "image";

  // `content-visibility: auto` lets the browser skip style, layout and paint
  // for off-screen tiles; the tile's own size is explicit, so nothing moves.
  // No backdrop blur on the badges: one blur layer per badge per tile was the
  // most expensive thing to composite while scrolling, and they already sit on
  // an opaque-enough dark background.
  return (
    <article
      data-gallery-image-key={result.id}
      data-search-index={index}
      className={`group relative h-[160px] w-[calc(var(--search-aspect)*160px)] max-w-full flex-none overflow-hidden rounded-lg bg-muted [contain-intrinsic-size:auto_160px] [content-visibility:auto] md:h-[260px] md:w-[calc(var(--search-aspect)*260px)] md:[contain-intrinsic-size:auto_260px] ${selectionMode && !selected ? "opacity-55" : ""}`}
      style={{ "--search-aspect": String(aspect), aspectRatio: aspect } as CSSProperties}
    >
      <button
        type="button"
        className="h-full w-full"
        onClick={() =>
          selectionMode && selectionAllowed ? onToggleSelected(result) : onOpen(result)
        }
        aria-label={`Open search result ${index + 1}`}
      >
        {document.mediaType === "video" ? (
          <img
            src={preview}
            alt={`Video result ${index + 1}`}
            loading="lazy"
            className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-[1.02]"
          />
        ) : (
          <img
            src={preview}
            data-fallback={full}
            alt={`Search result ${index + 1}`}
            loading="lazy"
            className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-[1.02]"
            onError={(event) => {
              const fallback = event.currentTarget.dataset.fallback;
              if (fallback && event.currentTarget.src !== fallback)
                event.currentTarget.src = fallback;
            }}
          />
        )}
      </button>
      <div className="pointer-events-none absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/90 via-black/55 to-transparent p-2 pt-10 text-white opacity-100 transition-opacity md:opacity-0 md:group-hover:opacity-100 md:group-focus-within:opacity-100">
        <p className="line-clamp-2 text-[11px] leading-snug">{document.prompt}</p>
        <p className="mt-1 truncate text-[10px] text-white/65">
          {result.reasons.length > 0
            ? `Matched ${result.reasons.map((reason) => `${reason.term} · ${reason.kind}`).join(", ")}`
            : "Recent generation"}
        </p>
        <p className="mt-1 truncate text-[10px] text-white/65">
          {document.modelLabel ?? document.model ?? document.checkpoints[0] ?? "Unknown model"}
          {document.loras.length > 0 ? ` · ${document.loras.length} LoRA` : ""}
        </p>
      </div>
      <div className="pointer-events-none absolute left-1.5 top-1.5 flex gap-1">
        <span className="rounded bg-black/60 px-1.5 py-0.5 text-[9px] font-medium uppercase text-white">
          {document.mediaType}
        </span>
        <span className="rounded bg-black/60 px-1.5 py-0.5 text-[9px] font-medium text-white">
          {document.provider}
        </span>
        {document.duration ? (
          <span className="rounded bg-black/60 px-1.5 py-0.5 text-[9px] text-white">
            {document.duration}s
          </span>
        ) : null}
      </div>
      {selectionAllowed ? (
        <button
          type="button"
          className={`absolute right-1.5 top-1.5 grid h-7 w-7 place-items-center rounded-full border text-white ${selected ? "border-primary bg-primary" : "border-white/70 bg-black/55"}`}
          onClick={(event) => {
            event.stopPropagation();
            onToggleSelected(result);
          }}
          aria-label={selected ? "Remove reference" : "Select as reference"}
        >
          {selected ? <Check className="h-4 w-4" /> : <ImagePlus className="h-4 w-4" />}
        </button>
      ) : (
        <span className="pointer-events-none absolute right-2 top-2 rounded-full bg-black/55 p-1.5 text-white">
          <Play className="h-3 w-3 fill-current" />
        </span>
      )}
      {document.mediaType === "image" || document.source === "api" ? (
        <button
          type="button"
          className="absolute right-1.5 top-10 grid h-7 w-7 place-items-center rounded-full border border-white/70 bg-black/55 text-white"
          aria-label={favorited ? "Remove from favorites" : "Add to favorites"}
          aria-pressed={favorited}
          onClick={() => onToggleFavorite(result)}
        >
          <Heart className={`h-4 w-4 ${favorited ? "fill-red-500 text-red-500" : ""}`} />
        </button>
      ) : null}
    </article>
  );
});

function SearchDetail({
  result,
  open,
  onOpenChange,
  selected,
  onToggleSelected,
  onBeforeNavigate,
  favorited,
  onToggleFavorite,
}: {
  result: SearchResult | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  selected: boolean;
  onToggleSelected: (result: SearchResult) => void;
  onBeforeNavigate: () => void;
  favorited: boolean;
  onToggleFavorite: (result: SearchResult) => void;
}) {
  const router = useRouter();
  const removeLocalImages = useMutation(api.generations.removeImages);
  const removeHosted = useMutation(api.grokGenerations.remove);
  const [deleting, setDeleting] = useState(false);
  const [copied, setCopied] = useState(false);

  const media = useMemo(
    () =>
      result
        ? result.document.mediaType === "video"
          ? videoUrl(result.asset.key)
          : mediaUrl(result.asset.key)
        : "",
    [result],
  );
  const reproduce = useCallback(() => {
    if (!result) return;
    onBeforeNavigate();
    if (result.document.source === "self-hosted" && result.document.localSettings) {
      sessionStorage.setItem("reproduce_state", JSON.stringify(result.document.localSettings));
      router.push("/generate?reproduce=true");
    } else if (result.document.provider === "comfy") {
      router.push(`/generate?tab=video&reproduceVideo=${encodeURIComponent(result.document.id)}`);
    } else if (result.document.source === "api") {
      router.push(`/generate?tab=api&reproduceApi=${encodeURIComponent(result.document.id)}`);
    }
  }, [result, onBeforeNavigate, router]);

  // A promise chain rather than try/finally, which the React Compiler cannot
  // lower — one such block opted the whole dialog out of compilation.
  const remove = useCallback(() => {
    if (!result || deleting || !window.confirm("Delete this result? This cannot be undone."))
      return;
    setDeleting(true);
    const removal =
      result.document.source === "api"
        ? removeHosted({ id: result.document.id as Id<"grokGenerations"> })
        : removeLocalImages({
            images: [
              { generationId: result.document.id as Id<"generations">, b2Key: result.asset.key },
            ],
          });
    void removal
      .then(
        () => {
          toast.success("Deleted");
          onOpenChange(false);
        },
        (error: unknown) => {
          toast.error(error instanceof Error ? error.message : "Could not delete result");
        },
      )
      .finally(() => setDeleting(false));
  }, [result, deleting, removeHosted, removeLocalImages, onOpenChange]);

  if (!result) return null;
  const document = result.document;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[92dvh] overflow-y-auto sm:max-w-4xl">
        <DialogHeader>
          <DialogTitle>Generation details</DialogTitle>
          <DialogDescription>
            {new Date(document.createdAt).toLocaleString()} · {document.source} ·{" "}
            {document.provider}
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-4 md:grid-cols-[minmax(0,1.2fr)_minmax(18rem,0.8fr)]">
          <div className="overflow-hidden rounded-xl bg-black/90">
            {document.mediaType === "video" ? (
              <video
                src={media}
                controls
                playsInline
                className="max-h-[70dvh] w-full object-contain"
              />
            ) : (
              <img
                src={media}
                alt="Search result"
                className="max-h-[70dvh] w-full object-contain"
              />
            )}
          </div>
          <div className="space-y-4 text-xs">
            <Detail label="Positive prompt" value={document.prompt} />
            {document.negativePrompt ? (
              <Detail label="Negative prompt" value={document.negativePrompt} />
            ) : null}
            <div className="grid grid-cols-2 gap-2 rounded-lg border border-border p-3">
              <Detail label="Model" value={document.modelLabel ?? document.model ?? "Unknown"} />
              <Detail label="Checkpoint" value={document.checkpoints.join(", ") || "—"} />
              <Detail label="LoRA" value={document.loras.join(", ") || "—"} />
              <Detail
                label="Size"
                value={
                  document.width && document.height
                    ? `${document.width}×${document.height}`
                    : (document.aspectRatio ?? "—")
                }
              />
              <Detail label="Sampler" value={document.sampler ?? "—"} />
              <Detail label="Scheduler" value={document.scheduler ?? "—"} />
              <Detail
                label="Steps / CFG"
                value={`${document.steps ?? "—"} / ${document.cfg ?? "—"}`}
              />
              <Detail label="Seed" value={document.seed?.toString() ?? "—"} />
            </div>
            <div className="flex flex-wrap gap-2">
              {document.mediaType === "image" || document.source === "api" ? (
                <Button
                  variant="outline"
                  aria-label={favorited ? "Remove from favorites" : "Add to favorites"}
                  aria-pressed={favorited}
                  onClick={() => onToggleFavorite(result)}
                >
                  <Heart className={favorited ? "fill-red-500 text-red-500" : ""} />
                  {favorited ? "Remove from favorites" : "Add to favorites"}
                </Button>
              ) : null}
              {document.mediaType === "image" ? (
                <Button
                  variant={selected ? "secondary" : "default"}
                  onClick={() => onToggleSelected(result)}
                >
                  <ImagePlus />
                  {selected ? "Reference selected" : "Use as reference"}
                </Button>
              ) : null}
              <Button
                variant="outline"
                onClick={() => {
                  void copyText(document.prompt).then((ok) => {
                    if (ok) {
                      setCopied(true);
                      window.setTimeout(() => setCopied(false), 1200);
                    }
                  });
                }}
              >
                {copied ? <Check /> : <Copy />}
                {copied ? "Copied" : "Copy prompt"}
              </Button>
              {document.localSettings || document.source === "api" ? (
                <Button variant="outline" onClick={reproduce}>
                  <RefreshCw />
                  Reproduce
                </Button>
              ) : null}
              <Button
                variant="outline"
                onClick={() =>
                  void downloadMedia({
                    url: media,
                    type: document.mediaType,
                    name: "artsnack-search",
                  })
                }
              >
                <Download />
                Download
              </Button>
              <Button variant="destructive" disabled={deleting} onClick={remove}>
                <Trash2 />
                Delete
              </Button>
            </div>
            {document.mediaType === "image" ? (
              <Button
                variant="ghost"
                onClick={() => {
                  onBeforeNavigate();
                  queueApiReference(media);
                  router.push("/generate?tab=api");
                }}
              >
                Send this one now
              </Button>
            ) : null}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
        {label}
      </p>
      <p className="whitespace-pre-wrap break-words">{value}</p>
    </div>
  );
}

function aspectOf(result: SearchResult): number {
  const { document } = result;
  if (document.width && document.height)
    return Math.max(0.5, Math.min(2, document.width / document.height));
  if (document.aspectRatio) {
    const [width, height] = document.aspectRatio.split(":").map(Number);
    if (width > 0 && height > 0) return Math.max(0.5, Math.min(2, width / height));
  }
  return document.mediaType === "video" ? 16 / 9 : 1;
}
