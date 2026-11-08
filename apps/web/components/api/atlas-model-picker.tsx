"use client";

import * as React from "react";
import { useMutation, useQuery } from "convex/react";
import { toast } from "sonner";
import { Check, ChevronDown, Search, Star } from "lucide-react";

import { api } from "@/convex/_generated/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  ATLAS_IMAGE_MODES,
  atlasCatalogRows,
  atlasFamilyMaxReferences,
  atlasImageModes,
  atlasScalarParams,
  atlasVendors,
  getAtlasModel,
  isAtlasImageMode,
  isAtlasModelId,
  matchesAtlasQuery,
  type AtlasCatalogRow,
  type AtlasImageMode,
} from "@/lib/atlas-models";
import { AtlasModelBadges } from "@/components/api/atlas-params";
import { cn } from "@/lib/utils";

/**
 * Stars or unstars a model, with a toast either way.
 *
 * Module scope because the React Compiler cannot lower a conditional inside a
 * `try`, and gives up on the whole picker — dialog, rail and list — when it
 * meets one.
 */
async function toggleStar(
  toggle: (args: { modelId: string }) => Promise<boolean>,
  row: AtlasCatalogRow,
): Promise<void> {
  let added: boolean;
  try {
    added = await toggle({ modelId: row.model.id });
  } catch (error) {
    toast.error(error instanceof Error ? error.message : "Could not update your starred models");
    return;
  }
  toast.success(added ? `Starred ${row.label}` : `Unstarred ${row.label}`);
}

/** The image picker's tab, kept across openings and reloads. */
const IMAGE_MODE_STORAGE_KEY = "artsnack_atlas_image_mode";

function readImageMode(): AtlasImageMode | null {
  try {
    const stored = localStorage.getItem(IMAGE_MODE_STORAGE_KEY);
    return isAtlasImageMode(stored) ? stored : null;
  } catch {
    return null;
  }
}

function storeImageMode(mode: AtlasImageMode | null): void {
  try {
    if (mode) localStorage.setItem(IMAGE_MODE_STORAGE_KEY, mode);
    else localStorage.removeItem(IMAGE_MODE_STORAGE_KEY);
  } catch {
    // Not remembered; the tab still applies until the page reloads.
  }
}

const ALL_IMAGE_MODES = { id: null, label: "All", noun: "model", hint: "Every image model" };

/**
 * Picks one of Atlas's models.
 *
 * Three things this got wrong before, all of them the same mistake — showing
 * the catalogue the way the vendor's URL space is shaped rather than the way
 * models are actually chosen.
 *
 * It listed *endpoints*. Searching "seedance 1." returned four rows that were
 * two models, each shown once per input shape, and since the form now routes
 * between those shapes on its own, choosing between them was a decision with no
 * consequence. Rows are one model now, with the shapes it offers as a caption.
 *
 * It was a single narrow column, so a name long enough to matter — every name —
 * was truncated to "Seedance v1.5 Pro Image-to-Vid…". It is a wide dialogue
 * with a vendor rail now: 109 video models split across a dozen vendors is a
 * list you scan, and one flat scroll of 264 was a list you gave up on.
 *
 * Starring still works the way it did, because that part was right: the models
 * you actually use belong beside the picker, not inside it.
 */
export function AtlasModelPicker({
  media,
  value,
  onChange,
  disabled,
}: {
  media: "image" | "video";
  value: string;
  onChange: (id: string) => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = React.useState(false);
  const [query, setQuery] = React.useState("");
  const [vendor, setVendor] = React.useState<string | null>(null);
  /** Image models only: what the model starts from, or null for all of them. */
  const [mode, setMode] = React.useState<AtlasImageMode | null>(null);

  const favoriteIds = useQuery(api.atlasFavorites.list);
  const toggleFavorite = useMutation(api.atlasFavorites.toggle);
  const favorites = React.useMemo(() => new Set(favoriteIds ?? []), [favoriteIds]);

  const selected = React.useMemo(
    () => (isAtlasModelId(value) ? getAtlasModel(value) : null),
    [value],
  );

  const rows = React.useMemo(() => atlasCatalogRows(media), [media]);
  const vendors = React.useMemo(() => atlasVendors(media), [media]);
  const rowModes = React.useMemo(
    () => new Map(rows.map((row) => [row.key, atlasImageModes(row)])),
    [rows],
  );
  const showsModes = media === "image";

  /** A row counts as starred when any of its endpoints is. */
  const isStarred = React.useCallback(
    (row: AtlasCatalogRow) => favorites.has(row.model.id) || favorites.has(row.key),
    [favorites],
  );

  const inMode = React.useCallback(
    (row: AtlasCatalogRow, wanted: AtlasImageMode | null) =>
      wanted === null || (rowModes.get(row.key) ?? []).includes(wanted),
    [rowModes],
  );

  // Everything but the tab, so each tab can say how many it would show.
  const beforeMode = React.useMemo(
    () =>
      rows
        .filter((row) => vendor === null || row.vendor === vendor)
        .filter((row) => matchesAtlasQuery(row, query)),
    [rows, vendor, query],
  );
  const visible = React.useMemo(
    () => beforeMode.filter((row) => inMode(row, mode)),
    [beforeMode, inMode, mode],
  );
  const modeCounts = React.useMemo(() => {
    const counts = new Map<AtlasImageMode | null, number>([[null, beforeMode.length]]);
    for (const row of beforeMode) {
      for (const entry of rowModes.get(row.key) ?? []) {
        counts.set(entry, (counts.get(entry) ?? 0) + 1);
      }
    }
    return counts;
  }, [beforeMode, rowModes]);

  // The rail counts what the tab holds, in the catalogue's own vendor order so
  // switching tabs does not reshuffle it.
  const inModeRows = React.useMemo(
    () => rows.filter((row) => inMode(row, mode)),
    [rows, inMode, mode],
  );
  const vendorCounts = React.useMemo(() => {
    const counts = new Map<string, number>();
    for (const row of inModeRows) counts.set(row.vendor, (counts.get(row.vendor) ?? 0) + 1);
    return counts;
  }, [inModeRows]);

  // Starred float to the top of whatever is on screen, rather than into a group
  // of their own — a group would have shown the same model twice.
  const ordered = React.useMemo(
    () => [...visible.filter(isStarred), ...visible.filter((row) => !isStarred(row))],
    [visible, isStarred],
  );

  const starredCount = rows.filter(isStarred).length;

  const select = (row: AtlasCatalogRow) => {
    onChange(row.model.id);
    setOpen(false);
  };

  /**
   * Opens on the tab used last, unless the model in use is not on it: a
   * picker whose own selection is hidden reads as a lost setting.
   */
  const openPicker = () => {
    const remembered = showsModes ? readImageMode() : null;
    const current = rows.find((row) => row.model.id === value || row.key === value);
    setMode(remembered && current && !inMode(current, remembered) ? null : remembered);
    setOpen(true);
  };

  const chooseMode = (next: AtlasImageMode | null) => {
    setMode(next);
    storeImageMode(next);
    // A vendor with nothing on the new tab would leave an empty list.
    if (vendor !== null && !rows.some((row) => row.vendor === vendor && inMode(row, next))) {
      setVendor(null);
    }
  };

  const star = (row: AtlasCatalogRow) => toggleStar(toggleFavorite, row);

  return (
    <div className="space-y-1.5">
      {/* One line, not two. The slug used to sit on a second line under the
          label; it is the same string the label is derived from, so it earns a
          tooltip rather than 16px on every render. */}
      <Button
        variant="outline"
        className="h-8 w-full justify-between gap-2 px-2"
        disabled={disabled}
        title={value}
        onClick={openPicker}
      >
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="truncate text-xs font-medium">{selected?.label ?? value}</span>
        </span>
        <span className="flex shrink-0 items-center gap-1.5">
          {selected && <AtlasModelBadges model={selected} />}
          <ChevronDown className="h-3.5 w-3.5 shrink-0 opacity-60" />
        </span>
      </Button>

      <FavoriteChips
        rows={rows.filter(isStarred)}
        value={value}
        onSelect={onChange}
        disabled={disabled}
      />

      <Dialog open={open} onOpenChange={setOpen}>
        {/*
          `max-w-none` on both breakpoints because the base DialogContent ships
          `sm:max-w-sm`, and a responsive utility is not overridden by a plain
          one — the two land in different cascade layers and the media query
          wins. The width is then set outright.
        */}
        <DialogContent className="w-[min(96vw,76rem)] max-w-none sm:max-w-none gap-0 overflow-hidden p-0">
          <DialogHeader className="px-5 pt-5 pb-3">
            <DialogTitle>{media === "video" ? "Video" : "Image"} models on Atlas Cloud</DialogTitle>
          </DialogHeader>

          <div className="flex items-center gap-2 px-5 pb-3">
            <div className="relative flex-1">
              <Search className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search by name, vendor or slug…"
                className="pl-8"
              />
            </div>
          </div>

          {showsModes && (
            <div className="px-5 pb-3">
              <div
                role="group"
                aria-label="What the model starts from"
                // Two by two on a phone rather than three and a lonely fourth.
                className="grid grid-cols-2 gap-0.5 rounded-md border bg-card p-0.5 sm:flex sm:items-center"
              >
                {[ALL_IMAGE_MODES, ...ATLAS_IMAGE_MODES].map((entry) => {
                  const active = mode === entry.id;
                  return (
                    <Button
                      key={entry.id ?? "all"}
                      variant={active ? "default" : "ghost"}
                      size="sm"
                      className="h-7 flex-1 gap-1.5 px-2 text-xs font-normal"
                      aria-pressed={active}
                      title={entry.hint}
                      onClick={() => chooseMode(entry.id)}
                    >
                      {entry.label}
                      <span
                        className={cn(
                          "tabular-nums",
                          active ? "opacity-70" : "text-muted-foreground",
                        )}
                      >
                        {modeCounts.get(entry.id) ?? 0}
                      </span>
                    </Button>
                  );
                })}
              </div>
            </div>
          )}

          {/*
            `min-w-0` all the way down the flex chain. Without it a flex child
            defaults to `min-width: auto`, so the unbreakable `font-mono` slugs
            — `openai/gpt-image-2-developer-text-to-image` and friends — set the
            column's minimum width, the dialogue grows past the width declared
            above, and being centre-translated it then clips off *both* edges.
            The `truncate` on the slug cannot fire until its ancestors are
            allowed to shrink.
          */}
          <div className="flex h-[62vh] min-w-0 border-t">
            <nav
              aria-label="Vendor"
              className="w-36 shrink-0 overflow-y-auto border-r bg-muted/20 py-2 sm:w-52"
            >
              <RailButton
                label="All models"
                count={inModeRows.length}
                active={vendor === null}
                onClick={() => setVendor(null)}
              />
              {starredCount > 0 && (
                <p className="px-3 pt-3 pb-1 text-[11px] font-medium text-muted-foreground">
                  {starredCount} starred, shown first
                </p>
              )}
              <div className="mt-1 border-t pt-1">
                {vendors
                  .filter((entry) => vendorCounts.has(entry.name) || vendor === entry.name)
                  .map((entry) => (
                    <RailButton
                      key={entry.name}
                      label={entry.name}
                      count={vendorCounts.get(entry.name) ?? 0}
                      active={vendor === entry.name}
                      onClick={() => setVendor(entry.name)}
                    />
                  ))}
              </div>
            </nav>

            <div className="min-w-0 flex-1 overflow-y-auto p-2">
              {ordered.length === 0 ? (
                <p className="py-12 text-center text-sm text-muted-foreground">
                  Nothing matches{query ? ` “${query}”` : " these filters"}.
                </p>
              ) : (
                <div className="space-y-0.5">
                  {ordered.map((row) => (
                    <ModelRow
                      key={row.key}
                      row={row}
                      selected={row.model.id === value || row.key === value}
                      starred={isStarred(row)}
                      onSelect={() => select(row)}
                      onStar={() => void star(row)}
                    />
                  ))}
                </div>
              )}
            </div>
          </div>

          <p className="min-w-0 border-t px-5 py-2.5 text-xs text-balance text-muted-foreground">
            {showsModes ? (
              <ImageFooter count={ordered.length} mode={mode} />
            ) : (
              <>
                {ordered.length} model{ordered.length === 1 ? "" : "s"}. Prices are per second.
                Which input shape runs — text, first frame, or a reference list — follows what you
                attach.
              </>
            )}
          </p>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/**
 * "64 text-to-image models. Models that draw from the prompt alone…" — what
 * the tab holds, since a model can be on two of them.
 */
function ImageFooter({ count, mode }: { count: number; mode: AtlasImageMode | null }) {
  const entry = ATLAS_IMAGE_MODES.find((candidate) => candidate.id === mode) ?? ALL_IMAGE_MODES;
  return (
    <>
      {count} {entry.noun}
      {count === 1 ? "" : "s"}.{mode ? ` ${entry.hint}.` : ""} Prices are per image.
    </>
  );
}

function RailButton({
  label,
  count,
  active,
  onClick,
}: {
  label: string;
  count: number;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        "flex w-full items-center justify-between gap-2 px-3 py-1.5 text-left text-sm hover:bg-accent",
        active && "bg-accent font-medium",
      )}
    >
      <span className="min-w-0 truncate">{label}</span>
      <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{count}</span>
    </button>
  );
}

/** What the shapes mean, in the order the routing prefers them. */
const VARIANT_LABELS: Record<string, string> = {
  text: "text",
  image: "image input",
  reference: "references",
};

function ModelRow({
  row,
  selected,
  starred,
  onSelect,
  onStar,
}: {
  row: AtlasCatalogRow;
  selected: boolean;
  starred: boolean;
  onSelect: () => void;
  onStar: () => void;
}) {
  const references = atlasFamilyMaxReferences(row.model);
  const sourceTypes = [
    ...new Set(
      atlasScalarParams(row.model).flatMap((param) => {
        if (param.name === "video_clips") return ["video"];
        return (param.kind === "url" || param.kind === "url-list") &&
          (param.role === "video" || param.role === "audio")
          ? [param.role]
          : [];
      }),
    ),
  ];
  const inputLabel =
    references > 0
      ? `${references} image ref${references === 1 ? "" : "s"}`
      : sourceTypes.length
        ? `${sourceTypes.join(" + ")} input`
        : "text";
  return (
    <div
      className={cn("flex items-center gap-1 rounded-md hover:bg-accent", selected && "bg-accent")}
    >
      <button
        type="button"
        onClick={onSelect}
        className="flex min-w-0 flex-1 items-center gap-3 px-2 py-2 text-left"
      >
        <Check className={cn("h-4 w-4 shrink-0", selected ? "opacity-100" : "opacity-0")} />
        <span className="min-w-0 flex-1">
          <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
            {/* Wraps rather than truncates. The complaint that started this
                was not being able to read the names, and an ellipsis in the
                middle of "Seedance v1.5 Pro Image-to-Vid…" is the same failure
                in a wider box. */}
            <span className="text-sm font-medium break-words">{row.label}</span>
            {row.variants.length > 1 && (
              <span className="text-[11px] text-muted-foreground">
                {row.variants.map((variant) => VARIANT_LABELS[variant]).join(" · ")}
              </span>
            )}
          </span>
          <span className="mt-0.5 block truncate font-mono text-[11px] text-muted-foreground">
            {row.key}
          </span>
        </span>
        <span className="shrink-0 text-right text-xs">
          <span className="block tabular-nums">
            {row.basePrice === null
              ? "—"
              : `${row.model.media === "video" ? "from " : ""}$${row.basePrice}`}
            {row.basePrice !== null && row.model.media === "video" && (
              <span className="text-muted-foreground">/s</span>
            )}
          </span>
          <span className="block text-[10px] text-muted-foreground">{inputLabel}</span>
        </span>
      </button>
      {/* Its own button, outside the row's, so starring never doubles as
          selecting — the two are different intentions and the dialogue closes
          on one of them. */}
      <button
        type="button"
        onClick={onStar}
        aria-pressed={starred}
        aria-label={starred ? `Unstar ${row.label}` : `Star ${row.label}`}
        title={starred ? "Unstar" : "Star for one-click access"}
        className="shrink-0 rounded p-2 text-muted-foreground hover:text-amber-500"
      >
        <Star className={cn("h-4 w-4", starred && "fill-amber-500 text-amber-500")} />
      </button>
    </div>
  );
}

/**
 * One-click access to the models this user actually uses.
 *
 * Nothing is drawn when nothing is starred. The line of instruction that used
 * to stand in for the chips is now redundant: the dialogue says the same thing
 * beside its own vendor rail ("N starred, shown first"), and the star column is
 * no longer easy to miss now that rows are one model on a wide row rather than
 * one endpoint in a narrow scroll.
 */
function FavoriteChips({
  rows,
  value,
  onSelect,
  disabled,
}: {
  rows: AtlasCatalogRow[];
  value: string;
  onSelect: (id: string) => void;
  disabled?: boolean;
}) {
  if (rows.length === 0) return null;

  return (
    <div role="group" aria-label="Starred models" className="flex flex-wrap gap-1.5">
      {rows.map((row) => {
        const active = row.model.id === value || row.key === value;
        return (
          <Button
            key={row.key}
            variant={active ? "default" : "outline"}
            size="sm"
            disabled={disabled}
            aria-pressed={active}
            className="h-6 max-w-[14rem] px-2 text-[11px] font-normal"
            title={row.model.id}
            onClick={() => onSelect(row.model.id)}
          >
            <Star
              className={cn(
                "mr-1 h-3 w-3 shrink-0",
                active ? "fill-current" : "fill-amber-500 text-amber-500",
              )}
            />
            <span className="truncate">{row.label}</span>
            {row.basePrice !== null && (
              <span className="ml-1.5 shrink-0 tabular-nums opacity-70">
                {row.model.media === "video" ? "from " : ""}${row.basePrice}
              </span>
            )}
          </Button>
        );
      })}
    </div>
  );
}
