"use client";

import * as React from "react";
import {
  Check,
  Clapperboard,
  Copy,
  Film,
  Heart,
  ImageOff,
  ImagePlus,
  Play,
  RefreshCw,
  Trash2,
  WandSparkles,
} from "lucide-react";

import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import type { VideoHandoffRole } from "@/lib/reference-handoff";
import {
  PreviewActions,
  TileTipsProvider,
  TipButton,
  shouldArmTileTips,
  useLazyPopover,
} from "../preview-actions";
import density from "../preview-density.module.css";
import { releaseVideo, useVideoVisibility } from "./video-playback";
import { copyText } from "@/lib/copy-text";
import { prefetchMedia } from "@/lib/media-cache";
import { cn } from "@/lib/utils";

/**
 * Measured aspect ratios, kept module-level so switching result filters or
 * remounting the panel doesn't re-flow every tile from a square placeholder.
 */
const aspectCache = new Map<string, number>();

function rememberAspect(src: string, width: number, height: number): number | undefined {
  if (!width || !height) return undefined;
  const aspect = Math.round((width / height) * 1000) / 1000;
  aspectCache.set(src, aspect);
  return aspect;
}

function formatDuration(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  return `${Math.floor(total / 60)}:${(total % 60).toString().padStart(2, "0")}`;
}

/**
 * Solid rather than `backdrop-blur`: these sit over clips that are playing, and
 * a backdrop filter there is re-rasterised on every decoded frame.
 */
const TILE_BUTTON =
  "grid h-6 w-6 place-items-center rounded-md border border-white/15 bg-black/60 text-white transition-colors hover:bg-black/85";

function TileButton({
  label,
  onClick,
  destructive,
  children,
}: {
  label: string;
  onClick: () => void;
  destructive?: boolean;
  children: React.ReactNode;
}) {
  return (
    <TipButton
      label={label}
      onPress={onClick}
      className={cn(
        // No opacity of its own: the wrappers below hide the whole row, and a
        // child cannot raise its parent's opacity. Keyboard reveal comes from
        // their `focus-within:opacity-100`.
        // 24px: five of these plus the heart still leave most of a 220px
        // column — the narrowest one at 100% zoom — showing between them.
        TILE_BUTTON,
        destructive && "hover:border-red-400/50 hover:bg-red-500/85",
      )}
    >
      {children}
    </TipButton>
  );
}

const VIDEO_HANDOFF_CHOICES: { role: VideoHandoffRole; label: string; hint: string }[] = [
  { role: "first", label: "As start frame", hint: "The clip begins on this image" },
  { role: "last", label: "As last frame", hint: "The clip ends on this image" },
  { role: "reference", label: "As reference", hint: "Keeps this look or character; tag it @image" },
];

/**
 * Sends the image to the Self-hosted video tab. A menu rather than three tile
 * buttons: the row is already five wide on a small tile.
 */
export function SendToVideoMenu({
  onSend,
  triggerClassName,
  iconClassName = "h-3 w-3",
}: {
  onSend: (role: VideoHandoffRole) => void;
  triggerClassName?: string;
  iconClassName?: string;
}) {
  // Mounted on first use: every image tile carries one of these, and a closed
  // Base UI popover still costs a store and listeners per tile.
  const menu = useLazyPopover();
  const className = triggerClassName ?? TILE_BUTTON;
  if (!menu.mounted) {
    return (
      <button
        type="button"
        aria-label="Use in self-hosted video"
        aria-haspopup="dialog"
        title="Use in self-hosted video"
        className={className}
        onClick={(event) => {
          event.stopPropagation();
          menu.openFirst();
        }}
      >
        <Clapperboard className={iconClassName} />
      </button>
    );
  }
  return (
    <Popover open={menu.open} onOpenChange={(next) => menu.setOpen(next)}>
      <PopoverTrigger
        aria-label="Use in self-hosted video"
        title="Use in self-hosted video"
        // The tile opens the lightbox on click; React events bubble through the
        // portal too, hence the same guard on the menu below.
        onClick={(event) => event.stopPropagation()}
        className={className}
      >
        <Clapperboard className={iconClassName} />
      </PopoverTrigger>
      <PopoverContent
        side="bottom"
        align="end"
        className="w-60 gap-0.5 p-1"
        onClick={(event) => event.stopPropagation()}
      >
        <p className="px-2 pt-1 pb-1.5 text-[11px] font-medium text-muted-foreground">
          Self-hosted video (MiniMax H3)
        </p>
        {VIDEO_HANDOFF_CHOICES.map((choice) => (
          <button
            key={choice.role}
            type="button"
            className="flex flex-col items-start rounded-md px-2 py-1.5 text-left hover:bg-muted"
            onClick={() => {
              menu.setOpen(false);
              onSend(choice.role);
            }}
          >
            <span className="text-xs font-medium">{choice.label}</span>
            <span className="text-[11px] text-muted-foreground">{choice.hint}</span>
          </button>
        ))}
      </PopoverContent>
    </Popover>
  );
}

const GROK_SOURCE_CHOICES: { mode: "edit" | "extend"; label: string; hint: string }[] = [
  {
    mode: "edit",
    label: "Edit with Grok",
    hint: "Change something in the clip; up to 8.7 s, keeps its length",
  },
  {
    mode: "extend",
    label: "Extend with Grok",
    hint: "Continue the clip from its last frame; 2–15 s, adds 2–10 s",
  },
];

/**
 * Makes a clip the source of a Grok Edit or Extend. A menu for the same reason
 * as the self-hosted one: the tile's row of buttons is already full.
 */
export function GrokSourceVideoMenu({
  onPick,
  triggerClassName,
  iconClassName = "h-3 w-3",
}: {
  onPick: (mode: "edit" | "extend") => void;
  triggerClassName?: string;
  iconClassName?: string;
}) {
  const menu = useLazyPopover();
  const className = triggerClassName ?? TILE_BUTTON;
  if (!menu.mounted) {
    return (
      <button
        type="button"
        aria-label="Edit or extend with Grok"
        aria-haspopup="dialog"
        title="Edit or extend with Grok"
        className={className}
        onClick={(event) => {
          event.stopPropagation();
          menu.openFirst();
        }}
      >
        <WandSparkles className={iconClassName} />
      </button>
    );
  }
  return (
    <Popover open={menu.open} onOpenChange={(next) => menu.setOpen(next)}>
      <PopoverTrigger
        aria-label="Edit or extend with Grok"
        title="Edit or extend with Grok"
        onClick={(event) => event.stopPropagation()}
        className={className}
      >
        <WandSparkles className={iconClassName} />
      </PopoverTrigger>
      <PopoverContent
        side="bottom"
        align="end"
        className="w-64 gap-0.5 p-1"
        onClick={(event) => event.stopPropagation()}
      >
        <p className="px-2 pt-1 pb-1.5 text-[11px] font-medium text-muted-foreground">
          Use as the source video
        </p>
        {GROK_SOURCE_CHOICES.map((choice) => (
          <button
            key={choice.mode}
            type="button"
            className="flex flex-col items-start rounded-md px-2 py-1.5 text-left hover:bg-muted"
            onClick={() => {
              menu.setOpen(false);
              onPick(choice.mode);
            }}
          >
            <span className="text-xs font-medium">{choice.label}</span>
            <span className="text-[11px] text-muted-foreground">{choice.hint}</span>
          </button>
        ))}
      </PopoverContent>
    </Popover>
  );
}

interface TileActionsProps {
  onReproduce?: () => void;
  /** Attach this image to the form as a reference, in image mode. */
  onUseAsReference?: () => void;
  onMakeVideo?: () => void;
  /** Send this image to the Self-hosted video tab as a frame or reference. */
  onSendToVideo?: (role: VideoHandoffRole) => void;
  /** Make this clip the source of a Grok Edit or Extend. */
  onGrokSourceVideo?: (mode: "edit" | "extend") => void;
  onDelete?: () => void;
  /** The positive prompt. The negative one is deliberately not offered. */
  copyPrompt?: string;
  /** Omitted where favouriting doesn't apply; the heart is then absent. */
  isFavorite?: boolean;
  onToggleFavorite?: () => void;
}

function CopyPromptButton({ prompt }: { prompt: string }) {
  const [copied, setCopied] = React.useState(false);

  React.useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [copied]);

  return (
    <TileButton
      label={copied ? "Prompt copied" : "Copy prompt"}
      onClick={() => {
        void copyText(prompt).then((ok) => ok && setCopied(true));
      }}
    >
      {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
    </TileButton>
  );
}

/** Exported for tiles with no media of their own — a failed row still has
 *  its prompt and settings, so it can be copied and reproduced. */
export function TileActions({
  onReproduce,
  onUseAsReference,
  onMakeVideo,
  onSendToVideo,
  onGrokSourceVideo,
  onDelete,
  copyPrompt,
  isFavorite,
  onToggleFavorite,
}: TileActionsProps) {
  const hasRow =
    onReproduce ||
    onUseAsReference ||
    onMakeVideo ||
    onSendToVideo ||
    onGrokSourceVideo ||
    onDelete ||
    copyPrompt;
  if (!hasRow && !onToggleFavorite) return null;

  return (
    <PreviewActions>
      {onToggleFavorite && (
        // Top-left, and — once set — visible without hovering: a favourite is
        // state you want to read off the grid, not an action you go looking for.
        <div
          data-preview-overlay
          className={cn(
            "absolute top-1.5 left-1.5 z-10 transition-opacity focus-within:opacity-100 md:group-hover:opacity-100",
            // Tailwind compiles `hover:` under `@media (hover: hover)`, so a
            // hover-only reveal is simply unreachable on a phone. Below `md`
            // the control is just always there.
            !isFavorite && "opacity-100 md:opacity-0",
          )}
        >
          <TileButton
            label={isFavorite ? "Remove from favorites" : "Add to favorites"}
            onClick={onToggleFavorite}
          >
            <Heart className={cn("h-3 w-3", isFavorite && "fill-red-500 text-red-500")} />
          </TileButton>
        </div>
      )}
      {hasRow && (
        // Always on below `md` for the same reason as the heart above: on touch
        // there is no hover, and the first tap opens the lightbox instead.
        <div
          data-preview-overlay
          className="absolute top-1.5 right-1.5 z-10 flex gap-1 opacity-100 transition-opacity focus-within:opacity-100 md:opacity-0 md:group-hover:opacity-100"
        >
          {copyPrompt && <CopyPromptButton prompt={copyPrompt} />}
          {onReproduce && (
            <TileButton label="Reproduce Settings" onClick={onReproduce}>
              <RefreshCw className="h-3 w-3" />
            </TileButton>
          )}
          {onUseAsReference && (
            <TileButton label="Use as reference for a new image" onClick={onUseAsReference}>
              <ImagePlus className="h-3 w-3" />
            </TileButton>
          )}
          {onMakeVideo && (
            <TileButton label="Make video from this image" onClick={onMakeVideo}>
              <Film className="h-3 w-3" />
            </TileButton>
          )}
          {onSendToVideo && <SendToVideoMenu onSend={onSendToVideo} />}
          {onGrokSourceVideo && <GrokSourceVideoMenu onPick={onGrokSourceVideo} />}
          {onDelete && (
            <TileButton label="Delete" onClick={onDelete} destructive>
              <Trash2 className="h-3 w-3" />
            </TileButton>
          )}
        </div>
      )}
    </PreviewActions>
  );
}

const TILE_SHELL =
  "group absolute inset-0 overflow-hidden rounded-md bg-muted/60 cursor-pointer select-none";

/**
 * Arms the tile's tooltips on the first mouse hover or tile focus — see
 * `TileTipsProvider`. One state per tile, and it never goes back.
 */
function useTileTips() {
  const [armed, setArmed] = React.useState(false);
  const arm = (event: React.PointerEvent | React.FocusEvent) => {
    if (!armed && shouldArmTileTips(event)) setArmed(true);
  };
  return { armed, arm };
}

interface GrokImageTileProps extends TileActionsProps {
  src: string;
  /** Full-res URL used if the optimized thumbnail fails to load. */
  fallbackSrc?: string;
  alt: string;
  onAspect: (aspect: number) => void;
  onClick: () => void;
}

export function GrokImageTile({
  src,
  fallbackSrc,
  alt,
  onAspect,
  onClick,
  onReproduce,
  onUseAsReference,
  onMakeVideo,
  onSendToVideo,
  onDelete,
  copyPrompt,
  isFavorite,
  onToggleFavorite,
}: GrokImageTileProps) {
  const imageRef = React.useRef<HTMLImageElement>(null);
  const [currentSrc, setCurrentSrc] = React.useState(src);
  const [loaded, setLoaded] = React.useState(false);
  const [failed, setFailed] = React.useState(false);
  const tips = useTileTips();

  React.useEffect(() => {
    setCurrentSrc(src);
    setLoaded(false);
    setFailed(false);
  }, [src]);

  React.useEffect(() => {
    const cached = aspectCache.get(src);
    if (cached) onAspect(cached);
  }, [src, onAspect]);

  const settle = React.useCallback(
    (image: HTMLImageElement) => {
      const aspect = rememberAspect(src, image.naturalWidth, image.naturalHeight);
      if (aspect) onAspect(aspect);
      setLoaded(true);
    },
    [src, onAspect],
  );

  // An image served from cache can already be complete before React attaches
  // onLoad, in which case the event never reaches us and the tile stays blank.
  React.useEffect(() => {
    const image = imageRef.current;
    if (image?.complete && image.naturalWidth > 0) settle(image);
  }, [settle, currentSrc]);

  return (
    <div
      className={cn(TILE_SHELL, density.tile)}
      onClick={onClick}
      // Hovering is the best hint of a click: fetch the full image now.
      onPointerEnter={(event) => {
        prefetchMedia([fallbackSrc]);
        tips.arm(event);
      }}
      onFocus={tips.arm}
      role="button"
      tabIndex={0}
      aria-label={alt}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget) return;
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onClick();
        }
      }}
    >
      {failed ? (
        <div className="flex h-full w-full flex-col items-center justify-center gap-2 text-muted-foreground">
          <ImageOff className="h-6 w-6 opacity-50" />
          <span className="text-xs">Image unavailable</span>
        </div>
      ) : (
        <img
          ref={imageRef}
          src={currentSrc}
          alt={alt}
          loading="lazy"
          decoding="async"
          draggable={false}
          className={cn(
            "h-full w-full object-cover transition-[transform,opacity] duration-500 group-hover:scale-[1.03]",
            !loaded && "opacity-0",
          )}
          onLoad={(event) => settle(event.currentTarget)}
          onError={() => {
            // Optimized thumbnail missing — fall back to the original.
            if (fallbackSrc && currentSrc !== fallbackSrc) {
              setCurrentSrc(fallbackSrc);
            } else {
              setFailed(true);
            }
          }}
        />
      )}
      {/* The masonry cell is `content-visibility: auto`, so a placeholder far
          off screen is skipped rather than animated. */}
      {!loaded && !failed && <div className="absolute inset-0 animate-pulse bg-muted" />}
      <TileTipsProvider value={tips.armed}>
        <TileActions
          onReproduce={onReproduce}
          onUseAsReference={onUseAsReference}
          onMakeVideo={onMakeVideo}
          onSendToVideo={onSendToVideo}
          onDelete={onDelete}
          copyPrompt={copyPrompt}
          isFavorite={isFavorite}
          onToggleFavorite={onToggleFavorite}
        />
      </TileTipsProvider>
    </div>
  );
}

interface GrokVideoTileProps extends TileActionsProps {
  src: string;
  /**
   * A still of the clip (`videoPosterUrl`). Shown until the tile is allowed to
   * play, so a tile far from the centre of the grid never downloads the clip at
   * all — and measured, so the tile lays out before any video bytes arrive.
   */
  poster?: string;
  alt: string;
  /** Requested duration, shown until the real one is known. */
  durationHint?: number;
  /** Playback is suspended while false — e.g. the full view is covering the grid. */
  active?: boolean;
  onAspect: (aspect: number) => void;
  onClick: () => void;
}

/**
 * Grid preview for a generated clip: no controls at all, muted, looping.
 *
 * Only the few clips nearest the centre of the scroll box play
 * (`useVideoVisibility`); the rest show their poster. A clip that has played
 * keeps its source while it stays near, and lets go of it once it is a screen
 * away, so a long results feed never holds every clip at once. Without a poster
 * a near tile still attaches its source, paused, to show a first frame.
 */
export function GrokVideoTile({
  src,
  poster,
  alt,
  durationHint,
  active = true,
  onAspect,
  onClick,
  onReproduce,
  onGrokSourceVideo,
  onDelete,
  copyPrompt,
  isFavorite,
  onToggleFavorite,
}: GrokVideoTileProps) {
  const containerRef = React.useRef<HTMLDivElement>(null);
  const videoRef = React.useRef<HTMLVideoElement>(null);

  const [hasFrame, setHasFrame] = React.useState(false);
  const [isPaused, setIsPaused] = React.useState(false);
  const [failed, setFailed] = React.useState(false);
  const [posterState, setPosterState] = React.useState<"loading" | "shown" | "failed">("loading");
  const [duration, setDuration] = React.useState(durationHint ?? 0);
  const tips = useTileTips();

  const visibility = useVideoVisibility(containerRef, active && !failed);
  const hasPoster = Boolean(poster) && posterState !== "failed";
  const shouldLoad =
    !failed && (visibility.playing || (visibility.near && (visibility.warm || !hasPoster)));
  const shouldPlay = visibility.playing && shouldLoad;

  React.useEffect(() => {
    setPosterState("loading");
  }, [poster]);

  React.useEffect(() => {
    const cached = aspectCache.get(src);
    if (cached) onAspect(cached);
  }, [src, onAspect]);

  // Far away, or bumped out by a closer clip with nothing to keep showing.
  React.useEffect(() => {
    const video = videoRef.current;
    if (!video || shouldLoad) return;
    releaseVideo(video);
    setHasFrame(false);
  }, [shouldLoad]);

  // Unmounting has to let go as well: a detached element with a source keeps
  // its decoder until it is garbage-collected, which can be a long time.
  React.useEffect(() => {
    const video = videoRef.current;
    return () => {
      if (video) releaseVideo(video);
    };
  }, []);

  React.useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    if (shouldPlay) {
      // Cached clips can already hold data before their events reach us.
      if (video.readyState >= HTMLMediaElement.HAVE_METADATA) {
        const aspect = rememberAspect(src, video.videoWidth, video.videoHeight);
        if (aspect) onAspect(aspect);
        setHasFrame(true);
      }
      void video.play().catch(() => {
        // Autoplay refused (low-power mode, reduced motion) — show the play hint.
        setIsPaused(true);
      });
    } else if (!video.paused) {
      video.pause();
    }
  }, [shouldPlay, src, onAspect]);

  const showPoster = hasPoster && posterState === "shown";

  return (
    <div
      ref={containerRef}
      className={cn(TILE_SHELL, density.tile)}
      onClick={onClick}
      // The tile only buffers what it plays; fetch the whole clip for the lightbox.
      onPointerEnter={(event) => {
        prefetchMedia([src]);
        tips.arm(event);
      }}
      onFocus={tips.arm}
      role="button"
      tabIndex={0}
      aria-label={alt}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget) return;
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onClick();
        }
      }}
    >
      {failed ? (
        <div className="flex h-full w-full flex-col items-center justify-center gap-2 text-muted-foreground">
          <ImageOff className="h-6 w-6 opacity-50" />
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
                const aspect = rememberAspect(src, image.naturalWidth, image.naturalHeight);
                if (aspect) onAspect(aspect);
                setPosterState("shown");
              }}
              // A zone without Media Transformations, or a clip over their size
              // limit: back to showing a first frame instead.
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
            disableRemotePlayback
            className={cn(
              "relative h-full w-full object-cover transition-opacity duration-300",
              !hasFrame && "opacity-0",
            )}
            onLoadedMetadata={(event) => {
              const video = event.currentTarget;
              const aspect = rememberAspect(src, video.videoWidth, video.videoHeight);
              if (aspect) onAspect(aspect);
              if (video.duration && Number.isFinite(video.duration)) setDuration(video.duration);
            }}
            onLoadedData={() => setHasFrame(true)}
            onPlay={() => setIsPaused(false)}
            onError={(event) => {
              // A tile whose source was just released fires an error too; only a
              // failure of a source we are asking for means anything.
              if (event.currentTarget.getAttribute("src")) setFailed(true);
            }}
          />
        </>
      )}
      {!hasFrame && !showPoster && !failed && (
        <div className={cn("absolute inset-0 bg-muted", visibility.near && "animate-pulse")} />
      )}

      {duration > 0 && (
        <span className="pointer-events-none absolute bottom-1.5 left-1.5 z-10 flex items-center gap-1 rounded bg-black/60 px-1.5 py-0.5 text-[10px] font-medium text-white tabular-nums">
          {isPaused && <Play className="h-2.5 w-2.5 fill-current" />}
          {formatDuration(duration)}
        </span>
      )}

      <TileTipsProvider value={tips.armed}>
        <TileActions
          onReproduce={onReproduce}
          onGrokSourceVideo={onGrokSourceVideo}
          onDelete={onDelete}
          copyPrompt={copyPrompt}
          isFavorite={isFavorite}
          onToggleFavorite={onToggleFavorite}
        />
      </TileTipsProvider>
    </div>
  );
}
