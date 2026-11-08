"use client";

import * as React from "react";
import {
  useQuery as useCachedQuery,
  usePaginatedQuery as useCachedPaginatedQuery,
} from "@/lib/convex-cache";
import { api } from "@/convex/_generated/api";
import { Folder, FolderOpen, Loader2, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { useInfiniteScroll } from "@/hooks/use-infinite-scroll";
import { mediaUrl, thumbUrl } from "@/lib/media-url";
import { cn } from "@/lib/utils";

const PAGE_SIZE = 40;

interface ReferencePickerProps {
  onClose: () => void;
  /** Called with the full-size image URL the user picked. */
  onPick: (url: string) => void;
}

type Source = "favorites" | "selfhosted" | "api";

const SOURCES: { value: Source; label: string }[] = [
  { value: "favorites", label: "Favorites" },
  { value: "selfhosted", label: "Self-hosted" },
  // Not "Grok": this tab has covered every hosted provider since the model
  // switcher landed, so a Higgsfield or fal result was always in here under a
  // name that said it wasn't.
  { value: "api", label: "API" },
];

/**
 * Modal gallery for picking a previously generated image as a reference.
 *
 * Favorites open first and are the point of the tab: the useful reference is
 * almost always one you already marked, and finding it by scrolling the full
 * history is the thing this saves you from. Since folders landed, the same
 * chips that scope /favorites scope this grid, so "the references live in one
 * folder" is one click here too.
 */
export function ReferencePicker({ onClose, onPick }: ReferencePickerProps) {
  const [source, setSource] = React.useState<Source>("favorites");
  /** undefined = All, "none" = Unfiled, else a folder id — listFavorites' dialect. */
  const [folder, setFolder] = React.useState<string | undefined>(undefined);

  const folderData = useCachedQuery(api.favoriteFolders.list);

  const favorites = useCachedPaginatedQuery(
    api.favorites.listFavorites,
    // The image filter runs server-side: clips are favorited alongside stills,
    // a reference has to be an image, and an mp4 in an <img> is a dead tile.
    { mediaType: "image", folderId: folder },
    { initialNumItems: PAGE_SIZE },
  );
  const selfHosted = useCachedPaginatedQuery(
    api.generations.listPaginated,
    {},
    { initialNumItems: PAGE_SIZE },
  );
  const hosted = useCachedPaginatedQuery(
    api.grokGenerations.list,
    {},
    { initialNumItems: PAGE_SIZE },
  );

  // Derived, not memoized: the React Compiler handles this component.
  const keys =
    source === "favorites"
      ? (favorites.results ?? []).map((favorite) => favorite.b2Key)
      : source === "selfhosted"
        ? (selfHosted.results ?? []).flatMap((g) =>
            g.status === "completed" || g.status === undefined ? (g.b2Keys ?? []) : [],
          )
        : (hosted.results ?? []).flatMap((g) => {
            if (g.status !== "completed" || g.mediaType !== "image") return [];
            if (g.b2Keys && g.b2Keys.length > 0) return g.b2Keys;
            return g.b2Key ? [g.b2Key] : [];
          });

  const active = source === "favorites" ? favorites : source === "selfhosted" ? selfHosted : hosted;
  const canLoadMore = active.status === "CanLoadMore";
  const isLoadingMore = active.status === "LoadingMore";
  const sentinelRef = useInfiniteScroll({
    onLoadMore: () => active.loadMore(PAGE_SIZE),
    hasMore: canLoadMore,
    busy: isLoadingMore,
    revision: keys.length,
    resetKey: `${source}:${folder ?? "all"}`,
    // All three sources are Convex histories, which end.
    maxIdlePagesOnScreen: Infinity,
  });

  React.useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  const folders = folderData?.folders ?? [];
  const showFolderRow = source === "favorites" && folders.length > 0;

  const folderChip = (activeChip: boolean) =>
    cn(
      "inline-flex max-w-48 items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs transition-colors",
      activeChip
        ? "border-primary bg-primary text-primary-foreground"
        : "border-border bg-muted/40 hover:bg-muted",
    );

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-4"
      onClick={onClose}
    >
      <div
        className="bg-background border rounded-xl w-full max-w-6xl h-[85vh] flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between gap-4 p-4 border-b">
          <h3 className="font-semibold">Pick a reference image</h3>
          <div className="flex items-center gap-2">
            <div
              role="group"
              aria-label="Pick a source"
              className="inline-flex items-center gap-1 p-1 rounded-lg border bg-card"
            >
              {SOURCES.map((entry) => (
                <Button
                  key={entry.value}
                  variant={source === entry.value ? "default" : "ghost"}
                  size="sm"
                  aria-pressed={source === entry.value}
                  onClick={() => setSource(entry.value)}
                >
                  {entry.label}
                </Button>
              ))}
            </div>
            <Button variant="ghost" size="icon" aria-label="Close picker" onClick={onClose}>
              <X className="h-5 w-5" />
            </Button>
          </div>
        </div>

        {showFolderRow && (
          <div
            className="flex flex-wrap items-center gap-1.5 border-b px-4 py-2.5"
            role="group"
            aria-label="Folder"
          >
            <button
              type="button"
              className={folderChip(folder === undefined)}
              onClick={() => setFolder(undefined)}
            >
              All
            </button>
            <button
              type="button"
              className={folderChip(folder === "none")}
              onClick={() => setFolder("none")}
            >
              Unfiled
              <span className="opacity-60">{folderData?.unfiled ?? 0}</span>
            </button>
            {folders.map((entry) => (
              <button
                key={entry._id}
                type="button"
                className={folderChip(folder === entry._id)}
                onClick={() => setFolder(entry._id)}
              >
                {folder === entry._id ? (
                  <FolderOpen className="h-3 w-3" />
                ) : (
                  <Folder className="h-3 w-3" />
                )}
                <span className="truncate">{entry.name}</span>
                <span className="opacity-60">{entry.count}</span>
              </button>
            ))}
          </div>
        )}

        <div className="flex-1 overflow-y-auto p-4">
          {active.status === "LoadingFirstPage" ? (
            <div className="h-full flex items-center justify-center">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
          ) : (
            <>
              {keys.length === 0 ? (
                <div className="py-16 flex items-center justify-center text-muted-foreground text-sm">
                  {canLoadMore || isLoadingMore ? "Looking for images..." : "No images here yet"}
                </div>
              ) : (
                <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6 xl:grid-cols-7 gap-2">
                  {keys.map((key, index) => (
                    <button
                      key={key}
                      type="button"
                      aria-label={`Use image ${index + 1} as reference`}
                      className={cn(
                        "relative aspect-square rounded-lg overflow-hidden border",
                        "hover:ring-2 hover:ring-primary transition-shadow",
                      )}
                      onClick={() => onPick(mediaUrl(key))}
                    >
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={thumbUrl(key, 256)}
                        alt=""
                        loading="lazy"
                        className="w-full h-full object-cover"
                      />
                    </button>
                  ))}
                </div>
              )}
              {(canLoadMore || isLoadingMore) && (
                <div ref={sentinelRef} className="flex justify-center py-4">
                  {isLoadingMore && (
                    <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
                  )}
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
