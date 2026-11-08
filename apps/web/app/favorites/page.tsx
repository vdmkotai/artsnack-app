"use client";

import {
  Suspense,
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { useConvexAuth, useMutation, useQuery as useLiveQuery } from "convex/react";
import { parseAsNativeArrayOf, parseAsString, parseAsStringLiteral, useQueryStates } from "nuqs";
import { toast } from "sonner";
import { useQuery, usePaginatedQuery } from "@/lib/convex-cache";
import { useToggleFavorite } from "@/hooks/use-toggle-favorite";
import { useImageSelection } from "@/hooks/use-image-selection";
import { useStableRows } from "@/hooks/use-stable-rows";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import type { FunctionReturnType } from "convex/server";
import { type LightboxMedia } from "@/components/media-lightbox";
import { GenerationLightbox } from "@/components/generation-lightbox";
import { ImageGrid, ImageGridItem, VideoGridItem } from "@/components/image-grid";
import { SelectionToolbar } from "@/components/selection-toolbar";
import {
  FavoriteFilterBar,
  FavoriteFolderBar,
  MoveToFolderPopover,
} from "@/components/favorites-controls";
import { FAVORITE_PROVIDER_LABELS, shortCheckpointName } from "@/lib/favorite-labels";
import { matchesFavoriteFilters, type FavoriteFilters } from "@/lib/favorite-filters";
import { Button } from "@/components/ui/button";
import { apiReproduceHref, enhanceReproduceHref, queueApiReference } from "@/lib/reference-handoff";
import { CheckSquare, Heart, Loader2, Sparkles, Trash2 } from "lucide-react";
import { GenerateFormState } from "@/lib/types";
import { mediaUrl, thumbUrl, videoPosterIfAvailable, videoUrl } from "@/lib/media-url";
import { cn } from "@/lib/utils";

const INITIAL_PAGE_SIZE = 30;
const LOAD_MORE_SIZE = 30;
/**
 * A filtered view can come back with only a few matches per page (the server
 * filters after paging), so it asks for bigger steps to fill the screen in
 * fewer round trips.
 */
const FILTERED_LOAD_MORE_SIZE = 90;

/**
 * Folder and filters live in the address bar so a view survives reload and
 * Back, and a folder can be linked. `folder` is "none" for the unfiled pool or
 * a folder id; the query normalizes garbage back to the All view. `p` and `cp`
 * repeat (`p=grok&p=atlas`), the grammar links already in the wild use.
 *
 * nuqs, not the router: `router.replace` is a navigation, and once the
 * prefetched copy of /favorites was over five minutes old every chip click
 * waited on a server round trip through the Clerk proxy — with the chip itself
 * not lighting up until it answered, so after a laptop slept or on a slow link
 * a click looked dead and a second click cancelled the first. nuqs updates its
 * state in the same render and writes the URL with `history.replaceState`,
 * which Next folds into useSearchParams without a request.
 */
const FILTER_PARAMS = {
  folder: parseAsString,
  type: parseAsStringLiteral(["image", "video"] as const),
  p: parseAsNativeArrayOf(parseAsString),
  cp: parseAsNativeArrayOf(parseAsString),
};

type Favorite = FunctionReturnType<typeof api.favorites.listFavorites>["page"][number];

type FavoriteItem = {
  favorite: Favorite;
  type: "image" | "video";
  url: string;
  thumb: string | undefined;
  /** A still for a clip, so the tile holds its place without loading video. */
  poster: string | undefined;
  aspect: number | undefined;
  badge: string;
};

function parseAspect(ratio: string | undefined): number | undefined {
  if (!ratio || ratio === "auto") return undefined;
  const [w, h] = ratio.split(":").map(Number);
  return w > 0 && h > 0 ? w / h : undefined;
}

// A self-hosted row knows its pixels; an API row only its requested ratio, and
// "auto" means neither — the tile then measures the file, which is why this
// still returns undefined. At module scope because the compiler bails on the
// nested ??/|| chain when it sits inside the map below.
function favoriteAspect(
  aspectRatio: string | undefined,
  formState: { width?: number; height?: number } | undefined,
): number | undefined {
  const declared = parseAspect(aspectRatio);
  if (declared !== undefined) return declared;
  return (Number(formState?.width) || 0) / (Number(formState?.height) || 1) || undefined;
}

/**
 * One grid entry per favourite row, built once per row object. Rows keep their
 * identity across pushes (useStableRows), so this keeps the item's too, and the
 * memoised grid tiles skip every row that did not change.
 */
const itemsByRow = new WeakMap<Favorite, FavoriteItem>();

function itemFor(favorite: Favorite): FavoriteItem {
  const known = itemsByRow.get(favorite);
  if (known) return known;
  const item: FavoriteItem = {
    favorite,
    type: favorite.mediaType,
    url: favorite.mediaType === "video" ? videoUrl(favorite.b2Key) : mediaUrl(favorite.b2Key),
    thumb: favorite.mediaType === "video" ? undefined : thumbUrl(favorite.b2Key),
    poster: favorite.mediaType === "video" ? videoPosterIfAvailable(favorite.b2Key) : undefined,
    aspect: favoriteAspect(favorite.aspectRatio, favorite.formState),
    // What made this image: the checkpoint for self-hosted rows, the provider
    // everywhere else.
    badge:
      favorite.provider === "self-hosted" && favorite.checkpoint
        ? shortCheckpointName(favorite.checkpoint)
        : (FAVORITE_PROVIDER_LABELS[favorite.provider] ?? favorite.provider),
  };
  itemsByRow.set(favorite, item);
  return item;
}

/**
 * Keeps the last value that was not `undefined`, so a query whose arguments
 * changed goes on showing its previous answer instead of blanking — the facet
 * counts and folder chips would otherwise vanish and reflow the filter bar under
 * the cursor on every folder switch.
 */
function useHeldValue<T>(value: T | undefined): T | undefined {
  const [held, setHeld] = useState(value);
  if (value !== undefined && value !== held) setHeld(value);
  return value ?? held;
}

export default function FavoritesPage() {
  // nuqs reads the search params, which need a Suspense boundary for the
  // static shell.
  return (
    <Suspense fallback={<FavoritesSkeleton />}>
      <FavoritesContent />
    </Suspense>
  );
}

function FavoritesContent() {
  const router = useRouter();
  const { isAuthenticated, isLoading: isAuthLoading } = useConvexAuth();

  // ---- URL state --------------------------------------------------------

  const [urlState, setUrlState] = useQueryStates(FILTER_PARAMS, {
    // A filter click refines where you are, it is not a place you were.
    history: "replace",
    scroll: false,
  });
  const folderParam = urlState.folder ?? undefined;
  const mediaType = urlState.type ?? undefined;
  const providers = urlState.p;
  const checkpoints = urlState.cp;

  const setFolder = useCallback(
    (value: string | undefined) => void setUrlState({ folder: value ?? null }),
    [setUrlState],
  );
  const setMediaType = useCallback(
    (value: "image" | "video" | undefined) => void setUrlState({ type: value ?? null }),
    [setUrlState],
  );
  const setProviders = useCallback(
    (values: string[]) => void setUrlState({ p: values }),
    [setUrlState],
  );
  const setCheckpoints = useCallback(
    (values: string[]) => void setUrlState({ cp: values }),
    [setUrlState],
  );
  // One write for the lot: three separate setters used to each rebuild the URL
  // from the same stale params, and only the last one stuck.
  const clearFilters = useCallback(
    () => void setUrlState({ type: null, p: null, cp: null }),
    [setUrlState],
  );
  const showEverything = useCallback(
    () => void setUrlState({ folder: null, type: null, p: null, cp: null }),
    [setUrlState],
  );

  // The chips above read `urlState` and flip in the click's own render; the
  // query and the grid follow from this deferred copy, so re-filtering a few
  // hundred tiles never holds the chip back.
  const filters = useMemo<FavoriteFilters>(
    () => ({ folder: folderParam, mediaType, providers, checkpoints }),
    [folderParam, mediaType, providers, checkpoints],
  );
  const shownFilters = useDeferredValue(filters);

  // ---- data ---------------------------------------------------------------

  const {
    results: favorites,
    status,
    loadMore,
  } = usePaginatedQuery(
    api.favorites.listFavorites,
    {
      folderId: shownFilters.folder,
      mediaType: shownFilters.mediaType,
      providers: shownFilters.providers?.length ? [...shownFilters.providers] : undefined,
      checkpoints: shownFilters.checkpoints?.length ? [...shownFilters.checkpoints] : undefined,
    },
    { initialNumItems: INITIAL_PAGE_SIZE },
  );
  const facets = useHeldValue(useQuery(api.favorites.facets, { folderId: shownFilters.folder }));
  const folderData = useHeldValue(useQuery(api.favoriteFolders.list));
  // The same subscription (Convex shares it), read live: only a list known to
  // be current may seed the folder editor.
  const liveFolderData = useLiveQuery(api.favoriteFolders.list);

  const isLoadingMore = status === "LoadingMore";
  const canLoadMore = status === "CanLoadMore";
  const isFirstPageLoading = status === "LoadingFirstPage";
  const hasAnyFilter = mediaType !== undefined || providers.length > 0 || checkpoints.length > 0;

  // While a new filter's first page is on its way, the rows already on screen
  // that still match it stay up (dimmed) instead of the page dropping to a
  // skeleton. Narrowing — All → Images, All → a folder — is therefore right
  // immediately; widening fills in when the server answers.
  const stableFavorites = useStableRows(favorites);
  const settled = useHeldValue(isFirstPageLoading ? undefined : stableFavorites);
  const rows = useMemo(
    () =>
      isFirstPageLoading
        ? (settled ?? []).filter((favorite) => matchesFavoriteFilters(favorite, shownFilters))
        : stableFavorites,
    [isFirstPageLoading, settled, stableFavorites, shownFilters],
  );
  const isRefreshing = (isFirstPageLoading && settled !== undefined) || filters !== shownFilters;
  // Nothing of the new view to show yet: a first visit, or a filter none of the
  // rows on screen survive.
  const hasNothingYet = isFirstPageLoading && rows.length === 0;

  // One entry per favourite, in page order, so the grid and the lightbox walk
  // the same sequence whether an item is a still or a clip.
  const items = useMemo(() => rows.map(itemFor), [rows]);

  const lightboxItems = useMemo<LightboxMedia[]>(
    () => items.map((item) => ({ url: item.url, type: item.type })),
    [items],
  );
  const byUrl = useMemo(() => {
    const map = new Map<string, FavoriteItem>();
    items.forEach((item) => map.set(item.url, item));
    return map;
  }, [items]);
  const indexByUrl = useMemo(() => {
    const map = new Map<string, number>();
    items.forEach((item, index) => map.set(item.url, index));
    return map;
  }, [items]);

  // Everything on this page is already a favorite.
  const favoritedUrls = useMemo(() => new Set(items.map((item) => item.url)), [items]);
  const toggleFavorite = useToggleFavorite();
  const removeMany = useMutation(api.favorites.removeMany);
  const moveToFolder = useMutation(api.favorites.moveToFolder);
  const createFolder = useMutation(api.favoriteFolders.create);

  // ---- selection ----------------------------------------------------------

  const orderedIds = useMemo(() => items.map((item) => item.favorite._id as string), [items]);
  const selection = useImageSelection(orderedIds);
  const { selectedKeys, selectionActive, handleSelect, enterSelection, exitSelection } = selection;
  const [isMutatingSelection, setIsMutatingSelection] = useState(false);

  const selectedFavoriteIds = useMemo(() => [...selectedKeys] as Id<"favorites">[], [selectedKeys]);

  // Promise chains rather than try/finally: the React Compiler cannot compile a
  // component that contains a `finally`, and this one renders the whole grid.
  const handleMoveSelection = useCallback(
    (folderId: Id<"favoriteFolders"> | undefined) => {
      if (selectedFavoriteIds.length === 0) return;
      setIsMutatingSelection(true);
      void moveToFolder({ favoriteIds: selectedFavoriteIds, folderId })
        .then(() => {
          toast.success(
            folderId
              ? `Moved ${selectedFavoriteIds.length} to the folder`
              : `Removed ${selectedFavoriteIds.length} from folders`,
          );
          exitSelection();
        })
        .catch((error: unknown) =>
          toast.error(error instanceof Error ? error.message : "Could not move favorites"),
        )
        .finally(() => setIsMutatingSelection(false));
    },
    [moveToFolder, selectedFavoriteIds, exitSelection],
  );

  const handleCreateAndMove = useCallback(
    (name: string) => {
      setIsMutatingSelection(true);
      void createFolder({ name })
        .then(({ folderId }) => moveToFolder({ favoriteIds: selectedFavoriteIds, folderId }))
        .then(() => {
          toast.success(`Moved ${selectedFavoriteIds.length} to "${name.trim()}"`);
          exitSelection();
        })
        .catch((error: unknown) =>
          toast.error(error instanceof Error ? error.message : "Could not create the folder"),
        )
        .finally(() => setIsMutatingSelection(false));
    },
    [createFolder, moveToFolder, selectedFavoriteIds, exitSelection],
  );

  const handleRemoveSelection = useCallback(() => {
    if (selectedFavoriteIds.length === 0) return;
    if (
      !window.confirm(
        `Remove ${selectedFavoriteIds.length} item${
          selectedFavoriteIds.length === 1 ? "" : "s"
        } from favorites?`,
      )
    ) {
      return;
    }
    setIsMutatingSelection(true);
    void removeMany({ favoriteIds: selectedFavoriteIds })
      .then(() => {
        toast.success("Removed from favorites");
        exitSelection();
      })
      .catch((error: unknown) =>
        toast.error(error instanceof Error ? error.message : "Could not remove favorites"),
      )
      .finally(() => setIsMutatingSelection(false));
  }, [removeMany, selectedFavoriteIds, exitSelection]);

  // ---- per-item actions ---------------------------------------------------

  /**
   * Reproduce lands wherever the media came from: an API row carries its
   * settings on the record and only the API tab can read them, and a
   * self-hosted one travels as the denormalised formState it was saved with.
   */
  const handleReproduce = useCallback(
    (url: string) => {
      const item = byUrl.get(url);
      if (!item) {
        // Only reachable if the grid and `byUrl` ever disagree, and silence here
        // is indistinguishable from a dead button.
        toast.error("Could not find that favorite");
        return;
      }
      const favorite = item.favorite;
      /**
       * Self-hosted is decided on positive evidence, not on the absence of an API
       * id. A hosted row carries no `formState` — the API tab reads its settings
       * back off the generation — so a `formState` can only have come from the
       * self-hosted side, and testing for it first means a row that somehow holds
       * both ids still reproduces into the composer that can actually use it.
       */
      if (favorite.formState) {
        sessionStorage.setItem("reproduce_state", JSON.stringify(favorite.formState));
        router.push("/generate?reproduce=true");
        return;
      }
      if (favorite.apiGenerationId) {
        router.push(apiReproduceHref(favorite.apiGenerationId));
        return;
      }
      // An enhanced image: neither a self-hosted formState nor an API row, so
      // it reproduces onto the Enhance page, which is the only composer that
      // has a mode and a source image.
      if (favorite.enhancementId) {
        router.push(enhanceReproduceHref(favorite.enhancementId));
        return;
      }
      toast.error("No settings were saved with this favorite");
    },
    [byUrl, router],
  );

  const handleSendToEnhance = useCallback(
    (url: string) => {
      const item = byUrl.get(url);
      // The lightbox offers one action bar for the whole sequence, so the clip
      // has to be turned away here rather than by hiding the button.
      if (item?.type === "video") {
        toast.error("Enhance works on images only");
        return;
      }
      const formState = item?.favorite.formState as GenerateFormState | undefined;
      sessionStorage.setItem(
        "enhance_source",
        JSON.stringify({ imageUrl: url, formState: formState ?? null }),
      );
      router.push("/enhance");
    },
    [byUrl, router],
  );

  const handleSendToApi = useCallback(
    (imageUrl: string) => {
      queueApiReference(imageUrl);
      router.push("/generate?tab=api");
    },
    [router],
  );

  const handleToggleFavorite = useCallback(
    (url: string) => {
      const favorite = byUrl.get(url)?.favorite;
      if (!favorite) return;
      // Each branch names the id the row actually carries. Un-favouriting only
      // ever takes the delete-existing path in `toggle`, so sending the wrong
      // one happened to work — until a double click raced the query round trip
      // and the second call fell through to "A generation id is required".
      void toggleFavorite(
        favorite.apiGenerationId
          ? { apiGenerationId: favorite.apiGenerationId, b2Key: favorite.b2Key }
          : favorite.enhancementId
            ? { enhancementId: favorite.enhancementId, b2Key: favorite.b2Key }
            : { generationId: favorite.generationId, b2Key: favorite.b2Key },
      );
    },
    [byUrl, toggleFavorite],
  );

  const [lightboxOpen, setLightboxOpen] = useState(false);
  const [lightboxIndex, setLightboxIndex] = useState(0);

  const handleOpen = useCallback(
    (event: React.MouseEvent, url: string) => {
      const item = byUrl.get(url);
      if (!item) return;
      if (selectionActive) {
        handleSelect(item.favorite._id, event.shiftKey);
        return;
      }
      setLightboxIndex(indexByUrl.get(url) ?? 0);
      setLightboxOpen(true);
    },
    [byUrl, indexByUrl, selectionActive, handleSelect],
  );

  const loadMoreStep = hasAnyFilter ? FILTERED_LOAD_MORE_SIZE : LOAD_MORE_SIZE;
  const handleLoadMore = useCallback(() => loadMore(loadMoreStep), [loadMore, loadMoreStep]);

  const loadMoreRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const sentinel = loadMoreRef.current;
    if (!sentinel || !canLoadMore) return;
    // Recreated on every status change, so a sentinel that is still in view
    // after a page lands (a sparse filter) asks again straight away.
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting) handleLoadMore();
      },
      { threshold: 0.1, rootMargin: "400px" },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [canLoadMore, handleLoadMore]);

  if (!isAuthLoading && !isAuthenticated) {
    return (
      <div className="w-full py-12 px-4 flex flex-col items-center justify-center min-h-[60vh] text-center text-muted-foreground">
        <div className="bg-muted/50 p-6 rounded-full mb-4">
          <Heart className="h-12 w-12 opacity-50" />
        </div>
        <h2 className="text-xl font-semibold mb-2">Sign in to view favorites</h2>
        <Link href="/sign-in" className="text-primary underline">
          Sign In
        </Link>
      </div>
    );
  }

  const hasScope = folderParam !== undefined || hasAnyFilter;
  // A filtered page can legitimately come back empty while more pages exist —
  // the verdict "nothing here" is only honest once paging has finished.
  const emptyAndDone = items.length === 0 && !canLoadMore && !isLoadingMore && !isFirstPageLoading;

  return (
    <div className="w-full py-6 px-4 lg:px-8">
      <div className="mb-4 flex items-center justify-between gap-4">
        <h1 className="text-2xl font-bold">Favorites</h1>
        {(items.length > 0 || selectionActive) && (
          <Button
            variant={selectionActive ? "secondary" : "outline"}
            size="sm"
            className="gap-1.5"
            onClick={() => (selectionActive ? exitSelection() : enterSelection())}
          >
            <CheckSquare className="h-4 w-4" />
            {selectionActive ? "Done" : "Select"}
          </Button>
        )}
      </div>

      {/* The controls never unmount: a filter change used to swap the whole page
          for a skeleton, taking the chip you had just pressed with it. */}
      <div className="mb-5 space-y-3">
        <FavoriteFolderBar
          selected={folderParam}
          onSelect={setFolder}
          folders={folderData?.folders ?? []}
          unfiled={folderData?.unfiled ?? 0}
          total={folderData?.total ?? 0}
          editable={liveFolderData !== undefined}
        />
        <FavoriteFilterBar
          mediaType={mediaType}
          onMediaType={setMediaType}
          providers={providers}
          onProviders={setProviders}
          checkpoints={checkpoints}
          onCheckpoints={setCheckpoints}
          onClear={clearFilters}
          facets={facets}
        />
      </div>

      {hasNothingYet || isAuthLoading ? (
        <GridSkeleton />
      ) : emptyAndDone ? (
        <div className="w-full py-12 px-4 flex flex-col items-center justify-center min-h-[40vh] text-center text-muted-foreground">
          <div className="bg-muted/50 p-6 rounded-full mb-4">
            <Heart className="h-12 w-12 opacity-50" />
          </div>
          {hasScope ? (
            <>
              <h2 className="text-xl font-semibold mb-2">Nothing here</h2>
              <p className="max-w-sm mx-auto mb-4">
                No favorites match this folder and these filters.
              </p>
              <Button variant="outline" size="sm" onClick={showEverything}>
                Show everything
              </Button>
            </>
          ) : (
            <>
              <h2 className="text-xl font-semibold mb-2">No favorites yet</h2>
              <p className="max-w-sm mx-auto">
                Tap the heart on any image or video to save it here.
              </p>
            </>
          )}
        </div>
      ) : (
        <div
          aria-busy={isRefreshing}
          className={cn("transition-opacity duration-150", isRefreshing && "opacity-60")}
        >
          <ImageGrid>
            {/* Every tile gets the same handlers and is keyed by its url, which
                the tile hands back — so the memo on the grid items holds and a
                push, a heart or a selection re-renders only the tiles it
                touched. The url alone is unique; folding the index in would
                remount every tile below a removal, re-downloading each clip. */}
            {items.map((item) =>
              item.type === "video" ? (
                <VideoGridItem
                  key={item.url}
                  itemKey={item.url}
                  src={item.url}
                  poster={item.poster}
                  alt={item.favorite.prompt ?? "Favorite"}
                  aspectRatio={item.aspect}
                  active={!lightboxOpen}
                  onClick={handleOpen}
                  onReproduce={handleReproduce}
                  copyPrompt={item.favorite.prompt}
                  isFavorited
                  onToggleFavorite={handleToggleFavorite}
                  selectionActive={selectionActive}
                  selected={selectedKeys.has(item.favorite._id)}
                  badge={item.badge}
                />
              ) : (
                <ImageGridItem
                  key={item.url}
                  itemKey={item.url}
                  src={item.thumb ?? item.url}
                  fallbackSrc={item.url}
                  aspectRatio={item.aspect}
                  alt={item.favorite.prompt ?? "Favorite"}
                  onClick={handleOpen}
                  onReproduce={handleReproduce}
                  onSendToEnhance={handleSendToEnhance}
                  onSendToApi={handleSendToApi}
                  copyPrompt={item.favorite.prompt}
                  isFavorited
                  onToggleFavorite={handleToggleFavorite}
                  selectionActive={selectionActive}
                  selected={selectedKeys.has(item.favorite._id)}
                  badge={item.badge}
                />
              ),
            )}
          </ImageGrid>
        </div>
      )}

      <div ref={loadMoreRef} className="flex justify-center py-8">
        {isLoadingMore && !isRefreshing && (
          <div className="flex items-center gap-2 text-muted-foreground">
            <Loader2 className="h-5 w-5 animate-spin" />
            <span>Loading more...</span>
          </div>
        )}
      </div>

      <SelectionToolbar count={selectedKeys.size} onClear={exitSelection}>
        <MoveToFolderPopover
          folders={folderData?.folders ?? []}
          busy={isMutatingSelection}
          onMove={handleMoveSelection}
          onCreateAndMove={handleCreateAndMove}
        />
        <Button
          variant="destructive"
          size="sm"
          className="gap-1.5"
          disabled={isMutatingSelection}
          onClick={handleRemoveSelection}
        >
          <Trash2 className="h-4 w-4" />
          Remove
        </Button>
      </SelectionToolbar>

      <GenerationLightbox
        getSource={(url) => {
          const favorite = byUrl.get(url)?.favorite;
          if (favorite?.apiGenerationId) return { kind: "api", id: favorite.apiGenerationId };
          if (favorite?.enhancementId) return { kind: "enhancement", id: favorite.enhancementId };
          return undefined;
        }}
        items={lightboxItems}
        initialIndex={lightboxIndex}
        isOpen={lightboxOpen}
        onClose={() => setLightboxOpen(false)}
        onReproduce={handleReproduce}
        onSendToEnhance={handleSendToEnhance}
        onToggleFavorite={handleToggleFavorite}
        favoritedUrls={favoritedUrls}
        onLoadMore={handleLoadMore}
        canLoadMore={canLoadMore}
        isLoadingMore={isLoadingMore}
        renderActions={(url) =>
          byUrl.get(url)?.type === "video" ? null : (
            <Button
              variant="ghost"
              size="icon"
              className="text-white/70 hover:text-white hover:bg-white/10"
              title="Send to API models as reference"
              onClick={() => handleSendToApi(url)}
            >
              <Sparkles className="h-6 w-6" />
              <span className="sr-only">Send to API models as reference</span>
            </Button>
          )
        }
      />
    </div>
  );
}

const SKELETON_ASPECTS = [3 / 4, 4 / 3, 1, 16 / 9, 3 / 4, 1, 4 / 3, 3 / 4];

function GridSkeleton() {
  return (
    <div className="flex flex-wrap gap-2 md:gap-4">
      {SKELETON_ASPECTS.map((ratio, index) => (
        <div
          key={index}
          className="bg-muted animate-pulse rounded-lg flex-shrink-0 h-[160px] md:h-[280px]"
          style={{ aspectRatio: ratio }}
        />
      ))}
    </div>
  );
}

/** The static shell's placeholder, before the search params are known. */
function FavoritesSkeleton() {
  return (
    <div className="w-full py-6 px-4 lg:px-8">
      <h1 className="mb-4 text-2xl font-bold">Favorites</h1>
      <div className="mb-5 h-[76px]" />
      <GridSkeleton />
    </div>
  );
}
