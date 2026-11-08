"use client";

import * as React from "react";
import { useMutation } from "convex/react";
import { toast } from "sonner";
import {
  Check,
  Folder,
  FolderInput,
  FolderOpen,
  Loader2,
  Pencil,
  Plus,
  Trash2,
  X,
} from "lucide-react";

import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
// The labels live in packages/shared/favorite-labels.ts so the phone renders
// the same words; import them from "@/lib/favorite-labels" rather than here.
import { FAVORITE_PROVIDER_LABELS, shortCheckpointName } from "@/lib/favorite-labels";

export type FolderSummary = {
  _id: Id<"favoriteFolders">;
  name: string;
  createdAt: number;
  count: number;
};

function chipClass(active: boolean): string {
  return cn(
    "inline-flex max-w-56 items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs transition-colors",
    active
      ? "border-primary bg-primary text-primary-foreground"
      : "border-border bg-muted/40 hover:bg-muted",
  );
}

/**
 * One-line popover form shared by "New folder" and "Rename": an input, Enter or
 * the check to commit.
 */
function FolderNameForm({
  initial = "",
  placeholder,
  busy,
  onSubmit,
}: {
  initial?: string;
  placeholder: string;
  busy: boolean;
  onSubmit: (name: string) => void;
}) {
  const [name, setName] = React.useState(initial);
  const commit = () => {
    if (name.trim()) onSubmit(name);
  };
  return (
    <div className="flex items-center gap-1.5">
      <Input
        value={name}
        placeholder={placeholder}
        maxLength={60}
        onChange={(event) => setName(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            commit();
          }
        }}
      />
      <Button
        size="icon"
        aria-label="Save folder name"
        disabled={busy || !name.trim()}
        onClick={commit}
      >
        {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
      </Button>
    </div>
  );
}

/**
 * The folder rail on /favorites: All · Unfiled · one chip per folder · New.
 *
 * `selected` speaks the same dialect the Convex queries do — undefined for
 * everything, "none" for the unfiled pool, a folder id otherwise — so the page
 * can pass it straight through to listFavorites.
 */
export function FavoriteFolderBar({
  selected,
  onSelect,
  folders,
  unfiled,
  total,
  editable = true,
}: {
  selected: string | undefined;
  onSelect: (value: string | undefined) => void;
  folders: FolderSummary[];
  unfiled: number;
  total: number;
  /**
   * False while `folders` may be a remembered copy (convex-cache) rather than
   * the live list: Rename would open on a name that may have changed elsewhere
   * and save it back over that change, so it and Delete wait for live data.
   */
  editable?: boolean;
}) {
  const createFolder = useMutation(api.favoriteFolders.create);
  const renameFolder = useMutation(api.favoriteFolders.rename);
  const removeFolder = useMutation(api.favoriteFolders.remove);
  const [createOpen, setCreateOpen] = React.useState(false);
  const [renameOpen, setRenameOpen] = React.useState(false);
  const [busy, setBusy] = React.useState(false);

  const activeFolder = folders.find((folder) => folder._id === selected);

  // Promise chains rather than try/finally, which the React Compiler cannot
  // compile — and this bar re-renders with every facet update.
  const handleCreate = (name: string) => {
    setBusy(true);
    void createFolder({ name })
      .then(({ folderId }) => {
        setCreateOpen(false);
        onSelect(folderId);
      })
      .catch((error: unknown) =>
        toast.error(error instanceof Error ? error.message : "Could not create the folder"),
      )
      .finally(() => setBusy(false));
  };

  const handleRename = (name: string) => {
    if (!activeFolder) return;
    setBusy(true);
    void renameFolder({ folderId: activeFolder._id, name })
      .then(() => setRenameOpen(false))
      .catch((error: unknown) =>
        toast.error(error instanceof Error ? error.message : "Could not rename the folder"),
      )
      .finally(() => setBusy(false));
  };

  const handleDelete = () => {
    if (!activeFolder) return;
    if (
      !window.confirm(
        `Delete "${activeFolder.name}"? Its ${activeFolder.count} favorite${
          activeFolder.count === 1 ? "" : "s"
        } will go back to the main list.`,
      )
    ) {
      return;
    }
    setBusy(true);
    void removeFolder({ folderId: activeFolder._id })
      .then(() => onSelect(undefined))
      .catch((error: unknown) =>
        toast.error(error instanceof Error ? error.message : "Could not delete the folder"),
      )
      .finally(() => setBusy(false));
  };

  return (
    <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="Folders">
      <button
        type="button"
        className={chipClass(selected === undefined)}
        onClick={() => onSelect(undefined)}
      >
        All
        <span className="opacity-60">{total}</span>
      </button>
      {/* Unfiled earns a chip only once filing has started: with no folders the
          two views are the same list under two names. */}
      {folders.length > 0 && (
        <button
          type="button"
          className={chipClass(selected === "none")}
          onClick={() => onSelect("none")}
        >
          Unfiled
          <span className="opacity-60">{unfiled}</span>
        </button>
      )}
      {folders.map((folder) => {
        const active = selected === folder._id;
        return (
          <button
            key={folder._id}
            type="button"
            className={chipClass(active)}
            onClick={() => onSelect(folder._id)}
          >
            {active ? <FolderOpen className="h-3.5 w-3.5" /> : <Folder className="h-3.5 w-3.5" />}
            <span className="truncate">{folder.name}</span>
            <span className="opacity-60">{folder.count}</span>
          </button>
        );
      })}

      <Popover open={createOpen} onOpenChange={setCreateOpen}>
        <PopoverTrigger
          render={
            <button
              type="button"
              aria-label="New folder"
              className="inline-flex items-center gap-1.5 rounded-full border border-dashed border-border px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            />
          }
        >
          <Plus className="h-3.5 w-3.5" />
          New folder
        </PopoverTrigger>
        <PopoverContent align="start" className="w-64">
          <FolderNameForm placeholder="Folder name" busy={busy} onSubmit={handleCreate} />
        </PopoverContent>
      </Popover>

      {activeFolder && (
        <span className="ml-1 inline-flex items-center gap-0.5">
          <Popover open={renameOpen} onOpenChange={setRenameOpen}>
            <PopoverTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7 text-muted-foreground"
                  aria-label={`Rename folder ${activeFolder.name}`}
                  title="Rename folder"
                  disabled={!editable}
                />
              }
            >
              <Pencil className="h-3.5 w-3.5" />
            </PopoverTrigger>
            <PopoverContent align="start" className="w-64">
              <FolderNameForm
                // Keyed by the name too: a rename that lands from elsewhere
                // while the editor is open restarts it on the new name instead
                // of letting Save write the old one back.
                key={`${activeFolder._id}:${activeFolder.name}`}
                initial={activeFolder.name}
                placeholder="Folder name"
                busy={busy}
                onSubmit={handleRename}
              />
            </PopoverContent>
          </Popover>
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7 text-muted-foreground hover:text-destructive"
            aria-label={`Delete folder ${activeFolder.name}`}
            title="Delete folder (favorites are kept)"
            disabled={busy || !editable}
            onClick={handleDelete}
          >
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        </span>
      )}
    </div>
  );
}

export type FavoriteFacets = {
  total: number;
  mediaTypes: { image: number; video: number };
  providers: Array<{ value: string; count: number }>;
  checkpoints: Array<{ value: string; count: number }>;
};

/**
 * The filter rail: media type, provider chips (facet-driven, so only sources
 * that actually occur are offered) and a checkpoint picker for self-hosted rows.
 */
export function FavoriteFilterBar({
  mediaType,
  onMediaType,
  providers,
  onProviders,
  checkpoints,
  onCheckpoints,
  onClear,
  facets,
}: {
  mediaType: "image" | "video" | undefined;
  onMediaType: (value: "image" | "video" | undefined) => void;
  providers: string[];
  onProviders: (values: string[]) => void;
  checkpoints: string[];
  onCheckpoints: (values: string[]) => void;
  /** Clears type, providers and checkpoints in one write; the folder stays. */
  onClear: () => void;
  facets: FavoriteFacets | undefined;
}) {
  const mediaOptions: Array<{
    value: "image" | "video" | undefined;
    label: string;
    count?: number;
  }> = [
    { value: undefined, label: "All", count: facets?.total },
    { value: "image", label: "Images", count: facets?.mediaTypes.image },
    { value: "video", label: "Videos", count: facets?.mediaTypes.video },
  ];

  // Facet-driven, but a selected value survives its count dropping to zero —
  // otherwise the chip that would clear the filter disappears with it.
  const providerOptions = (facets?.providers ?? []).map((entry) => entry.value);
  const providerValues = [...new Set([...providerOptions, ...providers])];

  const checkpointFacets = facets?.checkpoints ?? [];
  const anyFilter = mediaType !== undefined || providers.length > 0 || checkpoints.length > 0;

  const toggleProvider = (value: string) =>
    onProviders(
      providers.includes(value)
        ? providers.filter((entry) => entry !== value)
        : [...providers, value],
    );

  const toggleCheckpoint = (value: string) =>
    onCheckpoints(
      checkpoints.includes(value)
        ? checkpoints.filter((entry) => entry !== value)
        : [...checkpoints, value],
    );

  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
      <div
        role="group"
        aria-label="Media type"
        className="inline-flex items-center gap-1 rounded-lg border bg-card p-1"
      >
        {mediaOptions.map((option) => (
          <Button
            key={option.label}
            variant={mediaType === option.value ? "default" : "ghost"}
            size="sm"
            className="h-7 gap-1.5 px-2.5 text-xs"
            aria-pressed={mediaType === option.value}
            onClick={() => onMediaType(option.value)}
          >
            {option.label}
            {option.count !== undefined && <span className="opacity-60">{option.count}</span>}
          </Button>
        ))}
      </div>

      {providerValues.length > 1 && (
        <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="Source">
          {providerValues.map((value) => {
            const count = facets?.providers.find((entry) => entry.value === value)?.count ?? 0;
            const active = providers.includes(value);
            return (
              <button
                key={value}
                type="button"
                className={chipClass(active)}
                aria-pressed={active}
                onClick={() => toggleProvider(value)}
              >
                {FAVORITE_PROVIDER_LABELS[value] ?? value}
                <span className="opacity-60">{count}</span>
                {active && <X className="h-3 w-3" />}
              </button>
            );
          })}
        </div>
      )}

      {(checkpointFacets.length > 0 || checkpoints.length > 0) && (
        <Popover>
          <PopoverTrigger
            render={
              <Button
                variant={checkpoints.length > 0 ? "secondary" : "outline"}
                size="sm"
                className="h-8 gap-1.5 text-xs"
              />
            }
          >
            Checkpoint
            {checkpoints.length > 0 && (
              <span className="rounded-full bg-primary px-1.5 text-[10px] text-primary-foreground">
                {checkpoints.length}
              </span>
            )}
          </PopoverTrigger>
          <PopoverContent align="start" className="max-h-80 w-80 overflow-y-auto">
            <div className="flex flex-wrap gap-1.5">
              {[
                ...checkpointFacets,
                // Keep selected-but-vanished checkpoints clearable, same rule as
                // the provider chips.
                ...checkpoints
                  .filter((value) => !checkpointFacets.some((entry) => entry.value === value))
                  .map((value) => ({ value, count: 0 })),
              ].map((entry) => {
                const active = checkpoints.includes(entry.value);
                return (
                  <button
                    key={entry.value}
                    type="button"
                    className={chipClass(active)}
                    aria-pressed={active}
                    onClick={() => toggleCheckpoint(entry.value)}
                  >
                    <span className="truncate">{shortCheckpointName(entry.value)}</span>
                    <span className="opacity-60">{entry.count}</span>
                    {active && <X className="h-3 w-3" />}
                  </button>
                );
              })}
            </div>
          </PopoverContent>
        </Popover>
      )}

      {anyFilter && (
        <Button
          variant="ghost"
          size="sm"
          className="h-8 text-xs text-muted-foreground"
          onClick={onClear}
        >
          Clear filters
        </Button>
      )}
    </div>
  );
}

/**
 * The "Move to folder" control in the selection toolbar: pick an existing
 * folder, send back to Unfiled, or type a name to create-and-move in one step.
 */
export function MoveToFolderPopover({
  folders,
  busy,
  onMove,
  onCreateAndMove,
}: {
  folders: FolderSummary[];
  busy: boolean;
  onMove: (folderId: Id<"favoriteFolders"> | undefined) => void;
  onCreateAndMove: (name: string) => void;
}) {
  return (
    <Popover>
      <PopoverTrigger
        render={<Button size="sm" variant="secondary" className="gap-1.5" disabled={busy} />}
      >
        {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <FolderInput className="h-4 w-4" />}
        Move to folder
      </PopoverTrigger>
      <PopoverContent align="center" side="top" className="w-64 gap-2">
        <div className="flex max-h-56 flex-col gap-0.5 overflow-y-auto">
          <Button
            variant="ghost"
            size="sm"
            className="justify-start gap-2 text-xs"
            onClick={() => onMove(undefined)}
          >
            <X className="h-3.5 w-3.5 text-muted-foreground" />
            Remove from folder
          </Button>
          {folders.map((folder) => (
            <Button
              key={folder._id}
              variant="ghost"
              size="sm"
              className="justify-start gap-2 text-xs"
              onClick={() => onMove(folder._id)}
            >
              <Folder className="h-3.5 w-3.5 text-muted-foreground" />
              <span className="truncate">{folder.name}</span>
              <span className="ml-auto text-muted-foreground">{folder.count}</span>
            </Button>
          ))}
        </div>
        <div className="border-t pt-2">
          <FolderNameForm placeholder="New folder…" busy={busy} onSubmit={onCreateAndMove} />
        </div>
      </PopoverContent>
    </Popover>
  );
}
