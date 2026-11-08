"use client";

import { useState, useEffect, useEffectEvent, useCallback, useRef } from "react";
import {
  X,
  ChevronLeft,
  ChevronRight,
  Download,
  ImageOff,
  RefreshCw,
  Loader2,
  Zap,
  Heart,
  Info,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { VideoViewer } from "@/components/video-viewer";
import { cn } from "@/lib/utils";
import { downloadMedia } from "@/lib/download-media";
import { prefetchMedia } from "@/lib/media-cache";

export type LightboxMedia = {
  url: string;
  type: "image" | "video";
  poster?: string;
};

export interface MediaLightboxProps {
  /** Temporarily yield the dialog to a reference while keeping the gallery position. */
  suspended?: boolean;
  onBack?: () => void;
  renderSidebar?: (url: string) => React.ReactNode;
  items: LightboxMedia[];
  initialIndex: number;
  isOpen: boolean;
  onClose: () => void;
  onReproduce?: (url: string) => void;
  onSendToEnhance?: (url: string) => void;
  onToggleFavorite?: (url: string) => void;
  favoritedUrls?: Set<string>;
  onLoadMore?: () => void;
  canLoadMore?: boolean;
  isLoadingMore?: boolean;
  /** Extra action buttons for the top-right action bar (rendered leftmost). */
  renderActions?: (url: string) => React.ReactNode;
  /**
   * An Info button (and the `i` key) that toggles a details sidebar, shown for
   * items this returns true for. The sidebar itself is `renderSidebar`'s job;
   * the lightbox only owns the button, so its place in the bar is the same on
   * every page.
   */
  infoAvailable?: (url: string) => boolean;
  infoOpen?: boolean;
  onToggleInfo?: () => void;
}

/**
 * Full-view media browser. Images and videos share one navigation sequence, so
 * arrows and swipes move through the whole result set regardless of type.
 */
export function MediaLightbox({
  items,
  initialIndex,
  isOpen,
  onClose,
  onReproduce,
  onSendToEnhance,
  onToggleFavorite,
  favoritedUrls,
  onLoadMore,
  canLoadMore,
  isLoadingMore,
  renderActions,
  renderSidebar,
  suspended = false,
  onBack,
  infoAvailable,
  infoOpen = false,
  onToggleInfo,
}: MediaLightboxProps) {
  const isActive = isOpen && !suspended;
  /**
   * The item being looked at, remembered by identity rather than by position.
   *
   * Every page that opens this lightbox feeds it a live list, and the newest row
   * comes first: a generation finishing while the view is open unshifts onto the
   * front and pushes every index along. The index shown is therefore *derived*
   * from this url on every render, never stored and then corrected.
   *
   * It used to be stored and corrected, and the correction was the bug: the pass
   * that noticed the shift still rendered with the old index, so for that one
   * pass "the current url" was whichever result had slid into the old slot. That
   * frame was never painted, but the load-state reset keyed on the url saw it —
   * and dropped the open image behind the spinner for good, because its `src`
   * never changed and no second `load` event was ever coming. What was left on
   * screen was a spinner over the grid's newest tiles, showing faintly through the
   * backdrop: to the user, the picture had been swapped for the one that just
   * finished.
   */
  const [anchorUrl, setAnchorUrl] = useState<string | null>(() =>
    isOpen ? (items[initialIndex]?.url ?? null) : null,
  );
  /**
   * Where the anchor was last seen. Only read when the anchor is not in the list:
   * deleted, unfavourited off the Favorites page, or a page of the live query
   * briefly missing — the view then holds that position instead of jumping.
   */
  const [position, setPosition] = useState(initialIndex);
  /**
   * What is on screen while the anchor is missing, pinned the same way, so a
   * result finishing *then* does not move the stand-in either. The anchor itself
   * is kept: if it comes back (a page that was only reloading), the view returns
   * to it.
   */
  const [standInUrl, setStandInUrl] = useState<string | null>(null);
  /** Load state belongs to a url, so a list that moves under it cannot reset it. */
  const [loadedUrl, setLoadedUrl] = useState<string | null>(null);
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const touchStartX = useRef<number | null>(null);
  const touchEndX = useRef<number | null>(null);
  /**
   * The item Next was pressed on at the end of the list: once the extra page
   * lands, step from *it* onto the first new item. A url rather than a flag, so
   * moving anywhere else in the meantime (Prev) cancels the step instead of it
   * firing later from wherever the view has got to.
   */
  const advanceFrom = useRef<string | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);

  // Opening re-anchors on `initialIndex`. Adjusted during render rather than in
  // an effect so no frame shows the previous item, and read back through locals
  // so this same pass already resolves the new item instead of the old anchor.
  // https://react.dev/learn/you-might-not-need-an-effect#adjusting-some-state-when-a-prop-changes
  const [prevIsOpen, setPrevIsOpen] = useState(isOpen);
  let anchor = anchorUrl;
  let lastPosition = position;
  let standIn = standInUrl;
  if (isOpen !== prevIsOpen) {
    setPrevIsOpen(isOpen);
    anchor = isOpen ? (items[initialIndex]?.url ?? null) : null;
    lastPosition = initialIndex;
    standIn = null;
    setAnchorUrl(anchor);
    setPosition(lastPosition);
    setStandInUrl(null);
    setFailedUrl(null);
  }

  const indexOf = (url: string | null) =>
    url === null ? -1 : items.findIndex((item) => item.url === url);
  const anchoredIndex = indexOf(anchor);
  const standInIndex = anchoredIndex === -1 ? indexOf(standIn) : -1;
  // Clamped because the list can also shrink past the end — unfavouriting the
  // last item on a page built from favourites. Left pointing past the end,
  // nothing renders, and because the component stays mounted the scroll lock
  // below is never released: the page freezes with no way back but a reload.
  const currentIndex =
    anchoredIndex !== -1
      ? anchoredIndex
      : standInIndex !== -1
        ? standInIndex
        : Math.max(0, Math.min(lastPosition, items.length - 1));
  const current = items[currentIndex];
  const currentUrl = current?.url;

  if (isOpen && current) {
    if (anchor === null) {
      // Mounted already open on an empty list: adopt the first thing shown.
      setAnchorUrl(current.url);
    } else if (anchoredIndex === -1 && standInIndex === -1) {
      setStandInUrl(current.url);
    } else if (anchoredIndex !== -1 && standIn !== null) {
      // The anchor is back; a stand-in left over would be reused, stale, the
      // next time it goes missing.
      setStandInUrl(null);
    }
    if (currentIndex !== lastPosition) setPosition(currentIndex);
  }

  const imageError = !!currentUrl && failedUrl === currentUrl;
  const imageLoading = !!currentUrl && loadedUrl !== currentUrl && !imageError;

  // Nothing left to show. Closing has to happen in an effect — it calls back
  // into the parent, which cannot be done during render.
  useEffect(() => {
    if (isOpen && items.length === 0) onClose();
  }, [isOpen, items.length, onClose]);

  useEffect(() => {
    if (!isActive) return;
    // Once focus is trapped in here we own it, so remember where it came from
    // and hand it back on close — otherwise the grid behind loses its place.
    const returnFocusTo = document.activeElement as HTMLElement | null;
    document.body.style.overflow = "hidden";
    dialogRef.current?.focus({ preventScroll: true });
    return () => {
      document.body.style.overflow = "";
      returnFocusTo?.focus?.();
      // A Next press that never got its page must not fire into the next open.
      advanceFrom.current = null;
    };
  }, [isActive]);

  useEffect(() => {
    if (!isOpen || !onLoadMore || !canLoadMore) return;
    if (currentIndex >= items.length - 3) {
      onLoadMore();
    }
  }, [isOpen, currentIndex, items.length, canLoadMore, onLoadMore]);

  /**
   * Move to a position, re-pinning the anchor to whatever lives there. A failed
   * image gets another try when it is navigated back to, as it did when the
   * error was reset on every change of item.
   */
  const goTo = useCallback(
    (index: number) => {
      if (index < 0 || index > items.length - 1) return;
      setAnchorUrl(items[index]?.url ?? null);
      setPosition(index);
      setStandInUrl(null);
      setFailedUrl(null);
    },
    [items],
  );

  // "Load more" appends, so the item to step onto does not exist yet at the
  // moment Next is pressed at the end; this lands the press when the page
  // arrives. It used to be inferred from the list simply getting longer, which
  // a finished generation does too — the two were indistinguishable, so one
  // could be mistaken for the other. Now only a real Next press arms it, and a
  // result prepended meanwhile cannot set it off: the armed item is still the
  // last one until the page itself appends.
  useEffect(() => {
    const from = advanceFrom.current;
    if (!isOpen || from === null) return;
    if (currentUrl !== from) {
      advanceFrom.current = null;
      return;
    }
    if (currentIndex < items.length - 1) {
      advanceFrom.current = null;
      goTo(currentIndex + 1);
    }
  }, [isOpen, items.length, currentIndex, currentUrl, goTo]);

  const handlePrev = useCallback(() => {
    goTo(currentIndex - 1);
  }, [goTo, currentIndex]);

  const handleNext = useCallback(() => {
    if (currentIndex < items.length - 1) {
      goTo(currentIndex + 1);
    } else if (canLoadMore && onLoadMore) {
      advanceFrom.current = currentUrl ?? null;
      onLoadMore();
    }
  }, [goTo, currentIndex, currentUrl, items.length, canLoadMore, onLoadMore]);

  const handleDownload = useCallback(() => {
    const item = items[currentIndex];
    if (!item) return;
    void downloadMedia({
      url: item.url,
      type: item.type,
      name: `artsnack-${item.type}-${currentIndex + 1}`,
    });
  }, [items, currentIndex]);

  const handleTouchStart = useCallback((e: React.TouchEvent) => {
    // Dragging the scrubber must not read as a swipe between items.
    if ((e.target as HTMLElement).closest("[data-video-controls], [data-reference-panel]")) {
      touchStartX.current = null;
      return;
    }
    touchStartX.current = e.targetTouches[0].clientX;
  }, []);

  const handleTouchMove = useCallback((e: React.TouchEvent) => {
    if (touchStartX.current === null) return;
    touchEndX.current = e.targetTouches[0].clientX;
  }, []);

  const handleTouchEnd = useCallback(() => {
    if (!touchStartX.current || !touchEndX.current) return;

    const diff = touchStartX.current - touchEndX.current;
    const threshold = 50;

    if (diff > threshold) {
      handleNext();
    } else if (diff < -threshold) {
      handlePrev();
    }

    touchStartX.current = null;
    touchEndX.current = null;
  }, [handleNext, handlePrev]);

  const currentHasInfo =
    !!onToggleInfo && !!currentUrl && (infoAvailable ? infoAvailable(currentUrl) : true);

  /**
   * An Effect Event, so the listener is bound once per opening and always sees the
   * current handlers. It used to be re-registered whenever any of them changed —
   * and the pages hand over new ones on every grid render, so a lightbox that was
   * not even open re-bound a window listener each time a result arrived.
   */
  const handleKeyDown = useEffectEvent((e: KeyboardEvent) => {
    switch (e.key) {
      case "i":
      case "I": {
        if (!currentHasInfo || e.metaKey || e.ctrlKey || e.altKey) break;
        // Typing in a field inside the panel must not fold it away.
        const target = e.target as HTMLElement | null;
        if (target?.closest?.("input, textarea, [contenteditable='true']")) break;
        onToggleInfo?.();
        break;
      }
      case "Escape":
        onClose();
        break;
      case "ArrowLeft":
        handlePrev();
        break;
      case "ArrowRight":
        handleNext();
        break;
      case "Tab": {
        // The lightbox covers the page, so Tab must not walk into the grid
        // underneath it.
        const root = dialogRef.current;
        if (!root) break;
        const focusable = Array.from(
          root.querySelectorAll<HTMLElement>("button:not([disabled]), [href]"),
        );
        if (focusable.length === 0) break;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        const active = document.activeElement;
        // Focus starts on the dialog itself, which is in neither end of the
        // list — without this, the first Shift+Tab walks out of the trap.
        if (!root.contains(active) || active === root) {
          e.preventDefault();
          (e.shiftKey ? last : first).focus();
        } else if (e.shiftKey && active === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && active === last) {
          e.preventDefault();
          first.focus();
        }
        break;
      }
    }
  });

  // Attached only while the dialog is active: a closed or suspended lightbox owns
  // no keys at all.
  useEffect(() => {
    if (!isActive) return;
    const listener = (e: KeyboardEvent) => handleKeyDown(e);
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, [isActive]);

  /**
   * The media cache no longer downloads clips for grid tiles on its own, so a clip
   * opened here is handed to it explicitly — and the next item too, when it is a
   * clip, since arrowing on is the likeliest next move. Keyed on the URLs, so
   * re-renders of the same item do not re-post.
   */
  const videoToCache =
    isActive && items[currentIndex]?.type === "video" ? items[currentIndex].url : null;
  const nextVideoToCache =
    isActive && items[currentIndex + 1]?.type === "video" ? items[currentIndex + 1].url : null;
  useEffect(() => {
    if (!videoToCache && !nextVideoToCache) return;
    prefetchMedia([videoToCache, nextVideoToCache]);
  }, [videoToCache, nextVideoToCache]);

  if (!isActive || !current) return null;

  return (
    <div
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-label={current.type === "video" ? "Video viewer" : "Image viewer"}
      tabIndex={-1}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/95 outline-none animate-in fade-in duration-200"
      onTouchStart={handleTouchStart}
      onTouchMove={handleTouchMove}
      onTouchEnd={handleTouchEnd}
    >
      <div className="absolute left-4 right-4 top-14 z-50 flex flex-wrap items-center justify-end gap-1 sm:left-auto sm:top-4 sm:gap-2">
        {renderActions?.(current.url)}

        {onToggleFavorite && (
          <Button
            variant="ghost"
            size="icon"
            className="text-white/70 hover:text-white hover:bg-white/10"
            onClick={() => onToggleFavorite(current.url)}
          >
            <Heart
              className={cn(
                "h-6 w-6",
                favoritedUrls?.has(current.url) && "fill-red-500 text-red-500",
              )}
            />
            <span className="sr-only">Toggle favorite</span>
          </Button>
        )}

        {onSendToEnhance && (
          <Button
            variant="ghost"
            size="icon"
            className="text-white/70 hover:text-white hover:bg-white/10"
            onClick={() => onSendToEnhance(current.url)}
            disabled={imageError}
          >
            <Zap className="h-6 w-6" />
            <span className="sr-only">Send to Enhance</span>
          </Button>
        )}

        {onReproduce && (
          <Button
            variant="ghost"
            size="icon"
            className="text-white/70 hover:text-white hover:bg-white/10"
            onClick={() => onReproduce(current.url)}
            disabled={imageError}
          >
            <RefreshCw className="h-6 w-6" />
            <span className="sr-only">Reproduce Settings</span>
          </Button>
        )}

        {currentHasInfo && (
          <Button
            variant="ghost"
            size="icon"
            aria-pressed={infoOpen}
            title={infoOpen ? "Hide details (i)" : "Show details (i)"}
            className={cn(
              "text-white/70 hover:text-white hover:bg-white/10",
              infoOpen && "bg-white/15 text-white",
            )}
            onClick={onToggleInfo}
          >
            <Info className="h-6 w-6" />
            <span className="sr-only">{infoOpen ? "Hide details" : "Show details"}</span>
          </Button>
        )}

        <Button
          variant="ghost"
          size="icon"
          className="text-white/70 hover:text-white hover:bg-white/10"
          onClick={handleDownload}
          disabled={imageError}
        >
          <Download className="h-6 w-6" />
          <span className="sr-only">Download</span>
        </Button>

        <Button
          variant="ghost"
          size="icon"
          className="text-white/70 hover:text-white hover:bg-white/10"
          onClick={onClose}
        >
          <X className="h-6 w-6" />
          <span className="sr-only">Close</span>
        </Button>
      </div>

      <div className="absolute left-4 top-4 text-white/70 font-medium z-50">
        {onBack ? (
          <Button
            variant="ghost"
            onClick={onBack}
            className="text-white/70 hover:text-white hover:bg-white/10"
          >
            <ChevronLeft className="h-5 w-5" /> Back
          </Button>
        ) : (
          <>
            {currentIndex + 1} / {items.length}
          </>
        )}
      </div>

      <Button
        variant="ghost"
        size="icon"
        className={cn(
          "absolute left-4 top-1/2 -translate-y-1/2 text-white/70 hover:text-white hover:bg-white/10 h-12 w-12 z-50",
          currentIndex === 0 && "opacity-0 pointer-events-none",
        )}
        disabled={currentIndex === 0}
        onClick={handlePrev}
      >
        <ChevronLeft className="h-8 w-8" />
        <span className="sr-only">Previous</span>
      </Button>

      <Button
        variant="ghost"
        size="icon"
        className={cn(
          "absolute right-4 top-1/2 -translate-y-1/2 text-white/70 hover:text-white hover:bg-white/10 h-12 w-12 z-50",
          currentIndex === items.length - 1 &&
            !canLoadMore &&
            !isLoadingMore &&
            "opacity-0 pointer-events-none",
        )}
        disabled={currentIndex === items.length - 1 && !canLoadMore}
        onClick={handleNext}
      >
        {isLoadingMore && currentIndex === items.length - 1 ? (
          <Loader2 className="h-6 w-6 animate-spin" />
        ) : (
          <ChevronRight className="h-8 w-8" />
        )}
        <span className="sr-only">Next</span>
      </Button>

      <div className="flex h-full w-full flex-col gap-4 px-4 pb-4 pt-36 sm:pt-20 md:flex-row md:px-20 md:pb-12">
        <div className="relative flex min-h-0 min-w-0 flex-1 items-center justify-center">
          {current.type === "video" ? (
            <VideoViewer key={current.url} src={current.url} poster={current.poster} />
          ) : imageError ? (
            <div className="flex flex-col items-center justify-center text-white/50">
              <ImageOff className="h-16 w-16 mb-4" />
              <p className="text-lg">Image unavailable</p>
              <p className="text-sm mt-1">The backend server may be offline</p>
            </div>
          ) : (
            <>
              {/* Keyed by url, so every image is a fresh element whose own `load`
                  marks *it* loaded — no handler can ever report for a neighbour. */}
              <img
                key={current.url}
                src={current.url}
                alt={`Image ${currentIndex + 1}`}
                className={cn(
                  "max-h-full max-w-full object-contain shadow-2xl rounded-sm select-none",
                  imageLoading && "opacity-0",
                )}
                draggable={false}
                onLoad={() => setLoadedUrl(current.url)}
                onError={() => setFailedUrl(current.url)}
              />
              {imageLoading && (
                <div className="absolute inset-0 flex items-center justify-center">
                  <div className="w-12 h-12 border-4 border-white/20 border-t-white/70 rounded-full animate-spin" />
                </div>
              )}
            </>
          )}
        </div>
        {renderSidebar?.(current.url)}
      </div>
    </div>
  );
}
