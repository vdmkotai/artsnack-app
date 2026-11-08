"use client";

import { memo, useState, useEffect, useRef, useCallback, useLayoutEffect } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { History as HistoryIcon, Sparkles, Loader2 } from "lucide-react";
import { useMutation, useConvexAuth } from "convex/react";
import { usePaginatedQuery as useCachedPaginatedQuery } from "@/lib/convex-cache";
import { api } from "@/convex/_generated/api";
import type { Doc, Id } from "@/convex/_generated/dataModel";
import { GenerationCard } from "@/components/generation-card";
import { ImageLightbox } from "@/components/image-lightbox";
import { Button } from "@/components/ui/button";
import { queueApiReference } from "@/lib/reference-handoff";
import { mediaUrl } from "@/lib/media-url";
import type { GenerateFormState } from "@/lib/types";
import { GenerationProgress } from "@/components/generation-progress";
import { useStableRows } from "@/hooks/use-stable-rows";

const INITIAL_PAGE_SIZE = 20;

type GenerationRow = Doc<"generations">;

/**
 * One history entry: its status notice and its card.
 *
 * Memoised on the row, which `useStableRows` keeps identical while its content
 * is, and on callbacks that never change — so a running generation's progress
 * ticks re-render its own entry and nothing else on the page.
 */
const HistoryEntry = memo(function HistoryEntry({
  entry,
  onDelete,
  onReproduce,
  onImageClick,
  onSendToEnhance,
  onSendToApi,
}: {
  entry: GenerationRow;
  onDelete: (id: string) => Promise<void>;
  onReproduce: (formState: GenerateFormState) => void;
  onImageClick: (urls: string[], index: number, formState?: Record<string, unknown>) => void;
  onSendToEnhance: (imageUrl: string) => void;
  onSendToApi: (imageUrl: string) => void;
}) {
  return (
    // A pending or failed row otherwise renders as an ordinary card with an
    // empty image grid, indistinguishable from one whose files were deleted. The
    // card itself takes no status, so the notice sits above it.
    //
    // Off-screen entries skip layout and paint; `auto` remembers each one's real
    // height once it has been on screen, so the scrollbar does not drift.
    <div className="space-y-2 [content-visibility:auto] [contain-intrinsic-size:auto_520px]">
      {entry.status === "failed" ? (
        <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2">
          <p className="text-sm font-medium text-destructive">Failed</p>
          <p className="text-xs text-muted-foreground line-clamp-2">
            {entry.error || "Unknown error"}
          </p>
        </div>
      ) : entry.status === "pending" || entry.status === "processing" ? (
        <div className="flex items-center gap-3 rounded-md border border-border bg-muted/30 px-3 py-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 shrink-0 animate-spin" />
          <GenerationProgress value={{ ...entry, mediaType: "image" }} />
        </div>
      ) : null}
      <GenerationCard
        id={entry._id}
        timestamp={entry.timestamp}
        formState={entry.formState}
        b2Keys={entry.b2Keys}
        onDelete={onDelete}
        onReproduce={onReproduce}
        onImageClick={onImageClick}
        onSendToEnhance={onSendToEnhance}
        onSendToApi={onSendToApi}
      />
    </div>
  );
});

export default function HistoryPage() {
  const { isAuthenticated, isLoading: isAuthLoading } = useConvexAuth();
  const { results, status, loadMore } = useCachedPaginatedQuery(
    api.generations.listPaginated,
    {},
    {
      initialNumItems: INITIAL_PAGE_SIZE,
    },
  );
  // Every push hands back new objects for every row; this keeps the ones whose
  // content did not change, which is what lets the memoised entries skip.
  const generations = useStableRows(results);
  const removeGeneration = useMutation(api.generations.remove);

  const observerRef = useRef<IntersectionObserver | null>(null);
  const loadMoreRef = useRef<HTMLDivElement | null>(null);

  const isLoadingMore = status === "LoadingMore";
  const canLoadMore = status === "CanLoadMore";
  const isDone = status === "Exhausted";

  useEffect(() => {
    if (observerRef.current) {
      observerRef.current.disconnect();
    }

    observerRef.current = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting && canLoadMore && !isLoadingMore) {
          loadMore(INITIAL_PAGE_SIZE);
        }
      },
      { threshold: 0.1, rootMargin: "100px" },
    );

    if (loadMoreRef.current) {
      observerRef.current.observe(loadMoreRef.current);
    }

    return () => observerRef.current?.disconnect();
  }, [canLoadMore, isLoadingMore, loadMore]);

  const [lightboxImages, setLightboxImages] = useState<string[]>([]);
  const [lightboxIndex, setLightboxIndex] = useState(0);
  const [lightboxOpen, setLightboxOpen] = useState(false);
  const [lightboxFormState, setLightboxFormState] = useState<Record<string, unknown> | null>(null);
  const router = useRouter();

  const handleReproduce = useCallback(
    (formState: Record<string, unknown> | GenerateFormState) => {
      if (typeof window !== "undefined") {
        sessionStorage.setItem("reproduce_state", JSON.stringify(formState));
        router.push("/generate?reproduce=true");
      }
    },
    [router],
  );

  /**
   * Finds the generation behind a URL to carry its settings along. It reads the
   * rows through a ref so its identity never changes: it is handed to every
   * card, and depending on the list would re-render all of them on each push.
   */
  const latestGenerations = useRef(generations);
  useLayoutEffect(() => {
    latestGenerations.current = generations;
  });
  const handleSendToEnhance = useCallback(
    (imageUrl: string) => {
      // For history, find the generation that contains this imageUrl
      const generation = latestGenerations.current.find((g) =>
        (g.b2Keys ?? []).some((key) => mediaUrl(key) === imageUrl),
      );
      sessionStorage.setItem(
        "enhance_source",
        JSON.stringify({
          imageUrl,
          formState: generation?.formState || null,
        }),
      );
      router.push("/enhance");
    },
    [router],
  );

  const handleSendToApi = useCallback(
    (imageUrl: string) => {
      queueApiReference(imageUrl);
      router.push("/generate?tab=api");
    },
    [router],
  );

  const handleLightboxReproduce = useCallback(() => {
    if (lightboxFormState) {
      handleReproduce(lightboxFormState);
    }
  }, [lightboxFormState, handleReproduce]);

  const handleImageClick = useCallback(
    (imageUrls: string[], index: number, formState?: Record<string, unknown>) => {
      setLightboxImages(imageUrls);
      setLightboxIndex(index);
      setLightboxFormState(formState || null);
      setLightboxOpen(true);
    },
    [],
  );

  // Deliberately unguarded and un-toasted here: GenerationCard confirms first
  // and reports the outcome, so a rejection has to reach its catch.
  const handleDelete = useCallback(
    async (id: string) => {
      await removeGeneration({ id: id as Id<"generations"> });
    },
    [removeGeneration],
  );

  // No mount gate: the server render and the first client render both see auth
  // as loading, so they agree on the skeleton without one — and the header is
  // painted straight away instead of after an extra commit.
  const isInitialLoading = isAuthLoading || status === "LoadingFirstPage";

  // Show sign-in prompt if not authenticated
  if (!isAuthLoading && !isAuthenticated) {
    return (
      <div className="container flex flex-col items-center justify-center min-h-[calc(100vh-4rem)] py-12 px-4 text-center space-y-6">
        <div className="p-6 rounded-full bg-muted/30">
          <HistoryIcon className="h-12 w-12 text-muted-foreground/50" />
        </div>
        <div className="space-y-2 max-w-md">
          <h2 className="text-2xl font-bold tracking-tight">Sign in to view history</h2>
          <p className="text-muted-foreground">Please sign in to see your generated images.</p>
        </div>
        <Link href="/sign-in">
          <Button size="lg">Sign In</Button>
        </Link>
      </div>
    );
  }

  if (!isInitialLoading && generations.length === 0) {
    return (
      <div className="container flex flex-col items-center justify-center min-h-[calc(100vh-4rem)] py-12 px-4 text-center space-y-6">
        <div className="p-6 rounded-full bg-muted/30">
          <HistoryIcon className="h-12 w-12 text-muted-foreground/50" />
        </div>
        <div className="space-y-2 max-w-md">
          <h2 className="text-2xl font-bold tracking-tight">No history yet</h2>
          <p className="text-muted-foreground">
            Your generated images will appear here. Start creating to build your collection.
          </p>
        </div>
        <Link href="/generate">
          <Button size="lg" className="gap-2">
            <Sparkles className="h-4 w-4" />
            Start Generating
          </Button>
        </Link>
      </div>
    );
  }

  return (
    <div className="w-full py-8 px-4 lg:px-8 space-y-8">
      <div className="flex items-center justify-between">
        <h1 className="text-3xl font-bold tracking-tight">History</h1>
        {!isInitialLoading && (
          <span className="text-sm text-muted-foreground font-mono">
            {generations.length} {generations.length === 1 ? "entry" : "entries"}
          </span>
        )}
      </div>

      <div className="grid gap-6 grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5">
        {isInitialLoading
          ? [1, 2, 3, 4].map((i) => (
              <div key={i} className="h-[400px] bg-muted animate-pulse rounded-xl" />
            ))
          : generations.map((entry) => (
              <HistoryEntry
                key={entry._id}
                entry={entry}
                onDelete={handleDelete}
                onReproduce={handleReproduce}
                onImageClick={handleImageClick}
                onSendToEnhance={handleSendToEnhance}
                onSendToApi={handleSendToApi}
              />
            ))}
      </div>

      <div ref={loadMoreRef} className="flex justify-center py-8">
        {isLoadingMore && (
          <div className="flex items-center gap-2 text-muted-foreground">
            <Loader2 className="h-5 w-5 animate-spin" />
            <span>Loading more...</span>
          </div>
        )}
        {isDone && generations.length > 0 && (
          <span className="text-sm text-muted-foreground">No more entries</span>
        )}
      </div>

      <ImageLightbox
        images={lightboxImages}
        initialIndex={lightboxIndex}
        isOpen={lightboxOpen}
        onClose={() => setLightboxOpen(false)}
        onReproduce={lightboxFormState ? handleLightboxReproduce : undefined}
        onSendToEnhance={handleSendToEnhance}
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
