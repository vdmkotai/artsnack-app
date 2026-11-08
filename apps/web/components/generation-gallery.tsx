"use client";

import { memo, useState, useEffect, useLayoutEffect, useRef, useMemo, useCallback } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import {
  useConvexAuth,
  useMutation,
  type ReactMutation,
  type PaginationStatus,
} from "convex/react";
import { useQuery as useCachedQuery } from "@/lib/convex-cache";
import { api } from "@/convex/_generated/api";
import type { Doc, Id } from "@/convex/_generated/dataModel";
import { ImageLightbox } from "@/components/image-lightbox";
import { ImageGrid, ImageGridItem } from "@/components/image-grid";
import { SelectionToolbar } from "@/components/selection-toolbar";
import { Button } from "@/components/ui/button";
import { queueApiReference, queueApiReferences } from "@/lib/reference-handoff";
import { ImageIcon, Loader2, Sparkles } from "lucide-react";
import { GenerateFormState } from "@/lib/types";
import { mediaUrl, thumbUrl } from "@/lib/media-url";
import { useImageSelection } from "@/hooks/use-image-selection";
import { useStableRows } from "@/hooks/use-stable-rows";
import { useToggleFavorite } from "@/hooks/use-toggle-favorite";
import { toast } from "sonner";

const LOAD_MORE_SIZE = 15;

/**
 * The mutation call sits at module scope, outside the component. React Compiler
 * refuses to lower a `try` statement that has a finalizer or that contains a
 * ternary, and when it meets one it drops automatic memoization for the entire
 * enclosing component — the whole gallery grid, for two statements in here.
 *
 * Resolves true when the delete succeeded, which is what gates exiting
 * selection mode.
 */
async function deleteImages(
  removeImages: ReactMutation<typeof api.generations.removeImages>,
  images: Array<{ generationId: Id<"generations">; b2Key: string }>,
): Promise<boolean> {
  try {
    const removed = await removeImages({ images });
    toast.success(`Deleted ${removed} image${removed > 1 ? "s" : ""}`);
    return true;
  } catch (e) {
    console.error("Bulk delete failed:", e);
    toast.error("Failed to delete images");
    return false;
  }
}

/**
 * Keeps a callback's identity for the life of the component while always running
 * its latest version. Each tile gets the same function, so the memoised tiles skip
 * a render whenever only some other part of the gallery changed. The ref is
 * written after commit, which is before any click can call it.
 */
function useLatestCallback<Args extends unknown[], Result>(
  callback: (...args: Args) => Result,
): (...args: Args) => Result {
  const latest = useRef(callback);
  useLayoutEffect(() => {
    latest.current = callback;
  });
  return useCallback((...args: Args) => latest.current(...args), []);
}

/** One image of a generation, flattened out of its row for the grid. */
interface GalleryImage {
  /** `${generationId}:${b2Key}` — selection and React identity. */
  key: string;
  generationId: Id<"generations">;
  b2Key: string;
  /** Full size: the lightbox and every hand-off use this. */
  url: string;
  thumb: string;
  aspect: number;
  prompt?: string;
  formState: GenerateFormState;
}

function imagesOf(generations: readonly Doc<"generations">[]): GalleryImage[] {
  return generations.flatMap((g) => {
    // Old HF Space images are gone; rows without keys have nothing to show.
    if (!g.b2Keys || g.b2Keys.length === 0) return [];
    const aspect = (Number(g.formState?.width) || 1) / (Number(g.formState?.height) || 1);
    return g.b2Keys.map((key) => ({
      key: `${g._id}:${key}`,
      generationId: g._id,
      b2Key: key,
      url: mediaUrl(key),
      thumb: thumbUrl(key),
      aspect,
      prompt: g.formState?.prompt,
      formState: g.formState as GenerateFormState,
    }));
  });
}

/**
 * A grid tile, memoised on primitives and stable callbacks.
 *
 * The grid's own closures are built here, per tile, rather than in the gallery's
 * map: built there, every tile got new ones on every render — and the gallery
 * re-renders on every Convex push, including a running generation's progress.
 */
const GalleryTile = memo(function GalleryTile({
  itemKey,
  index,
  url,
  thumb,
  aspect,
  alt,
  prompt,
  formState,
  generationId,
  b2Key,
  selectionActive,
  selected,
  favorited,
  onActivate,
  onReproduce,
  onSendToEnhance,
  onSendToApi,
  onToggleFavorite,
}: {
  itemKey: string;
  index: number;
  url: string;
  thumb: string;
  aspect: number;
  alt: string;
  prompt?: string;
  formState: GenerateFormState;
  generationId: Id<"generations">;
  b2Key: string;
  selectionActive: boolean;
  selected: boolean;
  favorited: boolean;
  onActivate: (key: string, index: number, shiftKey: boolean) => void;
  onReproduce: (formState: GenerateFormState) => void;
  onSendToEnhance: (url: string, formState: GenerateFormState) => void;
  onSendToApi: (url: string) => void;
  onToggleFavorite: (generationId: Id<"generations">, b2Key: string) => void;
}) {
  return (
    <ImageGridItem
      src={thumb}
      fallbackSrc={url}
      aspectRatio={aspect}
      alt={alt}
      onClick={(e) => onActivate(itemKey, index, e.shiftKey)}
      selectionActive={selectionActive}
      selected={selected}
      scrollAnchorKey={itemKey}
      onReproduce={() => onReproduce(formState)}
      onSendToEnhance={() => onSendToEnhance(url, formState)}
      onSendToApi={() => onSendToApi(url)}
      copyPrompt={prompt}
      isFavorited={favorited}
      onToggleFavorite={() => onToggleFavorite(generationId, b2Key)}
    />
  );
});

interface GenerationGalleryProps {
  generations: Doc<"generations">[];
  status: PaginationStatus;
  loadMore: (numItems: number) => void;
  title: string;
  emptyTitle: string;
  emptyDescription: string;
  imageAltPrefix: string;
  allowReferenceSelection?: boolean;
  onBeforeNavigate?: () => void;
}

export function GenerationGallery({
  generations: liveGenerations,
  status,
  loadMore,
  title,
  emptyTitle,
  emptyDescription,
  imageAltPrefix,
  allowReferenceSelection = false,
  onBeforeNavigate,
}: GenerationGalleryProps) {
  const router = useRouter();
  const { isAuthenticated, isLoading: isAuthLoading } = useConvexAuth();
  const [lightboxOpen, setLightboxOpen] = useState(false);
  const [lightboxIndex, setLightboxIndex] = useState(0);

  // Rows whose content did not change keep their identity across pushes, so
  // every list derived from them below is only rebuilt when something did.
  const generations = useStableRows(liveGenerations);

  const observerRef = useRef<IntersectionObserver | null>(null);
  const loadMoreRef = useRef<HTMLDivElement | null>(null);

  const isLoadingMore = status === "LoadingMore";
  const canLoadMore = status === "CanLoadMore";
  const isDone = status === "Exhausted";
  const isInitialLoading = isAuthLoading || status === "LoadingFirstPage";

  const images = useMemo(() => imagesOf(generations), [generations]);

  /**
   * The URL and key lists are keyed on their joined contents, not on `images`: a
   * generation in progress is a row without keys, so its progress ticks change
   * the rows but not one image — and the lightbox and the selection hook then
   * see the very same arrays.
   */
  const urlSignature = images.map((image) => image.url).join("\n");
  const allImages = useMemo(() => (urlSignature ? urlSignature.split("\n") : []), [urlSignature]);
  const keySignature = images.map((image) => image.key).join("\n");
  const imageKeys = useMemo(() => (keySignature ? keySignature.split("\n") : []), [keySignature]);
  const imageByKey = useMemo(() => new Map(images.map((image) => [image.key, image])), [images]);
  const imageByUrl = useMemo(() => new Map(images.map((image) => [image.url, image])), [images]);

  const favKeys = useCachedQuery(api.favorites.myKeys);
  const favSet = useMemo(() => new Set(favKeys ?? []), [favKeys]);
  const toggleFavorite = useToggleFavorite();
  const removeImages = useMutation(api.generations.removeImages);

  // Selection is keyed by the stable per-image identity (never by array index)
  // so live prepends/pagination can't retarget it.
  const { selectedKeys, selectionActive, handleSelect, enterSelection, exitSelection } =
    useImageSelection(imageKeys);
  const [isDeleting, setIsDeleting] = useState(false);

  const handleBulkDelete = useCallback(async () => {
    if (selectedKeys.size === 0 || isDeleting) return;
    if (!window.confirm(`Delete ${selectedKeys.size} image${selectedKeys.size > 1 ? "s" : ""}?`))
      return;
    const targets = [...selectedKeys].flatMap((key) => {
      const image = imageByKey.get(key);
      // Only the two fields the mutation validates — the image also carries the
      // prompt for the copy button, which the argument validator rejects.
      return image ? [{ generationId: image.generationId, b2Key: image.b2Key }] : [];
    });
    setIsDeleting(true);
    const ok = await deleteImages(removeImages, targets);
    setIsDeleting(false);
    if (ok) exitSelection();
  }, [selectedKeys, isDeleting, imageByKey, removeImages, exitSelection]);

  useEffect(() => {
    if (!selectionActive || lightboxOpen) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        exitSelection();
        return;
      }
      if (allowReferenceSelection) return;
      if (e.key !== "Delete" && e.key !== "Backspace") return;
      if (e.repeat || e.metaKey || e.ctrlKey || e.altKey) return;
      const target = e.target as HTMLElement | null;
      if (target?.closest('input, textarea, select, [contenteditable="true"], [role="textbox"]'))
        return;
      e.preventDefault();
      void handleBulkDelete();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [selectionActive, lightboxOpen, allowReferenceSelection, handleBulkDelete, exitSelection]);

  const favoritedUrls = useMemo(() => {
    const s = new Set<string>();
    for (const image of images) if (favSet.has(image.b2Key)) s.add(image.url);
    return s;
  }, [images, favSet]);

  // ── Tile actions: stable, taking what they act on ────────────────────────
  const toggleFavoriteOf = useLatestCallback(
    (generationId: Id<"generations">, b2Key: string) =>
      void toggleFavorite({ generationId, b2Key }),
  );

  const reproduceWith = useLatestCallback((formState: GenerateFormState) => {
    onBeforeNavigate?.();
    sessionStorage.setItem("reproduce_state", JSON.stringify(formState));
    router.push("/generate?reproduce=true");
  });

  const sendToEnhanceWith = useLatestCallback(
    (imageUrl: string, formState: GenerateFormState | undefined) => {
      onBeforeNavigate?.();
      sessionStorage.setItem(
        "enhance_source",
        JSON.stringify({
          imageUrl,
          formState: formState || null,
        }),
      );
      router.push("/enhance");
    },
  );

  const handleSendToApi = useLatestCallback((imageUrl: string) => {
    onBeforeNavigate?.();
    queueApiReference(imageUrl);
    router.push("/generate?tab=api");
  });

  const activateTile = useLatestCallback((key: string, index: number, shiftKey: boolean) => {
    if (selectionActive || shiftKey) {
      handleSelect(key, shiftKey);
    } else {
      setLightboxIndex(index);
      setLightboxOpen(true);
    }
  });

  // ── Lightbox actions: by URL, which is all the lightbox knows ────────────
  const handleToggleFavorite = useCallback(
    (url: string) => {
      const image = imageByUrl.get(url);
      if (image) toggleFavoriteOf(image.generationId, image.b2Key);
    },
    [imageByUrl, toggleFavoriteOf],
  );

  const handleReproduce = useCallback(
    (imageUrl: string) => {
      const image = imageByUrl.get(imageUrl);
      if (image?.formState) reproduceWith(image.formState);
    },
    [imageByUrl, reproduceWith],
  );

  const handleSendToEnhance = useCallback(
    (imageUrl: string) => sendToEnhanceWith(imageUrl, imageByUrl.get(imageUrl)?.formState),
    [imageByUrl, sendToEnhanceWith],
  );

  const handleUseSelectedAsReferences = useCallback(() => {
    // Set iteration preserves insertion order: the first image clicked becomes
    // @image1 / the first provider slot, even if it sits later in the grid.
    const urls = [...selectedKeys].flatMap((key) => {
      const url = imageByKey.get(key)?.url;
      return url ? [url] : [];
    });
    if (urls.length === 0) return;
    onBeforeNavigate?.();
    queueApiReferences(urls);
    router.push("/generate?tab=api");
  }, [selectedKeys, imageByKey, onBeforeNavigate, router]);

  useEffect(() => {
    if (observerRef.current) {
      observerRef.current.disconnect();
    }

    observerRef.current = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting && canLoadMore && !isLoadingMore) {
          loadMore(LOAD_MORE_SIZE);
        }
      },
      { threshold: 0.1, rootMargin: "100px" },
    );

    if (loadMoreRef.current) {
      observerRef.current.observe(loadMoreRef.current);
    }

    return () => observerRef.current?.disconnect();
  }, [canLoadMore, isLoadingMore, loadMore]);

  const skeletonRatios = [3 / 4, 4 / 3, 1, 16 / 9, 3 / 4, 1, 4 / 3, 3 / 4, 16 / 9, 1, 4 / 3, 3 / 4];

  if (!isAuthLoading && !isAuthenticated) {
    return (
      <div className="container py-12 px-4 flex flex-col items-center justify-center min-h-[60vh] text-center text-muted-foreground">
        <div className="bg-muted/50 p-6 rounded-full mb-4">
          <ImageIcon className="h-12 w-12 opacity-50" />
        </div>
        <h2 className="text-xl font-semibold mb-2">Sign in to view gallery</h2>
        <p className="max-w-sm mx-auto mb-4">Please sign in to see your generated images.</p>
        <Link href="/sign-in" className="text-primary underline">
          Sign In
        </Link>
      </div>
    );
  }

  if (!isInitialLoading && allImages.length === 0) {
    return (
      <div className="container py-12 px-4 flex flex-col items-center justify-center min-h-[60vh] text-center text-muted-foreground">
        <div className="bg-muted/50 p-6 rounded-full mb-4">
          <ImageIcon className="h-12 w-12 opacity-50" />
        </div>
        <h2 className="text-xl font-semibold mb-2">{emptyTitle}</h2>
        <p className="max-w-sm mx-auto">{emptyDescription}</p>
      </div>
    );
  }

  return (
    <div className="w-full py-6 px-4 lg:px-8">
      {/* No mount gate: the server render and the first client render both see
          auth as loading and agree on the skeleton, so the header is painted at
          once and only the grid waits for data. */}
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold">{title}</h1>
        <Button
          variant={selectionActive ? "secondary" : "outline"}
          size="sm"
          onClick={selectionActive ? exitSelection : enterSelection}
          disabled={isInitialLoading}
        >
          {selectionActive ? "Cancel" : allowReferenceSelection ? "Select references" : "Select"}
        </Button>
      </div>

      {isInitialLoading ? (
        <div className="flex flex-wrap gap-2 md:gap-4">
          {skeletonRatios.map((ratio, i) => (
            <div
              key={i}
              className="bg-muted animate-pulse rounded-lg flex-shrink-0 h-[160px] md:h-[280px]"
              style={{ aspectRatio: ratio }}
            />
          ))}
        </div>
      ) : (
        <ImageGrid>
          {images.map((image, idx) => (
            <GalleryTile
              key={image.key}
              itemKey={image.key}
              index={idx}
              url={image.url}
              thumb={image.thumb}
              aspect={image.aspect}
              alt={`${imageAltPrefix} ${idx + 1}`}
              prompt={image.prompt}
              formState={image.formState}
              generationId={image.generationId}
              b2Key={image.b2Key}
              selectionActive={selectionActive}
              selected={selectedKeys.has(image.key)}
              favorited={favSet.has(image.b2Key)}
              onActivate={activateTile}
              onReproduce={reproduceWith}
              onSendToEnhance={sendToEnhanceWith}
              onSendToApi={handleSendToApi}
              onToggleFavorite={toggleFavoriteOf}
            />
          ))}
        </ImageGrid>
      )}

      <div ref={loadMoreRef} className="flex justify-center py-8">
        {isLoadingMore && (
          <div className="flex items-center gap-2 text-muted-foreground">
            <Loader2 className="h-5 w-5 animate-spin" />
            <span>Loading more...</span>
          </div>
        )}
        {isDone && allImages.length > 0 && (
          <span className="text-sm text-muted-foreground">No more images</span>
        )}
      </div>

      <SelectionToolbar
        count={selectedKeys.size}
        onDelete={() => void handleBulkDelete()}
        onClear={exitSelection}
        isDeleting={isDeleting}
        onUseAsReferences={allowReferenceSelection ? handleUseSelectedAsReferences : undefined}
      />

      <ImageLightbox
        images={allImages}
        initialIndex={lightboxIndex}
        isOpen={lightboxOpen}
        onClose={() => setLightboxOpen(false)}
        onReproduce={handleReproduce}
        onSendToEnhance={handleSendToEnhance}
        onToggleFavorite={handleToggleFavorite}
        favoritedUrls={favoritedUrls}
        onLoadMore={() => loadMore(LOAD_MORE_SIZE)}
        canLoadMore={canLoadMore}
        isLoadingMore={isLoadingMore}
        renderActions={(url) => (
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
        )}
      />
    </div>
  );
}
