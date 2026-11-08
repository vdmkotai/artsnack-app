"use client";

import { memo, useState, useEffect, useRef } from "react";
import { Check, Copy, Heart, ImageOff, RefreshCw, Sparkles, Zap } from "lucide-react";
import { copyText } from "@/lib/copy-text";
import { prefetchMedia } from "@/lib/media-cache";
import { cn } from "@/lib/utils";
import { useNearScrollRoot } from "@/hooks/use-scroll-root";
import { releaseVideo, useVideoVisibility } from "@/components/grok/video-playback";
import styles from "./image-grid.module.css";
import density from "./preview-density.module.css";
import { PreviewActions, TileTipsProvider, TipButton, shouldArmTileTips } from "./preview-actions";

// Global cache for image dimensions to avoid reloading
const imageDimensionsCache = new Map<string, { width: number; height: number }>();

interface ImageGridProps {
  children: React.ReactNode;
  gap?: number;
  className?: string;
  responsive?: boolean;
  previewScale?: number;
}

/**
 * The desktop/mobile split is resolved by the stylesheet, not by JS.
 *
 * Reading the breakpoint from a hook meant the first paint always assumed
 * desktop and every tile re-laid-out after hydration — a visible reflow on
 * every phone load. A `md:` variant over a CSS variable is correct at first
 * paint and costs no listeners.
 */
export function ImageGrid({
  children,
  gap = 16,
  className,
  responsive = false,
  previewScale = 1,
}: ImageGridProps) {
  return (
    <div
      className={cn(
        "flex flex-wrap gap-2 md:gap-[var(--grid-gap)]",
        responsive && styles.responsive,
        className,
      )}
      style={{ "--grid-gap": `${gap}px`, "--preview-scale": previewScale } as React.CSSProperties}
    >
      {children}
    </div>
  );
}

/**
 * Row height on phones / from `md` up, and the tile width derived from both.
 *
 * `content-visibility: auto` lets the browser skip a tile that is far off
 * screen — its layout, paint and the loading pulse inside it. Every tile's size
 * is fixed by its CSS variables (or its aspect ratio under `.responsive`), so
 * the containment that comes with it changes no box.
 */
const TILE_SIZE_CLASSES =
  "h-[var(--tile-h)] w-[calc(var(--tile-h)*var(--tile-aspect))] md:h-[var(--tile-h-md)] md:w-[calc(var(--tile-h-md)*var(--tile-aspect))] [content-visibility:auto]";

/**
 * Hover-revealed tile controls. A solid fill rather than `backdrop-blur`: a
 * backdrop filter makes every one of them a compositing layer of its own even
 * while invisible, five per tile.
 */
const OVERLAY_BUTTON =
  "absolute top-2 p-1.5 rounded-md bg-background/90 border border-border/50 transition-opacity hover:bg-background hover:border-primary/50";

const CHECKBOX_CLASSES =
  "absolute top-2 left-2 h-5 w-5 rounded-md border flex items-center justify-center transition-colors z-10 cursor-pointer";

const BADGE_CLASSES =
  "pointer-events-none absolute bottom-2 left-2 max-w-[calc(100%-1rem)] truncate rounded-md bg-black/60 px-1.5 py-0.5 text-[10px] text-white/90 opacity-0 transition-opacity group-hover:opacity-100";

/** Arms a tile's tooltips on its first mouse hover or focus — see `TileTipsProvider`. */
function useTileTips() {
  const [armed, setArmed] = useState(false);
  const arm = (event: React.PointerEvent | React.FocusEvent) => {
    if (!armed && shouldArmTileTips(event)) setArmed(true);
  };
  return { armed, arm };
}

/** "Prompt copied" for a moment after a successful copy. */
function useCopiedFlag() {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [copied]);
  return [copied, setCopied] as const;
}

function tileSizeVars(
  rowHeight: number,
  mobileRowHeight: number,
  aspect: number,
): React.CSSProperties {
  return {
    "--tile-h": `${mobileRowHeight}px`,
    "--tile-h-md": `${rowHeight}px`,
    "--tile-aspect": String(aspect),
  } as React.CSSProperties;
}

interface ImageGridItemProps {
  src: string;
  alt: string;
  /**
   * Handed back to every callback below, so a grid can pass one stable handler
   * to all of its tiles instead of a fresh closure per tile — which is what lets
   * the memo on this component hold. Defaults to `src`.
   */
  itemKey?: string;
  onClick?: (e: React.MouseEvent, itemKey: string) => void;
  onReproduce?: (itemKey: string) => void;
  rowHeight?: number;
  mobileRowHeight?: number;
  onSendToEnhance?: (itemKey: string) => void;
  onSendToApi?: (itemKey: string) => void;
  /** Positive prompt for the copy action. The negative one is never offered. */
  copyPrompt?: string;
  className?: string;
  /** Known width/height ratio — sizes the tile immediately to avoid layout shift. */
  aspectRatio?: number;
  /** Full-res URL to fall back to if `src` (an optimized thumbnail) fails to load. */
  fallbackSrc?: string;
  isFavorited?: boolean;
  onToggleFavorite?: (itemKey: string) => void;
  /** Selection mode is on (some item is selected) — show checkboxes on all items. */
  selectionActive?: boolean;
  selected?: boolean;
  /** Stable identity exposed to scroll restoration without coupling it to React internals. */
  scrollAnchorKey?: string;
  /** Short provenance label (checkpoint, provider) shown on hover in the bottom corner. */
  badge?: string;
}

/**
 * One image in a justified grid.
 *
 * Memoized: a live grid re-renders whenever its list does, and every tile used
 * to re-render with it. With `itemKey` and the key-taking callbacks a tile's
 * props only change when something about that tile did.
 */
export const ImageGridItem = memo(function ImageGridItem({
  src,
  alt,
  itemKey,
  onClick,
  onReproduce,
  onSendToEnhance,
  onSendToApi,
  copyPrompt,
  rowHeight = 280,
  mobileRowHeight = 160,
  className,
  aspectRatio,
  fallbackSrc,
  isFavorited,
  onToggleFavorite,
  selectionActive = false,
  selected = false,
  scrollAnchorKey,
  badge,
}: ImageGridItemProps) {
  const key = itemKey ?? src;
  // Check cache first for dimensions
  const cachedDimensions = imageDimensionsCache.get(src);

  const [dimensions, setDimensions] = useState<{
    width: number;
    height: number;
  } | null>(cachedDimensions || null);
  const [loaded, setLoaded] = useState(!!cachedDimensions);
  const [promptCopied, setPromptCopied] = useCopiedFlag();
  const [error, setError] = useState(false);
  const [isVisible, setIsVisible] = useState(!!cachedDimensions);
  const containerRef = useRef<HTMLDivElement>(null);
  const tips = useTileTips();

  // The src actually rendered. Starts as the (optimized) `src`; if that fails to
  // load we swap to `fallbackSrc` (the full-res original) so the grid never breaks.
  const [currentSrc, setCurrentSrc] = useState(src);
  useEffect(() => {
    setCurrentSrc(src);
    setError(false);
  }, [src]);

  // Lazy loading (skip if already cached). Observed against the column the grid
  // scrolls in: against the viewport, the 200px head start was cut off at the
  // column's edge, so on the Generate page an image only began to load once it
  // was already on screen — unless browser zoom had stacked the layout and handed
  // scrolling back to the window.
  const near = useNearScrollRoot(containerRef, "200px", !isVisible);
  if (near && !isVisible) setIsVisible(true);

  /*
   * Dimensions come from the rendered image itself. There used to be a separate
   * `new Image()` probe for tiles without a known ratio, and when the thumbnail
   * failed it set `error` — which stopped rendering the very <img> whose onError
   * holds the fallback to the original, so a missing thumbnail meant "Image
   * unavailable" instead of the full-size picture.
   */
  const onImageLoad = (image: HTMLImageElement) => {
    if (!aspectRatio && image.naturalWidth > 0 && image.naturalHeight > 0) {
      const dims = { width: image.naturalWidth, height: image.naturalHeight };
      imageDimensionsCache.set(src, dims);
      setDimensions(dims);
    }
    setLoaded(true);
  };

  // Prefer the caller-supplied aspect ratio (no layout shift); else fall back to
  // the measured dimensions; else a square placeholder until we know better.
  const effectiveAspect =
    aspectRatio && aspectRatio > 0
      ? aspectRatio
      : dimensions
        ? dimensions.width / dimensions.height
        : 1;

  const showActions = !selectionActive && !selected;

  return (
    <div
      ref={containerRef}
      data-gallery-image-key={scrollAnchorKey}
      role={onClick ? "button" : undefined}
      tabIndex={onClick ? 0 : undefined}
      aria-label={onClick ? alt : undefined}
      onKeyDown={(event) => {
        if (!onClick || event.target !== event.currentTarget) return;
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          event.currentTarget.click();
        }
      }}
      className={cn(
        "group overflow-hidden rounded-lg bg-muted border border-border/50 hover:border-primary/50 transition-colors flex-shrink-0 relative",
        TILE_SIZE_CLASSES,
        density.tile,
        onClick && "cursor-pointer",
        selected && "ring-2 ring-primary border-primary",
        className,
      )}
      style={tileSizeVars(rowHeight, mobileRowHeight, effectiveAspect)}
      onClick={onClick ? (event) => onClick(event, key) : undefined}
      // Hovering is the best hint of a click: fetch the full image now.
      onPointerEnter={(event) => {
        prefetchMedia([fallbackSrc]);
        tips.arm(event);
      }}
      onFocus={tips.arm}
    >
      {!isVisible ? (
        // Not yet near the screen: nothing to animate for.
        <div className="absolute inset-0 bg-muted" />
      ) : error ? (
        <div className="w-full h-full flex flex-col items-center justify-center text-muted-foreground bg-muted/50">
          <ImageOff className="h-8 w-8 mb-2 opacity-50" />
          <span className="text-xs">Image unavailable</span>
        </div>
      ) : (
        <>
          <img
            src={currentSrc}
            alt={alt}
            decoding="async"
            onLoad={(event) => onImageLoad(event.currentTarget)}
            onError={() => {
              // Optimized thumbnail failed — fall back to the full-res original.
              if (fallbackSrc && currentSrc !== fallbackSrc) {
                setCurrentSrc(fallbackSrc);
              } else {
                setError(true);
              }
            }}
            className={cn(
              "w-full h-full object-cover transition-transform duration-500 group-hover:scale-105",
              !loaded && "opacity-0",
            )}
          />
          {!loaded && <div className="absolute inset-0 animate-pulse bg-muted" />}
          {(selectionActive || selected) && (
            <button
              type="button"
              role="checkbox"
              aria-checked={selected}
              aria-label={selected ? "Deselect image" : "Select image"}
              onClick={(e) => {
                e.stopPropagation();
                onClick?.(e, key);
              }}
              className={cn(
                CHECKBOX_CLASSES,
                selected
                  ? "bg-primary border-primary text-primary-foreground"
                  : "bg-background/90 border-border/50 text-transparent hover:border-primary/50",
              )}
            >
              <Check className="h-3.5 w-3.5" />
            </button>
          )}
          {selected && <div className="absolute inset-0 bg-primary/20 pointer-events-none" />}
          {badge && loaded && showActions && <span className={BADGE_CLASSES}>{badge}</span>}
          {showActions &&
            (onToggleFavorite ||
              (loaded && (onReproduce || onSendToEnhance || onSendToApi || copyPrompt))) && (
              <TileTipsProvider value={tips.armed}>
                <PreviewActions>
                  {onToggleFavorite && (
                    <TipButton
                      data-preview-overlay
                      label={isFavorited ? "Remove from favorites" : "Add to favorites"}
                      onPress={() => onToggleFavorite(key)}
                      className={cn(
                        OVERLAY_BUTTON,
                        "left-2",
                        isFavorited ? "opacity-100" : "opacity-0 group-hover:opacity-100",
                      )}
                    >
                      <Heart
                        className={cn(
                          "h-4 w-4",
                          isFavorited ? "fill-red-500 text-red-500" : "text-foreground/80",
                        )}
                      />
                    </TipButton>
                  )}

                  {onReproduce && loaded && (
                    <TipButton
                      data-preview-overlay
                      label="Reproduce Settings"
                      onPress={() => onReproduce(key)}
                      className={cn(OVERLAY_BUTTON, "right-2 opacity-0 group-hover:opacity-100")}
                    >
                      <RefreshCw className="h-4 w-4 text-foreground/80" />
                    </TipButton>
                  )}

                  {onSendToEnhance && loaded && (
                    <TipButton
                      data-preview-overlay
                      label="Send to Enhance"
                      onPress={() => onSendToEnhance(key)}
                      className={cn(OVERLAY_BUTTON, "right-10 opacity-0 group-hover:opacity-100")}
                    >
                      <Zap className="h-4 w-4 text-foreground/80" />
                    </TipButton>
                  )}

                  {onSendToApi && loaded && (
                    <TipButton
                      data-preview-overlay
                      label="Send to API models as reference"
                      onPress={() => onSendToApi(key)}
                      className={cn(
                        OVERLAY_BUTTON,
                        "opacity-0 group-hover:opacity-100",
                        onSendToEnhance ? "right-[4.5rem]" : "right-10",
                      )}
                    >
                      <Sparkles className="h-4 w-4 text-foreground/80" />
                    </TipButton>
                  )}

                  {copyPrompt && loaded && (
                    <TipButton
                      data-preview-overlay
                      label={promptCopied ? "Prompt copied" : "Copy prompt"}
                      onPress={() => {
                        void copyText(copyPrompt).then((ok) => ok && setPromptCopied(true));
                      }}
                      className={cn(
                        OVERLAY_BUTTON,
                        "opacity-0 group-hover:opacity-100",
                        // Four buttons in a row overlap the favourite heart on a 9:16
                        // tile, so this one wraps to the second row instead.
                        onSendToApi && onSendToEnhance ? "top-12 right-2" : "right-[4.5rem]",
                      )}
                    >
                      {promptCopied ? (
                        <Check className="h-4 w-4 text-foreground/80" />
                      ) : (
                        <Copy className="h-4 w-4 text-foreground/80" />
                      )}
                    </TipButton>
                  )}
                </PreviewActions>
              </TileTipsProvider>
            )}
        </>
      )}
    </div>
  );
});

interface VideoGridItemProps {
  src: string;
  alt: string;
  /** Handed back to the callbacks below, as on {@link ImageGridItem}. Defaults to `src`. */
  itemKey?: string;
  /**
   * A still of the clip, shown until the tile may play — far fewer bytes than a
   * first frame, and it lets the tile hold its place without loading the clip.
   */
  poster?: string;
  /** Requested ratio; the clip's own metadata replaces it once known. */
  aspectRatio?: number;
  onClick?: (e: React.MouseEvent, itemKey: string) => void;
  onReproduce?: (itemKey: string) => void;
  copyPrompt?: string;
  isFavorited?: boolean;
  onToggleFavorite?: (itemKey: string) => void;
  /** Playback is suspended while false — e.g. the full view covers the grid. */
  active?: boolean;
  rowHeight?: number;
  mobileRowHeight?: number;
  className?: string;
  /** Selection mode is on (some item is selected) — show checkboxes on all items. */
  selectionActive?: boolean;
  selected?: boolean;
  /** Short provenance label (provider) shown on hover in the bottom corner. */
  badge?: string;
}

/**
 * A clip in a justified image grid.
 *
 * Same sizing model as {@link ImageGridItem} so the two mix in one row, and the
 * same three actions. It plays muted, and only when it is one of the few clips
 * nearest the middle of the scroll box (`useVideoVisibility`) — a favourites
 * page can hold dozens of clips, and streaming them all at once is what makes
 * such a page feel broken. The source is attached only while the tile is near
 * the screen and released once it is far, or when the tile unmounts.
 */
export const VideoGridItem = memo(function VideoGridItem({
  src,
  alt,
  itemKey,
  poster,
  aspectRatio,
  onClick,
  onReproduce,
  copyPrompt,
  isFavorited,
  onToggleFavorite,
  active = true,
  rowHeight = 280,
  mobileRowHeight = 160,
  className,
  selectionActive = false,
  selected = false,
  badge,
}: VideoGridItemProps) {
  const key = itemKey ?? src;
  const containerRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const [measured, setMeasured] = useState<number | null>(null);
  const [hasFrame, setHasFrame] = useState(false);
  const [error, setError] = useState(false);
  const [posterState, setPosterState] = useState<"loading" | "shown" | "failed">("loading");
  const [promptCopied, setPromptCopied] = useCopiedFlag();
  const tips = useTileTips();

  const visibility = useVideoVisibility(containerRef, active && !error);
  const hasPoster = Boolean(poster) && posterState !== "failed";
  const shouldLoad =
    !error && (visibility.playing || (visibility.near && (visibility.warm || !hasPoster)));
  const shouldPlay = visibility.playing && shouldLoad;

  useEffect(() => {
    setPosterState("loading");
  }, [poster]);

  // Far offscreen: actually release the clip — see `releaseVideo`.
  useEffect(() => {
    const video = videoRef.current;
    if (!video || shouldLoad) return;
    releaseVideo(video);
    setHasFrame(false);
  }, [shouldLoad]);

  useEffect(() => {
    const video = videoRef.current;
    return () => {
      if (video) releaseVideo(video);
    };
  }, []);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    if (shouldPlay) {
      void video.play().catch(() => {
        // Autoplay refused — the first frame stays, which is enough here.
      });
    } else if (!video.paused) {
      video.pause();
    }
  }, [shouldPlay]);

  // A new clip in the same tile deserves a fresh verdict; a transient CDN
  // failure should not mark it unavailable for the life of the page.
  useEffect(() => {
    setError(false);
  }, [src]);

  const effectiveAspect = measured ?? (aspectRatio && aspectRatio > 0 ? aspectRatio : 1);
  const showPoster = hasPoster && posterState === "shown";
  const showActions = !selectionActive && !selected;

  return (
    <div
      ref={containerRef}
      className={cn(
        "group relative flex-shrink-0 overflow-hidden rounded-lg border border-border/50 bg-muted transition-colors hover:border-primary/50",
        TILE_SIZE_CLASSES,
        density.tile,
        onClick && "cursor-pointer",
        selected && "ring-2 ring-primary border-primary",
        className,
      )}
      style={tileSizeVars(rowHeight, mobileRowHeight, effectiveAspect)}
      onClick={onClick ? (event) => onClick(event, key) : undefined}
      // The tile only buffers what it plays; fetch the whole clip for the lightbox.
      onPointerEnter={(event) => {
        prefetchMedia([src]);
        tips.arm(event);
      }}
      onFocus={tips.arm}
    >
      {error ? (
        <div className="flex h-full w-full flex-col items-center justify-center bg-muted/50 text-muted-foreground">
          <ImageOff className="mb-2 h-8 w-8 opacity-50" />
          <span className="text-xs">Video unavailable</span>
        </div>
      ) : (
        <>
          {hasPoster && (
            <img
              src={poster}
              alt=""
              aria-hidden
              loading="lazy"
              decoding="async"
              draggable={false}
              className={cn(
                "absolute inset-0 h-full w-full object-cover",
                posterState !== "shown" && "opacity-0",
              )}
              onLoad={(event) => {
                const image = event.currentTarget;
                if (image.naturalWidth && image.naturalHeight) {
                  setMeasured(image.naturalWidth / image.naturalHeight);
                }
                setPosterState("shown");
              }}
              onError={() => setPosterState("failed")}
            />
          )}
          <video
            ref={videoRef}
            src={shouldLoad ? src : undefined}
            aria-label={alt}
            muted
            loop
            playsInline
            preload={visibility.playing ? "auto" : "metadata"}
            disablePictureInPicture
            className={cn(
              "relative h-full w-full object-cover transition-opacity duration-300",
              !hasFrame && "opacity-0",
            )}
            onLoadedMetadata={(e) => {
              const video = e.currentTarget;
              if (video.videoWidth && video.videoHeight) {
                setMeasured(video.videoWidth / video.videoHeight);
              }
            }}
            onLoadedData={() => setHasFrame(true)}
            onError={(event) => {
              // A tile whose source was just released fires an error too; only a
              // failure of a source we are asking for means anything.
              if (event.currentTarget.getAttribute("src")) setError(true);
            }}
          />
        </>
      )}
      {!hasFrame && !showPoster && !error && (
        <div className={cn("absolute inset-0 bg-muted", visibility.near && "animate-pulse")} />
      )}

      {(selectionActive || selected) && (
        <button
          type="button"
          role="checkbox"
          aria-checked={selected}
          aria-label={selected ? "Deselect video" : "Select video"}
          onClick={(e) => {
            e.stopPropagation();
            onClick?.(e, key);
          }}
          className={cn(
            CHECKBOX_CLASSES,
            selected
              ? "bg-primary border-primary text-primary-foreground"
              : "bg-background/90 border-border/50 text-transparent hover:border-primary/50",
          )}
        >
          <Check className="h-3.5 w-3.5" />
        </button>
      )}
      {selected && <div className="absolute inset-0 bg-primary/20 pointer-events-none" />}
      {badge && showActions && <span className={BADGE_CLASSES}>{badge}</span>}

      {showActions && (onToggleFavorite || onReproduce || copyPrompt) && (
        <TileTipsProvider value={tips.armed}>
          <PreviewActions>
            {onToggleFavorite && (
              <TipButton
                data-preview-overlay
                label={isFavorited ? "Remove from favorites" : "Add to favorites"}
                onPress={() => onToggleFavorite(key)}
                className={cn(
                  OVERLAY_BUTTON,
                  "left-2",
                  isFavorited ? "opacity-100" : "opacity-0 group-hover:opacity-100",
                )}
              >
                <Heart
                  className={cn(
                    "h-4 w-4",
                    isFavorited ? "fill-red-500 text-red-500" : "text-foreground/80",
                  )}
                />
              </TipButton>
            )}

            {onReproduce && (
              <TipButton
                data-preview-overlay
                label="Reproduce Settings"
                onPress={() => onReproduce(key)}
                className={cn(OVERLAY_BUTTON, "right-2 opacity-0 group-hover:opacity-100")}
              >
                <RefreshCw className="h-4 w-4 text-foreground/80" />
              </TipButton>
            )}

            {copyPrompt && (
              <TipButton
                data-preview-overlay
                label={promptCopied ? "Prompt copied" : "Copy prompt"}
                onPress={() => {
                  void copyText(copyPrompt).then((ok) => ok && setPromptCopied(true));
                }}
                className={cn(
                  OVERLAY_BUTTON,
                  "opacity-0 group-hover:opacity-100",
                  onReproduce ? "right-10" : "right-2",
                )}
              >
                {promptCopied ? (
                  <Check className="h-4 w-4 text-foreground/80" />
                ) : (
                  <Copy className="h-4 w-4 text-foreground/80" />
                )}
              </TipButton>
            )}
          </PreviewActions>
        </TileTipsProvider>
      )}
    </div>
  );
});

interface ImageGridSkeletonProps {
  // width / height of the eventual image, so the placeholder reserves the same
  // slot in the justified grid as the finished image will occupy.
  aspectRatio?: number;
  rowHeight?: number;
  mobileRowHeight?: number;
  className?: string;
  children?: React.ReactNode;
}

// Placeholder tile (generating / failed) that matches ImageGridItem's sizing
// model: fixed row height, width derived from the aspect ratio. Keeps the grid
// from jumping when the real image arrives.
export function ImageGridSkeleton({
  aspectRatio = 1,
  rowHeight = 280,
  mobileRowHeight = 160,
  className,
  children,
}: ImageGridSkeletonProps) {
  const safeAspect = Number.isFinite(aspectRatio) && aspectRatio > 0 ? aspectRatio : 1;

  return (
    <div
      className={cn(
        "flex-shrink-0 flex items-center justify-center overflow-hidden rounded-lg border border-border/50",
        TILE_SIZE_CLASSES,
        density.tile,
        className,
      )}
      style={tileSizeVars(rowHeight, mobileRowHeight, safeAspect)}
    >
      {children}
    </div>
  );
}
