"use client";

import { memo, useState, useEffect, useRef } from "react";
import { format } from "date-fns";
import {
  Trash2,
  RefreshCw,
  ChevronDown,
  ChevronUp,
  ImageOff,
  Settings2,
  Cpu,
  Zap,
  Sparkles,
  Copy,
  Check,
} from "lucide-react";
import type { GenerateFormState } from "@/lib/types";
import { mediaUrl, thumbUrl } from "@/lib/media-url";
import { Card, CardContent, CardFooter, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { copyText } from "@/lib/copy-text";
import { cn } from "@/lib/utils";
import { toast } from "sonner";

// Global cache for loaded images
const loadedImagesCache = new Set<string>();

/**
 * The card takes the row's own fields rather than an assembled entry object, and
 * every callback takes what it acts on, so a parent can hand the same functions to
 * every card and `memo` holds. A history page re-renders on every Convex push —
 * including the ~1 Hz progress writes of a running generation — and before this
 * each push re-rendered every card on it.
 */
interface GenerationCardProps {
  id: string;
  timestamp: number;
  formState: GenerateFormState;
  /** Output keys. Old HF Space rows have none — their images are gone. */
  b2Keys?: readonly string[];
  /** Awaited so the card can report whether the delete actually happened. */
  onDelete: (id: string) => void | Promise<void>;
  onReproduce: (formState: GenerateFormState) => void;
  onSendToEnhance?: (imageUrl: string) => void;
  onSendToApi?: (imageUrl: string) => void;
  /** Full-size URLs, for the lightbox — the card itself shows thumbnails. */
  onImageClick?: (imageUrls: string[], index: number, formState?: Record<string, unknown>) => void;
}

function LazyImage({
  src,
  fallbackSrc,
  alt,
  className,
  aspectRatio,
}: {
  src: string;
  /** The original, tried once if the thumbnail transform fails. */
  fallbackSrc?: string;
  alt: string;
  className?: string;
  aspectRatio?: number;
}) {
  const isCached = loadedImagesCache.has(src);
  const [error, setError] = useState(false);
  const [fellBack, setFellBack] = useState(false);
  const [loaded, setLoaded] = useState(isCached);
  const [isVisible, setIsVisible] = useState(isCached);
  const imgRef = useRef<HTMLDivElement>(null);
  const shown = fellBack && fallbackSrc ? fallbackSrc : src;

  useEffect(() => {
    // Skip observer if already cached
    if (isCached) return;

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setIsVisible(true);
          observer.disconnect();
        }
      },
      { rootMargin: "100px", threshold: 0 },
    );

    if (imgRef.current) {
      observer.observe(imgRef.current);
    }

    return () => observer.disconnect();
  }, [isCached]);

  const handleLoad = () => {
    loadedImagesCache.add(src);
    setLoaded(true);
  };

  const handleError = () => {
    if (fallbackSrc && !fellBack && fallbackSrc !== src) setFellBack(true);
    else setError(true);
  };

  if (error) {
    return (
      <div
        className="w-full flex flex-col items-center justify-center text-muted-foreground bg-muted/50"
        style={{ aspectRatio: aspectRatio ?? 1 }}
      >
        <ImageOff className="h-8 w-8 mb-2 opacity-50" />
        <span className="text-xs">Unavailable</span>
      </div>
    );
  }

  return (
    <div ref={imgRef} className="relative w-full" style={{ aspectRatio: aspectRatio ?? 1 }}>
      {isVisible ? (
        <>
          <img
            src={shown}
            alt={alt}
            decoding="async"
            className={cn(className, "w-full h-full object-cover", !loaded && "opacity-0")}
            onLoad={handleLoad}
            onError={handleError}
          />
          {!loaded && <div className="absolute inset-0 animate-pulse bg-muted" />}
        </>
      ) : (
        <div className="absolute inset-0 animate-pulse bg-muted" />
      )}
    </div>
  );
}

function formatModelName(checkpoint: string): string {
  if (!checkpoint) return "Unknown";
  const name =
    checkpoint
      .replace(/\.[^.]+$/, "")
      .split(/[/\\]/)
      .pop() || checkpoint;
  return name.length > 28 ? name.slice(0, 26) + "…" : name;
}

const SETTINGS_LABELS: Record<string, string> = {
  negativePrompt: "Negative Prompt",
  checkpoint: "Model",
  width: "Width",
  height: "Height",
  seed: "Seed",
  steps: "Steps",
  cfg: "CFG",
  sampler: "Sampler",
  scheduler: "Scheduler",
  denoise: "Denoise",
  batchSize: "Batch Size",
};

export const GenerationCard = memo(function GenerationCard({
  id,
  timestamp,
  formState,
  b2Keys,
  onDelete,
  onReproduce,
  onSendToEnhance,
  onSendToApi,
  onImageClick,
}: GenerationCardProps) {
  const [isExpanded, setIsExpanded] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  // Full-size URLs are what every action and the lightbox get; the tiles show a
  // 512px transform — a batch of four originals is megabytes per card.
  const keys = b2Keys ?? [];
  const imageUrls = keys.map((key) => mediaUrl(key));
  const [promptCopied, setPromptCopied] = useState(false);
  useEffect(() => {
    if (!promptCopied) return;
    const timer = setTimeout(() => setPromptCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [promptCopied]);
  // One prompt per card, so one button — a copy control on each of four
  // identical images was four ways to do the same thing, and they shared this
  // state, so copying from one ticked them all.
  const copyPromptButton = formState.prompt ? (
    <Button
      variant="ghost"
      size="icon"
      className="h-8 w-8"
      title={promptCopied ? "Prompt copied" : "Copy prompt"}
      onClick={() => void copyText(formState.prompt).then((ok) => ok && setPromptCopied(true))}
    >
      {promptCopied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
      <span className="sr-only">Copy prompt</span>
    </Button>
  ) : null;

  // Deleting a generation takes its whole batch with it and there is no undo
  // inside the app, so it asks first — and says so afterwards, since a silent
  // failure and a silent success looked identical.
  const handleDelete = async () => {
    const count = imageUrls.length;
    const confirmed = window.confirm(
      `Delete this generation and its ${count} image${count === 1 ? "" : "s"}? This cannot be undone.`,
    );
    if (!confirmed) return;
    try {
      await onDelete(id);
      toast.success("Generation deleted");
    } catch (error) {
      console.error("Delete failed:", error);
      toast.error("Could not delete this generation");
    }
  };

  const dateString = format(new Date(timestamp), "MMM d, yyyy 'at' h:mm a");
  const w = Number(formState.width) || 1;
  const h = Number(formState.height) || 1;
  const imageAspectRatio = w / h;

  const enabledLoras = formState.loras?.filter((l) => l.enabled) ?? [];

  return (
    <Card className="overflow-hidden border-muted bg-card/50 transition-colors hover:bg-card/80">
      <CardHeader className="flex flex-row items-center justify-between space-y-0 p-4 pb-2">
        <div className="flex flex-col gap-1.5">
          <span className="text-xs font-mono text-muted-foreground">{dateString}</span>
          <div className="flex flex-wrap gap-1.5">
            <Badge variant="outline" className="text-[10px] h-5 px-1.5 font-mono">
              {formState.width}x{formState.height}
            </Badge>
            <Badge variant="outline" className="text-[10px] h-5 px-1.5 font-mono">
              {formState.steps} steps
            </Badge>
          </div>
          <div className="flex items-center gap-1.5">
            <Badge
              variant="secondary"
              className="text-[10px] h-5 px-1.5 font-mono max-w-full"
              title={formState.checkpoint}
            >
              <Cpu className="h-3 w-3 shrink-0 mr-0.5" />
              <span className="truncate">{formatModelName(formState.checkpoint)}</span>
            </Badge>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1 self-start">
          {copyPromptButton}
          <Button
            variant="ghost"
            size="icon"
            // Extra margin: this used to sit 4px from Copy prompt, which is a
            // mis-tap away from destroying the batch.
            className="ml-3 h-8 w-8 text-muted-foreground hover:text-destructive hover:bg-destructive/10"
            title="Delete generation"
            onClick={() => void handleDelete()}
          >
            <Trash2 className="h-4 w-4" />
            <span className="sr-only">Delete</span>
          </Button>
        </div>
      </CardHeader>

      <CardContent className="p-4 pt-2 space-y-3">
        <div className="space-y-1">
          <p
            className={cn(
              "text-sm text-foreground/90 leading-relaxed font-medium",
              !isExpanded && "line-clamp-2",
            )}
          >
            {formState.prompt}
          </p>
          {formState.prompt.length > 100 && (
            <button
              type="button"
              onClick={() => setIsExpanded(!isExpanded)}
              className="text-xs text-muted-foreground hover:text-primary flex items-center gap-1 transition-colors"
            >
              {isExpanded ? (
                <>
                  Show less <ChevronUp className="h-3 w-3" />
                </>
              ) : (
                <>
                  Show more <ChevronDown className="h-3 w-3" />
                </>
              )}
            </button>
          )}
        </div>

        <button
          type="button"
          onClick={() => setShowSettings(!showSettings)}
          className="text-xs text-muted-foreground hover:text-primary flex items-center gap-1.5 transition-colors py-0.5"
        >
          <Settings2 className="h-3 w-3" />
          {showSettings ? "Hide settings" : "All settings"}
          {showSettings ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
        </button>

        {showSettings && (
          <div className="rounded-lg border border-border/50 bg-muted/30 overflow-hidden">
            <table className="w-full text-xs">
              <tbody className="divide-y divide-border/30">
                {Object.entries(SETTINGS_LABELS).map(([key, label]) => {
                  const value = formState[key as keyof typeof formState];
                  if (value === undefined || value === null || value === "") return null;
                  return (
                    <tr key={key}>
                      <td className="px-3 py-1.5 text-muted-foreground font-medium whitespace-nowrap w-[1%]">
                        {label}
                      </td>
                      <td className="px-3 py-1.5 text-foreground/90 font-mono break-all">
                        {String(value)}
                      </td>
                    </tr>
                  );
                })}
                {enabledLoras.length > 0 && (
                  <tr>
                    <td className="px-3 py-1.5 text-muted-foreground font-medium whitespace-nowrap w-[1%] align-top">
                      LoRAs
                    </td>
                    <td className="px-3 py-1.5 text-foreground/90 font-mono space-y-0.5">
                      {enabledLoras.map((lora, i) => (
                        <div key={i} className="flex items-center gap-1.5">
                          <span className="break-all">{lora.loraName}</span>
                          <span className="text-muted-foreground shrink-0">
                            ({lora.strengthModel}/{lora.strengthClip})
                          </span>
                        </div>
                      ))}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        )}

        <div
          className={cn(
            "grid gap-2 rounded-md overflow-hidden",
            imageUrls.length === 1 ? "grid-cols-1" : "grid-cols-2",
          )}
        >
          {imageUrls.map((url, index) => (
            <div
              key={`${id}-${index}`}
              className={cn(
                "relative bg-muted/50 overflow-hidden rounded-lg group",
                onImageClick && "cursor-pointer",
              )}
              onClick={() =>
                onImageClick?.(imageUrls, index, formState as unknown as Record<string, unknown>)
              }
            >
              <LazyImage
                src={thumbUrl(keys[index])}
                fallbackSrc={url}
                alt={`Generated image ${index + 1}`}
                className="transition-transform duration-500 group-hover:scale-105"
                aspectRatio={imageAspectRatio}
              />
              {onSendToApi && (
                <Button
                  variant="secondary"
                  size="icon"
                  className="absolute top-2 right-2 z-10 h-8 w-8 opacity-100 transition-opacity md:opacity-0 md:group-hover:opacity-100"
                  title="Send to API models as reference"
                  onClick={(event) => {
                    event.stopPropagation();
                    onSendToApi(url);
                  }}
                >
                  <Sparkles className="h-4 w-4" />
                  <span className="sr-only">Send to API models as reference</span>
                </Button>
              )}
            </div>
          ))}
        </div>
      </CardContent>

      <CardFooter className="p-4 pt-0 gap-2">
        <Button variant="secondary" className="flex-1 gap-2" onClick={() => onReproduce(formState)}>
          <RefreshCw className="h-4 w-4" />
          Reproduce
        </Button>

        {onSendToEnhance && imageUrls.length > 0 && (
          <Button
            variant="secondary"
            className="flex-1 gap-2"
            onClick={() => onSendToEnhance(imageUrls[0])}
          >
            <Zap className="h-4 w-4" />
            Enhance
          </Button>
        )}
      </CardFooter>
    </Card>
  );
});
