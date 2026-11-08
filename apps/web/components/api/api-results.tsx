"use client";

import * as React from "react";
import { useQuery as useCachedQuery } from "@/lib/convex-cache";
import {
  Check,
  CheckCheck,
  Clapperboard,
  Film,
  Heart,
  ImagePlus,
  Loader2,
  Trash2,
} from "lucide-react";

import { api } from "@/convex/_generated/api";
import { useToggleFavorite } from "@/hooks/use-toggle-favorite";
import { Button } from "@/components/ui/button";
import { MediaMasonry, type MasonryItem, type MasonryLayout } from "@/components/media-masonry";
import { useInfiniteScroll } from "@/hooks/use-infinite-scroll";
import { MAX_PAGE_ROWS, pageRowsFor } from "@/components/api/page-rows";
import { useImageSelection } from "@/hooks/use-image-selection";
import { SelectionToolbar } from "@/components/selection-toolbar";
import { useMediaQuery } from "@/hooks/use-media-query";
import { PreviewZoom, usePreviewZoom } from "@/components/preview-zoom";
import { type LightboxMedia } from "@/components/media-lightbox";
import { GenerationLightbox } from "@/components/generation-lightbox";
import {
  GrokImageTile,
  GrokSourceVideoMenu,
  GrokVideoTile,
  SendToVideoMenu,
  TileActions,
} from "@/components/grok/grok-media-tile";
import { grokVideoOutputSeconds } from "@/lib/grok-imagine";
import { isGrokSourceVideoKey } from "@/lib/image-key";
import { TileTipsProvider, shouldArmTileTips } from "@/components/preview-actions";
import type { VideoHandoffRole } from "@/lib/reference-handoff";
import density from "@/components/preview-density.module.css";
import { PriceTag } from "@/components/api/price-tag";
import { FailureDetails } from "@/components/api/failure-details";
import { GenerationProgress } from "@/components/generation-progress";
import { describeFailure } from "@/lib/failure-message";
import { mediaUrl, thumbUrl, videoPosterIfAvailable, videoUrl } from "@/lib/media-url";
import { usePrefetchNewMedia } from "@/components/media-cache";
import { API_MODELS, type ApiModelId } from "@/lib/api-models";
import { formatCredits, formatUsd } from "@/lib/api-pricing";
import { cn } from "@/lib/utils";
import { atlasDraftCompletionUsd, isCompletableDraft } from "@/lib/atlas-drafts";
import {
  badgeOf,
  effectiveCostUsd,
  isSelfHostedVideo,
  modelIdOf,
  outputKeys,
  priceOf,
  priceOfGeneration,
  providerOf,
  type GenerationDoc,
} from "@/components/api/generation-meta";

export { isSelfHostedVideo, modelIdOf, priceOfGeneration, providerOf, type GenerationDoc };

type ResultsFilter = "all" | "images" | "videos";
/**
 * Model chips. Atlas is one chip rather than three hundred: its models are
 * picked from a search dialog, and a filter row that could grow to the size of
 * the catalogue is not a filter row.
 */
type ModelFilter = "all" | ApiModelId | "atlas" | "comfy";

function parseAspect(ratio: string | undefined): number {
  if (!ratio || ratio === "auto") return 1;
  const [w, h] = ratio.split(":").map(Number);
  return w > 0 && h > 0 ? w / h : 1;
}

/** Headline for a failed tile, so the cause is readable without the full text. */
function failureTitle(gen: GenerationDoc): string {
  switch (gen.errorKind) {
    case "billing":
      return "fal balance empty";
    case "moderation":
      return "Rejected by moderation";
    case "auth":
      return "Not authorised";
    case "timeout":
      return "Timed out";
    case "validation":
      return "Rejected settings";
    default:
      return "Failed";
  }
}

/**
 * "1 of 4" on a completed tile whose batch came back short.
 *
 * Grok's edit endpoint takes no batch parameter, so four images are four
 * requests — and a moderation refusal is an empty response, not an error. The
 * row completes with what survived; without this the missing images simply
 * never existed. The stored reason rides the title attribute.
 */
function ShortfallBadge({ gen }: { gen: GenerationDoc }) {
  const produced = outputKeys(gen).length;
  const requested = gen.count ?? 1;
  if (gen.mediaType !== "image" || produced >= requested) return null;
  return (
    <span
      data-preview-overlay
      title={gen.error ?? undefined}
      className="absolute bottom-1.5 left-1.5 z-10 rounded bg-amber-500/90 px-1.5 py-0.5 text-[10px] font-medium text-black"
    >
      {produced} of {requested}
    </span>
  );
}

/**
 * Model name and price, shown on every tile at every stage.
 *
 * A solid fill, not `backdrop-blur`: the badge is always on screen, often over
 * a clip that is playing, and a backdrop filter is re-rasterised for every
 * decoded frame underneath it.
 */
function ResultBadge({ gen, className }: { gen: GenerationDoc; className?: string }) {
  const badge = badgeOf(gen);
  const billed = providerOf(gen) !== "grok";
  const price = priceOf(gen);
  return (
    <span
      data-preview-overlay
      className={cn(
        "pointer-events-none absolute right-1.5 bottom-1.5 z-10 flex items-center gap-1.5 rounded bg-black/60 px-1.5 py-0.5 text-[10px] font-medium text-white",
        className,
      )}
    >
      <span className="truncate max-w-[12rem]">{badge}</span>
      {price !== null && (
        <span className={cn("opacity-80", billed && "tabular-nums")}>
          {billed && gen.costEstimated ? "≈" : ""}
          {price}
        </span>
      )}
    </span>
  );
}

/**
 * A generation still in flight, with a way to get rid of it.
 *
 * The button dismisses the tile; it does not cancel anything. A vendor that has
 * the job keeps it — on Higgsfield there is no way to take one back — so this is
 * for the case where the result stopped being wanted and the spinner is just in
 * the way. The title says so rather than implying a cancel that isn't happening.
 *
 * `group`/`opacity` rather than always-on, because the one thing this button
 * must never do is invite a stray click that throws away a running job.
 */
function PendingTile({
  gen,
  onRemove,
}: {
  gen: GenerationDoc;
  onRemove: (gen: GenerationDoc) => void;
}) {
  return (
    <>
      <div className="group absolute inset-0 flex items-center justify-center rounded-md border border-border/50 bg-muted/30 px-2 text-center">
        <div className="w-full max-w-[16rem] space-y-3">
          <Loader2 className="mx-auto h-7 w-7 animate-spin text-primary" />
          <GenerationProgress value={gen} />
        </div>
        <Button
          variant="destructive"
          size="icon"
          className="absolute top-1.5 right-1.5 h-7 w-7 opacity-0 transition-opacity group-hover:opacity-80 hover:opacity-100 focus-visible:opacity-100"
          title="Remove from results (the job itself cannot be cancelled)"
          onClick={() => onRemove(gen)}
        >
          <Trash2 className="h-3.5 w-3.5" />
          <span className="sr-only">Remove this generation from the results</span>
        </Button>
      </div>
      <ResultBadge gen={gen} />
    </>
  );
}

function FailedTile({
  gen,
  onRecreate,
  onRemove,
}: {
  gen: GenerationDoc;
  onRecreate: (gen: GenerationDoc) => void;
  onRemove: (gen: GenerationDoc) => void;
}) {
  const title = failureTitle(gen);
  const failure = describeFailure(gen.error);
  const [tipsArmed, setTipsArmed] = React.useState(false);
  const armTips = (event: React.PointerEvent | React.FocusEvent) => {
    if (!tipsArmed && shouldArmTileTips(event)) setTipsArmed(true);
  };

  return (
    <>
      {/* overflow-hidden and the wrap rules are both load-bearing: vendor errors
          arrive as one unbroken JSON string, which line-clamp alone lets spill
          across neighbouring tiles. */}
      <div
        className={cn(
          "group absolute inset-0 flex flex-col items-center justify-center gap-1 overflow-hidden rounded-md border border-destructive/30 bg-destructive/10 px-3 pb-7 text-center",
          density.tile,
        )}
        onPointerEnter={armTips}
      >
        {/* The title and the Details button never yield; on a short tile it is
            the description that gives up lines, not the way out of it. */}
        <p className="shrink-0 text-sm font-medium text-destructive">{title}</p>
        <p className="line-clamp-3 min-h-0 w-full text-xs break-words text-muted-foreground [overflow-wrap:anywhere]">
          {failure.summary}
        </p>
        {failure.hasMore && (
          <div className="shrink-0">
            <FailureDetails title={title} message={failure.full} />
          </div>
        )}
        {/* The same row as a finished tile, minus what needs an output: the
            prompt and settings are all on the row, so a failure is one click
            from a retry. */}
        <TileTipsProvider value={tipsArmed}>
          <TileActions
            copyPrompt={gen.prompt}
            onReproduce={() => onRecreate(gen)}
            onDelete={() => onRemove(gen)}
          />
        </TileTipsProvider>
      </div>
      <ResultBadge gen={gen} />
    </>
  );
}

/**
 * The whole tile becomes one checkbox while selecting, laid over the tile's own
 * controls so a click can only ever toggle — never open the lightbox, never
 * press a Delete that happened to be under the pointer.
 */
function SelectOverlay({
  selected,
  onToggle,
}: {
  selected: boolean;
  onToggle: (shiftKey: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={selected}
      aria-label={selected ? "Deselect generation" : "Select generation"}
      className={cn(
        "absolute inset-0 z-30 cursor-pointer rounded-md transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        selected ? "bg-primary/20 ring-2 ring-primary ring-inset" : "hover:bg-white/5",
      )}
      onClick={(event) => {
        event.stopPropagation();
        onToggle(event.shiftKey);
      }}
    >
      <span
        className={cn(
          "absolute top-2 left-2 flex h-5 w-5 items-center justify-center rounded-md border transition-colors",
          selected
            ? "border-primary bg-primary text-primary-foreground"
            : "border-white/40 bg-black/50 text-transparent",
        )}
      >
        <Check className="h-3.5 w-3.5" />
      </span>
    </button>
  );
}

interface ApiResultsProps {
  /**
   * False while the panel holding this grid is hidden. Its keyboard shortcuts
   * (Escape, Delete) belong to whichever grid is on screen. Defaults to true.
   */
  active?: boolean;
  generations: GenerationDoc[];
  canLoadMore: boolean;
  /** True while a page is in flight, so the sentinel does not ask for a second. */
  isLoadingMore: boolean;
  /** Asks for `numItems` more rows; the grid sizes the page to its density. */
  onLoadMore: (numItems: number) => void;
  onRecreate: (gen: GenerationDoc) => void;
  /** Finishes a Seedance 2.5 draft at 1080p (see packages/shared/atlas-drafts.ts). */
  onCompleteDraft?: (gen: GenerationDoc) => void;
  /**
   * The whole row, not just its id: the parent decides whether to confirm from
   * it. Resolves to whether the row actually went away, so a caller that has to
   * tear down UI around the deletion can tell a cancelled confirm from a real one.
   */
  onRemove: (gen: GenerationDoc) => Promise<boolean>;
  /** Multi-select delete; resolves to whether the rows went, as `onRemove` does. */
  onRemoveMany: (gens: GenerationDoc[]) => Promise<boolean>;
  onUseAsReference: (url: string, asVideo?: boolean) => void;
  /** Present where the Self-hosted video tab can take the image (API tab). */
  onSendToVideo?: (url: string, role: VideoHandoffRole) => void;
  /** Makes a finished clip the source of a Grok Edit or Extend, by B2 key. */
  onUseAsSourceVideo?: (key: string, mode: "edit" | "extend") => void;
  onRemoveAllFailed: () => void;
  isRemovingFailed: boolean;
}

/**
 * One tile of the grid, memoized.
 *
 * The grid is rebuilt whenever anything about it changes — a tile reporting its
 * measured aspect, a heart, the next page arriving — and without a boundary
 * every tile re-rendered along with it, icons and tooltips included. Every prop
 * here is either a primitive, a row that keeps its identity until Convex sends
 * a new one, or a callback that takes its subject as an argument, so a tile
 * only re-renders when something about that tile moved.
 */
const MediaResultTile = React.memo(function MediaResultTile({
  gen,
  entryKey,
  b2Key,
  url,
  type,
  active,
  isFavorite,
  selectionActive,
  selected,
  onOpen,
  onAspect,
  onRecreate,
  onRemove,
  onUseAsReference,
  onSendToVideo,
  onUseAsSourceVideo,
  onToggleFavorite,
  onSelect,
}: {
  gen: GenerationDoc;
  entryKey: string;
  b2Key: string;
  url: string;
  type: "image" | "video";
  active: boolean;
  isFavorite: boolean;
  selectionActive: boolean;
  selected: boolean;
  /** By key, not position: a result landing on top would shift every index. */
  onOpen: (entryKey: string) => void;
  onAspect: (key: string, aspect: number) => void;
  onRecreate: (gen: GenerationDoc) => void;
  onRemove: (gen: GenerationDoc) => void;
  onUseAsReference: (url: string, asVideo: boolean) => void;
  onSendToVideo?: (url: string, role: VideoHandoffRole) => void;
  onUseAsSourceVideo?: (key: string, mode: "edit" | "extend") => void;
  onToggleFavorite: (gen: GenerationDoc, b2Key: string) => void;
  onSelect: (id: string, shiftKey: boolean) => void;
}) {
  return (
    <>
      {type === "video" ? (
        <GrokVideoTile
          src={url}
          poster={videoPosterIfAvailable(b2Key)}
          alt={gen.prompt}
          // An extension is its source plus the added seconds, an edit keeps
          // its source's length — the stored duration is neither.
          durationHint={grokVideoOutputSeconds(gen)}
          active={active}
          onAspect={(aspect) => onAspect(entryKey, aspect)}
          onClick={() => onOpen(entryKey)}
          onReproduce={() => onRecreate(gen)}
          onGrokSourceVideo={
            // Any provider's clip, as long as it is an mp4 — the one container
            // Grok's Edit and Extend take.
            onUseAsSourceVideo && isGrokSourceVideoKey(b2Key)
              ? (mode) => onUseAsSourceVideo(b2Key, mode)
              : undefined
          }
          onDelete={() => onRemove(gen)}
          copyPrompt={gen.prompt}
          isFavorite={isFavorite}
          onToggleFavorite={() => onToggleFavorite(gen, b2Key)}
        />
      ) : (
        <GrokImageTile
          src={thumbUrl(b2Key)}
          fallbackSrc={url}
          alt={gen.prompt}
          onAspect={(aspect) => onAspect(entryKey, aspect)}
          onClick={() => onOpen(entryKey)}
          onReproduce={() => onRecreate(gen)}
          onUseAsReference={() => onUseAsReference(url, false)}
          onMakeVideo={() => onUseAsReference(url, true)}
          onSendToVideo={onSendToVideo ? (role) => onSendToVideo(url, role) : undefined}
          onDelete={() => onRemove(gen)}
          copyPrompt={gen.prompt}
          isFavorite={isFavorite}
          onToggleFavorite={() => onToggleFavorite(gen, b2Key)}
        />
      )}
      <ShortfallBadge gen={gen} />
      <ResultBadge gen={gen} />
      {selectionActive && (
        <SelectOverlay selected={selected} onToggle={(shiftKey) => onSelect(gen._id, shiftKey)} />
      )}
    </>
  );
});

/** Pending and failed tiles, behind the same kind of boundary as the media. */
const StatusResultTile = React.memo(function StatusResultTile({
  gen,
  selectionActive,
  selected,
  onRecreate,
  onRemove,
  onSelect,
}: {
  gen: GenerationDoc;
  selectionActive: boolean;
  selected: boolean;
  onRecreate: (gen: GenerationDoc) => void;
  onRemove: (gen: GenerationDoc) => void;
  onSelect: (id: string, shiftKey: boolean) => void;
}) {
  return (
    <>
      {gen.status === "failed" ? (
        <FailedTile gen={gen} onRecreate={onRecreate} onRemove={onRemove} />
      ) : (
        <PendingTile gen={gen} onRemove={onRemove} />
      )}
      {selectionActive && (
        <SelectOverlay selected={selected} onToggle={(shiftKey) => onSelect(gen._id, shiftKey)} />
      )}
    </>
  );
});

export function ApiResults({
  active = true,
  generations,
  canLoadMore,
  isLoadingMore,
  onLoadMore,
  onRecreate,
  onCompleteDraft,
  onRemove,
  onRemoveMany,
  onUseAsReference,
  onSendToVideo,
  onUseAsSourceVideo,
  onRemoveAllFailed,
  isRemovingFailed,
}: ApiResultsProps) {
  const desktop = useMediaQuery("(min-width: 64rem)");
  const [previewScale, setPreviewScale] = usePreviewZoom("generate-preview-scale-api");
  // Favourites are keyed by B2 key, so the same query serves both tabs and a
  // result favourited here shows up hearted in the gallery too.
  const favoriteKeys = useCachedQuery(api.favorites.myKeys);
  const toggleFavorite = useToggleFavorite();
  const favorites = new Set(favoriteKeys ?? []);

  const onToggleFavorite = (gen: GenerationDoc, b2Key: string) => {
    void toggleFavorite({ apiGenerationId: gen._id, b2Key });
  };

  const [mediaFilter, setMediaFilter] = React.useState<ResultsFilter>("all");
  const [modelFilter, setModelFilter] = React.useState<ModelFilter>("all");
  // Liked is per output, not per row: one hearted image of a batch of four
  // shows that one image. In-flight and failed rows have nothing to like.
  const [likedOnly, setLikedOnly] = React.useState(false);
  const [lightboxIndex, setLightboxIndex] = React.useState(0);
  const [lightboxOpen, setLightboxOpen] = React.useState(false);

  // Plain values throughout: the React Compiler memoizes this component, and a
  // hand-written useMemo over thirty rows is cost without a benefit.
  const matchesFilter = (gen: GenerationDoc) => {
    const mediaOk =
      mediaFilter === "all" ||
      (mediaFilter === "images" ? gen.mediaType === "image" : gen.mediaType === "video");
    return mediaOk && matchesModelFilter(gen, modelFilter);
  };
  const isLiked = (gen: GenerationDoc) => outputKeys(gen).some((key) => favorites.has(key));

  const pending = generations.filter(
    (gen) =>
      !likedOnly && (gen.status === "pending" || gen.status === "processing") && matchesFilter(gen),
  );
  const allFailed = generations.filter((gen) => gen.status === "failed");
  const failed = likedOnly ? [] : allFailed.filter((gen) => matchesFilter(gen));
  const completed = generations.filter(
    (gen) => gen.status === "completed" && matchesFilter(gen) && (!likedOnly || isLiked(gen)),
  );

  // Dollars only. Grok runs on a subscription and Higgsfield on plan credits,
  // and summing three different units into one figure would be meaningless.
  const sumCost = (rows: GenerationDoc[]) =>
    rows.reduce((total, gen) => {
      const provider = providerOf(gen);
      // Both bill in dollars, so both belong in the same running total.
      return provider === "fal" || provider === "atlas"
        ? total + (effectiveCostUsd(gen) ?? 0)
        : total;
    }, 0);
  // Settled work only, and only what the active filters show: in-flight spend is
  // reported separately, and counting it in both places shows the same money twice.
  const sumCredits = (rows: GenerationDoc[]) =>
    rows.reduce(
      (total, gen) => (providerOf(gen) === "higgsfield" ? total + (gen.creditsUsed ?? 0) : total),
      0,
    );
  const spentUsd = sumCost([...completed, ...failed]);
  const pendingSpendUsd = sumCost(pending);
  const spentCredits = sumCredits([...completed, ...failed]);
  // A batch of four 4k clips is 880 credits in flight; reporting only the count
  // left the largest number on the page unsaid.
  const pendingCredits = sumCredits(pending);

  /** A drained balance blocks every future request, so it is worth calling out
   *  above the grid rather than leaving it buried on one tile. */
  const billingFailure = allFailed.find((gen) => gen.errorKind === "billing");

  type MediaEntry = {
    key: string;
    b2Key: string;
    url: string;
    type: "image" | "video";
    gen: GenerationDoc;
  };

  // Every completed output in grid order — images and videos share one lightbox
  // sequence, so the arrows walk the whole result set.
  const mediaEntries: MediaEntry[] = completed.flatMap((gen) =>
    outputKeys(gen)
      .filter((b2Key) => !likedOnly || favorites.has(b2Key))
      .map((b2Key) => ({
        key: `${gen._id}:${b2Key}`,
        b2Key,
        url: gen.mediaType === "video" ? videoUrl(b2Key) : mediaUrl(b2Key),
        type: gen.mediaType,
        gen,
      })),
  );
  const lightboxItems: LightboxMedia[] = mediaEntries.map((entry) => ({
    url: entry.url,
    type: entry.type,
  }));
  const entryByUrl = new Map(mediaEntries.map((entry) => [entry.url, entry]));
  // A result that just finished is downloaded in the background, so opening it
  // plays from the local media cache.
  usePrefetchNewMedia(mediaEntries.map((entry) => entry.url));

  // Real aspect ratios, measured by the tiles: requested ratios are missing for
  // single-reference videos and meaningless for "auto" images.
  const [aspects, setAspects] = React.useState<Record<string, number>>({});
  const reportAspect = (key: string, aspect: number) => {
    setAspects((prev) => (prev[key] === aspect ? prev : { ...prev, [key]: aspect }));
  };

  // Read at click time, so `openLightbox` keeps one identity for every tile.
  const entryKeys = React.useRef<string[]>([]);
  React.useLayoutEffect(() => {
    entryKeys.current = mediaEntries.map((entry) => entry.key);
  });
  const openLightbox = (entryKey: string) => {
    const index = entryKeys.current.indexOf(entryKey);
    if (index === -1) return;
    setLightboxIndex(index);
    setLightboxOpen(true);
  };

  // Selection is by generation, not by output: a row is what gets deleted, so
  // picking one image of a batch of four marks all four — the grid shows what
  // the delete will actually take. Only rows the filters let through count,
  // so a selection can never reach something off screen.
  const visibleRows = [...pending, ...failed, ...completed];
  const visibleIds = visibleRows.map((gen) => gen._id as string);
  const { selectedKeys, selectionActive, handleSelect, selectKeys, enterSelection, exitSelection } =
    useImageSelection(visibleIds);
  const selectedRows = visibleRows.filter((gen) => selectedKeys.has(gen._id));
  const [isDeletingSelection, setIsDeletingSelection] = React.useState(false);

  const deleteSelection = async () => {
    if (selectedRows.length === 0 || isDeletingSelection) return;
    setIsDeletingSelection(true);
    const removed = await onRemoveMany(selectedRows);
    setIsDeletingSelection(false);
    if (removed) exitSelection();
  };

  // Escape leaves, Delete deletes — the gallery's keys, so both grids behave alike.
  const onDeleteKey = React.useEffectEvent(() => void deleteSelection());
  React.useEffect(() => {
    if (!active || !selectionActive || lightboxOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      // Neither key belongs to the grid while something else has it: a dialog
      // that already handled Escape, or a field being typed in.
      if (event.defaultPrevented) return;
      const target = event.target as HTMLElement | null;
      if (target?.closest('input, textarea, select, [contenteditable="true"], [role="textbox"]')) {
        return;
      }
      if (event.key === "Escape") {
        exitSelection();
        return;
      }
      if (event.key !== "Delete" && event.key !== "Backspace") return;
      if (event.repeat || event.metaKey || event.ctrlKey || event.altKey) return;
      event.preventDefault();
      onDeleteKey();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [active, selectionActive, lightboxOpen, exitSelection]);

  const hasResults = pending.length > 0 || failed.length > 0 || completed.length > 0;
  const isFiltered = likedOnly || mediaFilter !== "all" || modelFilter !== "all";

  // Chips for the models that actually appear in the loaded rows. Offering the
  // whole catalogue meant most chips could only ever come back empty; the
  // active one is kept regardless so a filter never becomes unclearable when
  // its last row is deleted.
  const presentModels = new Set(
    generations
      .filter((gen) => providerOf(gen) !== "atlas" && !isSelfHostedVideo(gen))
      .map(modelIdOf),
  );
  const hasAtlas = generations.some((gen) => providerOf(gen) === "atlas");
  const hasComfy = generations.some(isSelfHostedVideo);
  const modelFilters: ModelFilter[] = [
    "all",
    ...(Object.keys(API_MODELS) as ApiModelId[]).filter(
      (id) => presentModels.has(id) || modelFilter === id,
    ),
    ...(hasAtlas || modelFilter === "atlas" ? (["atlas"] as const) : []),
    ...(hasComfy || modelFilter === "comfy" ? (["comfy"] as const) : []),
  ];

  const statusTile = (gen: GenerationDoc) => ({
    key: `${gen.status === "failed" ? "failed" : "pending"}:${gen._id}`,
    aspect: parseAspect(gen.aspectRatio),
    node: (
      <StatusResultTile
        gen={gen}
        selectionActive={selectionActive}
        selected={selectedKeys.has(gen._id)}
        onRecreate={onRecreate}
        onRemove={onRemove}
        onSelect={handleSelect}
      />
    ),
  });
  const masonryItems: MasonryItem[] = [
    ...pending.map(statusTile),
    ...failed.map(statusTile),
    ...mediaEntries.map((entry) => ({
      key: entry.key,
      aspect: aspects[entry.key] ?? parseAspect(entry.gen.aspectRatio),
      node: (
        <MediaResultTile
          gen={entry.gen}
          entryKey={entry.key}
          b2Key={entry.b2Key}
          url={entry.url}
          type={entry.type}
          active={!lightboxOpen}
          isFavorite={favorites.has(entry.b2Key)}
          selectionActive={selectionActive}
          selected={selectedKeys.has(entry.gen._id)}
          onOpen={openLightbox}
          onAspect={reportAspect}
          onRecreate={onRecreate}
          onRemove={onRemove}
          onUseAsReference={onUseAsReference}
          onSendToVideo={onSendToVideo}
          onUseAsSourceVideo={onUseAsSourceVideo}
          onToggleFavorite={onToggleFavorite}
          onSelect={handleSelect}
        />
      ),
    })),
  ];

  // A ref, not state: it is only read when a page is asked for, and as state
  // every pixel of a split-pane drag re-rendered the whole grid.
  const layout = React.useRef<MasonryLayout | null>(null);
  const reportLayout = (next: MasonryLayout) => {
    layout.current = next;
  };

  const sentinelRef = useInfiniteScroll({
    // Sized when asked, not when rendered: it reads the window's height. An
    // empty grid with more to fetch is a filter that matched nothing loaded yet,
    // so it looks further per request.
    onLoadMore: () =>
      onLoadMore(hasResults ? pageRowsFor(layout.current, generations.length) : MAX_PAGE_ROWS),
    hasMore: canLoadMore,
    busy: isLoadingMore,
    revision: masonryItems.length,
    resetKey: `${mediaFilter}:${modelFilter}:${likedOnly}`,
    // Every row comes from a Convex history, which ends: with the end of the
    // list on screen, keep looking until it does.
    maxIdlePagesOnScreen: Infinity,
    // Relative, so the head start is a screen and a half whatever the zoom: a
    // fixed 600px was most of a screen at 175% browser zoom and a third of one
    // at 67%.
    rootMargin: "150%",
  });

  return (
    <div className="max-w-3xl mx-auto lg:max-w-none">
      <div className="flex items-center justify-between mb-3 gap-2 flex-wrap">
        <div className="flex items-baseline gap-2">
          <h2 className="text-base font-semibold">Results</h2>
          {/* Two units, side by side — one number would have needed a rate. */}
          {spentUsd > 0 && (
            <span
              className="text-xs text-muted-foreground tabular-nums"
              title="USD spend for fal and Atlas results loaded on this page"
            >
              {formatUsd(spentUsd)} spent
            </span>
          )}
          {spentCredits > 0 && (
            <span
              className="text-xs text-muted-foreground tabular-nums"
              title="Higgsfield credits for the results loaded on this page"
            >
              {formatCredits(spentCredits)} credits
            </span>
          )}
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <PreviewZoom scale={previewScale} onChange={setPreviewScale} />
          {selectionActive && selectedRows.length < visibleRows.length && (
            <Button
              variant="ghost"
              size="sm"
              className="h-8 gap-1.5"
              onClick={() => selectKeys(visibleIds)}
            >
              <CheckCheck className="h-3.5 w-3.5" />
              Select all {visibleRows.length}
            </Button>
          )}
          {hasResults && (
            <Button
              variant={selectionActive ? "secondary" : "outline"}
              size="sm"
              className="h-8"
              onClick={selectionActive ? exitSelection : enterSelection}
            >
              {selectionActive ? "Cancel" : "Select"}
            </Button>
          )}
          {pending.length > 0 && (
            <span className="text-xs text-muted-foreground flex items-center gap-1.5">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              {pending.length} generating
              {pendingSpendUsd > 0 && (
                <span className="tabular-nums">· {formatUsd(pendingSpendUsd)}</span>
              )}
              {pendingCredits > 0 && (
                <span className="tabular-nums">· {formatCredits(pendingCredits)} credits</span>
              )}
            </span>
          )}
          {allFailed.length > 0 && (
            <Button
              variant="outline"
              size="sm"
              className="h-8 text-destructive hover:text-destructive"
              disabled={isRemovingFailed}
              onClick={onRemoveAllFailed}
            >
              {isRemovingFailed ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Trash2 className="h-3.5 w-3.5" />
              )}
              Remove all failed
            </Button>
          )}
          <Button
            variant={likedOnly ? "default" : "outline"}
            size="sm"
            aria-pressed={likedOnly}
            title={likedOnly ? "Show all results" : "Show only liked results"}
            className="h-8 gap-1.5"
            onClick={() => setLikedOnly((on) => !on)}
          >
            <Heart className={cn("h-3.5 w-3.5", likedOnly && "fill-current")} />
            Liked
          </Button>
          <div
            role="group"
            aria-label="Filter by media type"
            className="inline-flex items-center gap-0.5 p-0.5 rounded-md border bg-card"
          >
            {(["all", "images", "videos"] as const).map((filter) => (
              <Button
                key={filter}
                variant={mediaFilter === filter ? "default" : "ghost"}
                size="sm"
                aria-pressed={mediaFilter === filter}
                className="h-6 px-2 text-[11px] font-normal capitalize"
                onClick={() => setMediaFilter(filter)}
              >
                {filter}
              </Button>
            ))}
          </div>
          <div
            role="group"
            aria-label="Filter by model"
            className="inline-flex max-w-full flex-wrap items-center gap-0.5 p-0.5 rounded-md border bg-card"
          >
            {modelFilters.map((filter) => (
              <Button
                key={filter}
                variant={modelFilter === filter ? "default" : "ghost"}
                size="sm"
                aria-pressed={modelFilter === filter}
                className="h-6 px-2 text-[11px] font-normal"
                onClick={() => setModelFilter(filter)}
              >
                {filter === "all"
                  ? "All models"
                  : filter === "atlas"
                    ? "Atlas"
                    : filter === "comfy"
                      ? "Self-hosted video"
                      : API_MODELS[filter].badge}
              </Button>
            ))}
          </div>
        </div>
      </div>

      {billingFailure && (
        <div className="mb-4 rounded-lg border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm">
          <p className="font-medium text-destructive">fal balance exhausted</p>
          <p className="text-muted-foreground">
            Top up at{" "}
            <a
              href="https://fal.ai/dashboard/billing"
              target="_blank"
              rel="noreferrer"
              className="underline"
            >
              fal.ai/dashboard/billing
            </a>{" "}
            — Seedream and Seedance requests will keep failing until you do. Grok is unaffected.
          </p>
        </div>
      )}

      {hasResults ? (
        <MediaMasonry
          items={masonryItems}
          allowSingleColumn={desktop === true}
          previewScale={previewScale}
          onLayoutChange={reportLayout}
        />
      ) : (
        <div className="py-16 flex items-center justify-center text-muted-foreground">
          <div className="text-center space-y-2">
            {/* Filtering happens over the loaded page only, so an empty screen
                usually means "not on this page yet", not "never generated". */}
            <p className="text-lg">{isFiltered ? "Nothing here matches" : "No results yet"}</p>
            {/* Only point at Load more while the button is actually on screen:
                once the query is exhausted there is nothing older to fetch, and
                naming a control that isn't there reads as a broken UI. */}
            <p className="text-sm">
              {isFiltered
                ? canLoadMore
                  ? "Older results are still loading — scroll, or clear the filters."
                  : "Clear the filters to see everything."
                : "Generated media will appear here"}
            </p>
          </div>
        </div>
      )}

      {/* Outside the branch above: with a filter on, an empty screen is exactly
          when loading the next page is the way out of it.

          A sentinel rather than a button, and a sibling of the masonry rather than
          a child of it — every tile in there is absolutely positioned at the
          container's origin, so a sentinel inside would sit permanently at the top
          of the grid, permanently intersecting, and page until the query ran dry.

          `revision` counts the tiles the filters actually let through, not the rows
          fetched. With "Videos" selected, a page of stills grows `generations` while
          the grid stays empty, and paging off the fetched count would treat that as
          progress. The visible count lets the stall guard pause after three quiet
          pages once there is enough content to scroll, while an underfilled grid
          keeps looking until it finds videos or exhausts the history. */}
      {(canLoadMore || isLoadingMore) && (
        <div ref={sentinelRef} className="flex justify-center py-8">
          {/* Mounted for `isLoadingMore` too, not just `CanLoadMore`. Convex's
              status is one or the other, so gating the node on `canLoadMore`
              alone unmounted the sentinel for the whole duration of the fetch:
              the spinner could never be seen, and the hook lost its node and had
              to rediscover the scroll root on every page instead of using the
              re-observe it already does after a load. */}
          {isLoadingMore && <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />}
        </div>
      )}

      <SelectionToolbar
        count={selectedRows.length}
        onDelete={() => void deleteSelection()}
        onClear={exitSelection}
        isDeleting={isDeletingSelection}
      />

      <GenerationLightbox
        onUseReference={onUseAsReference}
        onReproduceApi={onRecreate}
        getSource={(url) => {
          const gen = entryByUrl.get(url)?.gen;
          return gen ? { kind: "api", id: gen._id } : undefined;
        }}
        items={lightboxItems}
        initialIndex={lightboxIndex}
        isOpen={lightboxOpen}
        onClose={() => setLightboxOpen(false)}
        onReproduce={(url) => {
          const entry = entryByUrl.get(url);
          if (entry) onRecreate(entry.gen);
        }}
        renderActions={(url) => {
          const entry = entryByUrl.get(url);
          if (!entry) return null;
          // The price shows for every item but a self-hosted clip, which has
          // none (the pod bills by the hour; Details has its GPU time). The two
          // actions feed a still image back into the form, which videos can't do.
          const favorited = favorites.has(entry.b2Key);
          const head = (
            <>
              {!isSelfHostedVideo(entry.gen) && (
                <PriceTag
                  price={priceOfGeneration(entry.gen)}
                  approximate={entry.gen.costEstimated}
                  className="mr-2 text-white/70"
                />
              )}
              <Button
                variant="ghost"
                size="icon"
                className="text-white/70 hover:bg-white/10 hover:text-white"
                title={favorited ? "Remove from favorites" : "Add to favorites"}
                onClick={() => onToggleFavorite(entry.gen, entry.b2Key)}
              >
                <Heart className={cn("h-6 w-6", favorited && "fill-red-500 text-red-500")} />
                <span className="sr-only">
                  {favorited ? "Remove from favorites" : "Add to favorites"}
                </span>
              </Button>
            </>
          );
          // Deleting closes the view — but only once it has happened. The list
          // shifts under an open lightbox, so staying put would leave a
          // *different* result under the same finger; closing before the parent's
          // confirmation would dump the user back on the grid having deleted
          // nothing, with no way to tell the two outcomes apart.
          // `ml-2` keeps it off the end of the row it shares with Reproduce.
          const remove = (
            <Button
              variant="ghost"
              size="icon"
              className="ml-2 text-white/70 hover:bg-red-500/20 hover:text-red-400"
              title="Delete generation"
              onClick={() => {
                void onRemove(entry.gen).then((removed) => {
                  if (removed) setLightboxOpen(false);
                });
              }}
            >
              <Trash2 className="h-6 w-6" />
              <span className="sr-only">Delete generation</span>
            </Button>
          );
          if (entry.type !== "image") {
            // A Seedance 2.5 draft can be re-rendered at 1080p from itself.
            const finish =
              onCompleteDraft && isCompletableDraft(entry.gen) ? (
                <Button
                  variant="ghost"
                  className="text-white/70 hover:bg-white/10 hover:text-white"
                  title="Render this draft again at 1080p, from its own settings"
                  onClick={() => {
                    setLightboxOpen(false);
                    onCompleteDraft(entry.gen);
                  }}
                >
                  <Clapperboard className="h-5 w-5" />
                  Finish in 1080p
                  {atlasDraftCompletionUsd(entry.gen) !== null && (
                    <span className="opacity-70 tabular-nums">
                      ≈{formatUsd(atlasDraftCompletionUsd(entry.gen)!)}
                    </span>
                  )}
                </Button>
              ) : null;
            return (
              <>
                {head}
                {finish}
                {onUseAsSourceVideo && isGrokSourceVideoKey(entry.b2Key) && (
                  <GrokSourceVideoMenu
                    triggerClassName="inline-flex h-9 w-9 items-center justify-center rounded-md text-white/70 hover:bg-white/10 hover:text-white"
                    iconClassName="h-6 w-6"
                    onPick={(mode) => {
                      setLightboxOpen(false);
                      onUseAsSourceVideo(entry.b2Key, mode);
                    }}
                  />
                )}
                {remove}
              </>
            );
          }
          return (
            <>
              {head}
              <Button
                variant="ghost"
                size="icon"
                className="text-white/70 hover:text-white hover:bg-white/10"
                title="Use as reference"
                onClick={() => {
                  setLightboxOpen(false);
                  onUseAsReference(url, false);
                }}
              >
                <ImagePlus className="h-6 w-6" />
                <span className="sr-only">Use as reference</span>
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className="text-white/70 hover:text-white hover:bg-white/10"
                title="Make video from this image"
                onClick={() => {
                  setLightboxOpen(false);
                  onUseAsReference(url, true);
                }}
              >
                <Film className="h-6 w-6" />
                <span className="sr-only">Make video</span>
              </Button>
              {onSendToVideo && (
                <SendToVideoMenu
                  triggerClassName="inline-flex h-9 w-9 items-center justify-center rounded-md text-white/70 hover:bg-white/10 hover:text-white"
                  iconClassName="h-6 w-6"
                  onSend={(role) => {
                    setLightboxOpen(false);
                    onSendToVideo(url, role);
                  }}
                />
              )}
              {remove}
            </>
          );
        }}
      />
    </div>
  );
}

/**
 * Whether a row belongs under the active chip.
 *
 * Atlas is matched by provider rather than by model id, because its chip stands
 * for the whole catalogue — `modelIdOf` cannot name an Atlas model and would
 * quietly file every one of them under Grok.
 */
function matchesModelFilter(gen: GenerationDoc, filter: ModelFilter): boolean {
  if (filter === "all") return true;
  if (filter === "comfy") return isSelfHostedVideo(gen);
  if (filter === "atlas") return providerOf(gen) === "atlas";
  return providerOf(gen) !== "atlas" && !isSelfHostedVideo(gen) && modelIdOf(gen) === filter;
}
