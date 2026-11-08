"use client";

import * as React from "react";
import { Loader2, Maximize, Minimize, Pause, Play, VideoOff, Volume2, VolumeX } from "lucide-react";

import { cn } from "@/lib/utils";

/** Sound preference carries across clips within a session, like Grok's viewer. */
let preferMuted = false;

function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs.toString().padStart(2, "0")}`;
}

interface VideoViewerProps {
  src: string;
  poster?: string;
  className?: string;
}

/**
 * Full-view video player: the clip fills the frame and the controls only
 * surface on hover (or while paused). Deliberately hand-rolled — these are
 * short MP4s with no adaptive streaming, so a player library would only add
 * weight and default chrome to fight.
 */
export function VideoViewer({ src, poster, className }: VideoViewerProps) {
  const videoRef = React.useRef<HTMLVideoElement | null>(null);
  const rootRef = React.useRef<HTMLDivElement>(null);
  const barRef = React.useRef<HTMLDivElement>(null);

  const [isPlaying, setIsPlaying] = React.useState(false);
  const [isMuted, setIsMuted] = React.useState(preferMuted);
  const [isBuffering, setIsBuffering] = React.useState(true);
  const [hasError, setHasError] = React.useState(false);
  const [progress, setProgress] = React.useState(0);
  const [duration, setDuration] = React.useState(0);
  const [isHovering, setIsHovering] = React.useState(false);
  const [isScrubbing, setIsScrubbing] = React.useState(false);
  const [isFullscreen, setIsFullscreen] = React.useState(false);

  // A new clip starts from scratch. Adjusted during render rather than in an
  // effect, so the reset is already visible on the first frame of the new src.
  const [prevSrc, setPrevSrc] = React.useState(src);
  if (src !== prevSrc) {
    setPrevSrc(src);
    setProgress(0);
    setIsBuffering(true);
    setHasError(false);
  }

  React.useEffect(() => {
    const video = videoRef.current;
    if (video) video.muted = isMuted;
  }, [isMuted]);

  /**
   * Listeners and the autoplay attempt hang off the element's ref callback
   * rather than an effect, because the <video> is keyed on `src` and is
   * unmounted entirely while `hasError` holds: only the ref callback runs again
   * for the replacement element, so this is the one place that sees every clip.
   * Autoplay: if the browser refuses sound, retry muted rather than leaving the
   * user staring at a frozen first frame.
   */
  const attachVideo = React.useCallback((video: HTMLVideoElement | null) => {
    videoRef.current = video;
    if (!video) return;

    const onPlay = () => setIsPlaying(true);
    const onPause = () => setIsPlaying(false);
    const onTimeUpdate = () => setProgress(video.currentTime);
    const onLoadedMetadata = () => setDuration(video.duration || 0);
    const onWaiting = () => setIsBuffering(true);
    const onPlaying = () => setIsBuffering(false);
    const onCanPlay = () => setIsBuffering(false);
    const onVolumeChange = () => setIsMuted(video.muted);
    // Without this the spinner is the only thing a 404'd clip ever shows.
    const onError = () => {
      setIsBuffering(false);
      setHasError(true);
    };

    video.addEventListener("play", onPlay);
    video.addEventListener("pause", onPause);
    video.addEventListener("timeupdate", onTimeUpdate);
    video.addEventListener("loadedmetadata", onLoadedMetadata);
    video.addEventListener("waiting", onWaiting);
    video.addEventListener("playing", onPlaying);
    video.addEventListener("canplay", onCanPlay);
    video.addEventListener("volumechange", onVolumeChange);
    video.addEventListener("error", onError);

    // The element is brand new, so the session's sound preference has to be
    // re-applied before play() or a user who muted gets a burst of sound.
    video.muted = preferMuted;
    void video.play().catch(() => {
      video.muted = true;
      preferMuted = true;
      setIsMuted(true);
      void video.play().catch(() => {});
    });

    return () => {
      video.removeEventListener("play", onPlay);
      video.removeEventListener("pause", onPause);
      video.removeEventListener("timeupdate", onTimeUpdate);
      video.removeEventListener("loadedmetadata", onLoadedMetadata);
      video.removeEventListener("waiting", onWaiting);
      video.removeEventListener("playing", onPlaying);
      video.removeEventListener("canplay", onCanPlay);
      video.removeEventListener("volumechange", onVolumeChange);
      video.removeEventListener("error", onError);
      // Guarded because a keyed swap could in principle attach the replacement
      // before this runs, and clearing then would strand the controls.
      if (videoRef.current === video) videoRef.current = null;
    };
  }, []);

  React.useEffect(() => {
    const onFullscreenChange = () =>
      setIsFullscreen(document.fullscreenElement === rootRef.current);
    document.addEventListener("fullscreenchange", onFullscreenChange);
    return () => document.removeEventListener("fullscreenchange", onFullscreenChange);
  }, []);

  const togglePlay = React.useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    if (video.paused) {
      void video.play().catch(() => {});
    } else {
      video.pause();
    }
  }, []);

  const toggleMute = React.useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    const next = !video.muted;
    video.muted = next;
    preferMuted = next;
    setIsMuted(next);
  }, []);

  const toggleFullscreen = React.useCallback(() => {
    const root = rootRef.current;
    if (!root) return;
    if (document.fullscreenElement) {
      void document.exitFullscreen().catch(() => {});
    } else {
      void root.requestFullscreen().catch(() => {});
    }
  }, []);

  React.useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && (target.isContentEditable || /^(INPUT|TEXTAREA)$/.test(target.tagName))) return;

      if (event.key === " " || event.key === "k") {
        event.preventDefault();
        togglePlay();
      } else if (event.key === "m") {
        toggleMute();
      } else if (event.key === "f") {
        toggleFullscreen();
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [togglePlay, toggleMute, toggleFullscreen]);

  const seekToPointer = React.useCallback(
    (clientX: number) => {
      const bar = barRef.current;
      const video = videoRef.current;
      if (!bar || !video || !duration) return;

      const rect = bar.getBoundingClientRect();
      const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
      video.currentTime = ratio * duration;
      setProgress(ratio * duration);
    },
    [duration],
  );

  const percent = duration > 0 ? Math.min(100, (progress / duration) * 100) : 0;
  const controlsVisible = isHovering || isScrubbing || !isPlaying;

  if (hasError) {
    return (
      <div
        className={cn(
          "flex flex-col items-center justify-center gap-2 p-8 text-center text-white/50",
          className,
        )}
        data-testid="video-viewer"
      >
        <VideoOff className="h-16 w-16" />
        <p className="text-lg">Video unavailable</p>
        <p className="text-sm">The file may still be uploading, or the backend may be offline</p>
      </div>
    );
  }

  return (
    <div
      ref={rootRef}
      className={cn(
        "group relative inline-block overflow-hidden rounded-xl bg-black leading-none",
        isFullscreen && "flex h-full w-full items-center justify-center rounded-none",
        className,
      )}
      data-testid="video-viewer"
      onMouseEnter={() => setIsHovering(true)}
      onMouseLeave={() => setIsHovering(false)}
    >
      <video
        // Keyed so a new clip gets a new element, which re-runs `attachVideo`.
        key={src}
        ref={attachVideo}
        src={src}
        poster={poster}
        loop
        playsInline
        preload="auto"
        // Sized against the viewport: the lightbox pads by 1rem (6rem from md up).
        className={cn(
          "block h-auto w-auto object-contain",
          isFullscreen
            ? "max-h-[100dvh] max-w-[100vw]"
            : "max-h-[calc(100dvh-2rem)] max-w-[calc(100vw-2rem)] md:max-h-[calc(100dvh-6rem)] md:max-w-[calc(100vw-6rem)]",
        )}
        onClick={togglePlay}
      />

      {isBuffering && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <Loader2 className="h-8 w-8 animate-spin text-white/70" />
        </div>
      )}

      <div
        data-video-controls=""
        className={cn(
          "pointer-events-none absolute inset-x-0 bottom-0 transition-opacity duration-200",
          controlsVisible ? "opacity-100" : "opacity-0",
        )}
      >
        <div className="flex items-end justify-between gap-3 px-3 pb-4 md:px-4">
          <div className="pointer-events-auto flex items-center gap-1.5 rounded-full bg-black/55 py-1 pr-3 pl-1 text-white backdrop-blur-md">
            <button
              type="button"
              aria-label={isPlaying ? "Pause" : "Play"}
              className="grid h-7 w-7 place-items-center rounded-full transition-colors hover:bg-white/15"
              onClick={togglePlay}
            >
              {isPlaying ? (
                <Pause className="h-4 w-4 fill-current" />
              ) : (
                <Play className="h-4 w-4 fill-current" />
              )}
            </button>
            <span className="text-xs font-medium tabular-nums">
              {formatTime(progress)} / {formatTime(duration)}
            </span>
          </div>

          <div className="pointer-events-auto flex items-center gap-0.5 rounded-full bg-black/55 p-1 text-white backdrop-blur-md">
            <button
              type="button"
              aria-label={isMuted ? "Unmute" : "Mute"}
              className="grid h-7 w-7 place-items-center rounded-full transition-colors hover:bg-white/15"
              onClick={toggleMute}
            >
              {isMuted ? <VolumeX className="h-4 w-4" /> : <Volume2 className="h-4 w-4" />}
            </button>
            <button
              type="button"
              aria-label={isFullscreen ? "Exit fullscreen" : "Fullscreen"}
              className="grid h-7 w-7 place-items-center rounded-full transition-colors hover:bg-white/15"
              onClick={toggleFullscreen}
            >
              {isFullscreen ? <Minimize className="h-4 w-4" /> : <Maximize className="h-4 w-4" />}
            </button>
          </div>
        </div>

        <div
          ref={barRef}
          className="group/bar pointer-events-auto absolute inset-x-0 bottom-0 flex h-4 cursor-pointer items-end"
          onPointerDown={(event) => {
            event.currentTarget.setPointerCapture(event.pointerId);
            setIsScrubbing(true);
            seekToPointer(event.clientX);
          }}
          onPointerMove={(event) => {
            if (isScrubbing) seekToPointer(event.clientX);
          }}
          onPointerUp={(event) => {
            event.currentTarget.releasePointerCapture(event.pointerId);
            setIsScrubbing(false);
          }}
        >
          <div
            className={cn(
              "w-full bg-white/25 transition-[height] duration-150 group-hover/bar:h-[5px]",
              isScrubbing ? "h-[5px]" : "h-[3px]",
            )}
          >
            <div className="h-full bg-white" style={{ width: `${percent}%` }} />
          </div>
        </div>
      </div>
    </div>
  );
}
