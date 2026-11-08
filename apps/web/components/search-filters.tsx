"use client";

import { useDeferredValue, useEffect, useState } from "react";
import { Filter, Search, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Drawer,
  DrawerContent,
  DrawerDescription,
  DrawerFooter,
  DrawerHeader,
  DrawerTitle,
} from "@/components/ui/drawer";
import { Input } from "@/components/ui/input";
import {
  countActiveSearchFilters,
  NON_FACET_SEARCH_PARAMETERS,
  type SearchFacetValue,
  type SearchFilters,
  type SearchFacets,
} from "@/lib/search";

export function SearchFiltersButton({
  filters,
  negativePromptQuery,
  facets,
  previewCount,
  onApply,
}: {
  filters: SearchFilters;
  negativePromptQuery: string;
  facets: SearchFacets;
  /** Media the draft would show. Only asked while the drawer is open. */
  previewCount: (filters: SearchFilters, negativePromptQuery: string) => number;
  onApply: (filters: SearchFilters, negativePromptQuery: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(filters);
  const [negative, setNegative] = useState(negativePromptQuery);
  const [side, setSide] = useState(false);

  useEffect(() => {
    const media = window.matchMedia("(min-width: 768px)");
    const update = () => setSide(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  useEffect(() => {
    if (!open) return;
    setDraft(filters);
    setNegative(negativePromptQuery);
  }, [open, filters, negativePromptQuery]);

  const active = countActiveSearchFilters(filters) + (negativePromptQuery ? 1 : 0);
  const clear = () => {
    setDraft({
      mediaTypes: [],
      sources: [],
      providers: [],
      models: [],
      modelFamilies: [],
      checkpoints: [],
      loras: [],
      loraMode: "any",
      orientations: [],
      resolutions: [],
      qualities: [],
      samplers: [],
      schedulers: [],
      parameters: {},
    });
    setNegative("");
  };

  return (
    <>
      <Button variant="outline" size="lg" onClick={() => setOpen(true)}>
        <Filter /> Filters{active > 0 ? ` · ${active}` : ""}
      </Button>
      <Drawer
        open={open}
        onOpenChange={setOpen}
        swipeDirection={side ? "right" : "down"}
        showSwipeHandle={!side}
      >
        <DrawerContent
          className={side ? "[--drawer-content-width:min(34rem,calc(100vw-1rem))]" : ""}
        >
          <DrawerHeader>
            <div className="flex items-center justify-between gap-4">
              <DrawerTitle className="text-base">Search filters</DrawerTitle>
              <Button variant="ghost" size="sm" onClick={clear}>
                Clear all
              </Button>
            </div>
            <DrawerDescription>
              Counts come from your actual history, including retired models, checkpoints and LoRAs.
            </DrawerDescription>
          </DrawerHeader>
          <div className="min-h-0 flex-1 space-y-6 overflow-y-auto p-4">
            <FilterGroup
              title="Media"
              values={facets.mediaTypes}
              selected={draft.mediaTypes}
              onChange={(values) =>
                setDraft({ ...draft, mediaTypes: values as SearchFilters["mediaTypes"] })
              }
            />
            <FilterGroup
              title="Source"
              values={facets.sources}
              selected={draft.sources}
              onChange={(values) =>
                setDraft({ ...draft, sources: values as SearchFilters["sources"] })
              }
            />
            <FilterGroup
              title="Provider"
              values={facets.providers}
              selected={draft.providers}
              onChange={(values) =>
                setDraft({ ...draft, providers: values as SearchFilters["providers"] })
              }
            />
            <FilterGroup
              title="Model family"
              values={facets.modelFamilies}
              selected={draft.modelFamilies}
              searchable
              onChange={(modelFamilies) => setDraft({ ...draft, modelFamilies })}
            />
            <FilterGroup
              title="Exact API model"
              values={facets.models}
              selected={draft.models}
              searchable
              onChange={(models) => setDraft({ ...draft, models })}
            />
            <FilterGroup
              title="Checkpoint"
              values={facets.checkpoints}
              selected={draft.checkpoints}
              searchable
              onChange={(checkpoints) => setDraft({ ...draft, checkpoints })}
            />
            <FilterGroup
              title="LoRA"
              values={facets.loras}
              selected={draft.loras}
              searchable
              onChange={(loras) => setDraft({ ...draft, loras })}
            />
            {draft.loras.length > 1 ? (
              <label className="flex items-center gap-2 text-xs">
                <input
                  type="checkbox"
                  checked={draft.loraMode === "all"}
                  onChange={(event) =>
                    setDraft({ ...draft, loraMode: event.target.checked ? "all" : "any" })
                  }
                />
                Require all selected LoRAs (off means any)
              </label>
            ) : null}

            <details className="rounded-xl border border-border p-3" open>
              <summary className="cursor-pointer font-medium">Advanced</summary>
              <div className="mt-4 space-y-5">
                <label className="block space-y-1">
                  <span className="text-xs font-medium">Search stored negative prompt</span>
                  <Input
                    value={negative}
                    onChange={(event) => setNegative(event.target.value)}
                    placeholder='e.g. blurry, -"bad hands"'
                  />
                  <span className="text-[11px] text-muted-foreground">
                    Separate from the positive prompt. The same query syntax applies.
                  </span>
                </label>
                <FilterGroup
                  title="Orientation"
                  values={[
                    { value: "portrait", count: 0 },
                    { value: "square", count: 0 },
                    { value: "landscape", count: 0 },
                  ]}
                  selected={draft.orientations}
                  onChange={(values) =>
                    setDraft({ ...draft, orientations: values as SearchFilters["orientations"] })
                  }
                  hideCounts
                />
                <FilterGroup
                  title="Resolution"
                  values={facets.resolutions}
                  selected={draft.resolutions}
                  onChange={(resolutions) => setDraft({ ...draft, resolutions })}
                />
                <FilterGroup
                  title="Quality"
                  values={facets.qualities}
                  selected={draft.qualities}
                  onChange={(qualities) => setDraft({ ...draft, qualities })}
                />
                <FilterGroup
                  title="Sampler"
                  values={facets.samplers}
                  selected={draft.samplers}
                  searchable
                  onChange={(samplers) => setDraft({ ...draft, samplers })}
                />
                <FilterGroup
                  title="Scheduler"
                  values={facets.schedulers}
                  selected={draft.schedulers}
                  searchable
                  onChange={(schedulers) => setDraft({ ...draft, schedulers })}
                />
                <div className="grid grid-cols-2 gap-3">
                  <NumberRange
                    label="Steps"
                    min={draft.stepsMin}
                    max={draft.stepsMax}
                    onMin={(stepsMin) => setDraft({ ...draft, stepsMin })}
                    onMax={(stepsMax) => setDraft({ ...draft, stepsMax })}
                  />
                  <NumberRange
                    label="CFG"
                    min={draft.cfgMin}
                    max={draft.cfgMax}
                    onMin={(cfgMin) => setDraft({ ...draft, cfgMin })}
                    onMax={(cfgMax) => setDraft({ ...draft, cfgMax })}
                  />
                  <NumberRange
                    label="Video seconds"
                    min={draft.durationMin}
                    max={draft.durationMax}
                    onMin={(durationMin) => setDraft({ ...draft, durationMin })}
                    onMax={(durationMax) => setDraft({ ...draft, durationMax })}
                  />
                  <label className="space-y-1 text-xs font-medium">
                    Exact seed
                    <Input
                      type="number"
                      value={draft.seed ?? ""}
                      onChange={(event) =>
                        setDraft({ ...draft, seed: optionalNumber(event.target.value) })
                      }
                    />
                  </label>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <NumberRange
                    label="Width"
                    min={draft.widthMin}
                    max={draft.widthMax}
                    onMin={(widthMin) => setDraft({ ...draft, widthMin })}
                    onMax={(widthMax) => setDraft({ ...draft, widthMax })}
                  />
                  <NumberRange
                    label="Height"
                    min={draft.heightMin}
                    max={draft.heightMax}
                    onMin={(heightMin) => setDraft({ ...draft, heightMin })}
                    onMax={(heightMax) => setDraft({ ...draft, heightMax })}
                  />
                </div>
                {Object.entries(facets.parameters)
                  .filter(
                    ([name, values]) =>
                      !NON_FACET_SEARCH_PARAMETERS.has(name) &&
                      values.length > 0 &&
                      values.length <= 40,
                  )
                  .sort(
                    (left, right) =>
                      right[1].reduce((sum, entry) => sum + entry.count, 0) -
                      left[1].reduce((sum, entry) => sum + entry.count, 0),
                  )
                  .slice(0, 20)
                  .map(([name, values]) => (
                    <FilterGroup
                      key={name}
                      title={humanize(name)}
                      values={values}
                      selected={draft.parameters[name] ?? []}
                      searchable={values.length > 10}
                      onChange={(selected) =>
                        setDraft({
                          ...draft,
                          parameters: { ...draft.parameters, [name]: selected },
                        })
                      }
                    />
                  ))}
                <label className="block space-y-1 text-xs font-medium">
                  Generated with references
                  <select
                    className="h-8 w-full rounded-md border border-input bg-background px-2"
                    value={draft.hasReferences === undefined ? "any" : String(draft.hasReferences)}
                    onChange={(event) =>
                      setDraft({
                        ...draft,
                        hasReferences:
                          event.target.value === "any" ? undefined : event.target.value === "true",
                      })
                    }
                  >
                    <option value="any">Any</option>
                    <option value="true">Yes</option>
                    <option value="false">No</option>
                  </select>
                </label>
                <div className="grid grid-cols-2 gap-3">
                  <label className="space-y-1 text-xs font-medium">
                    From
                    <Input
                      type="date"
                      value={dateValue(draft.createdAfter)}
                      onChange={(event) =>
                        setDraft({ ...draft, createdAfter: dateNumber(event.target.value, false) })
                      }
                    />
                  </label>
                  <label className="space-y-1 text-xs font-medium">
                    To
                    <Input
                      type="date"
                      value={dateValue(draft.createdBefore)}
                      onChange={(event) =>
                        setDraft({ ...draft, createdBefore: dateNumber(event.target.value, true) })
                      }
                    />
                  </label>
                </div>
              </div>
            </details>
          </div>
          <DrawerFooter>
            <Button
              size="lg"
              onClick={() => {
                onApply(draft, negative);
                setOpen(false);
              }}
            >
              Show <PreviewCount count={previewCount} filters={draft} negative={negative} /> results
            </Button>
          </DrawerFooter>
        </DrawerContent>
      </Drawer>
    </>
  );
}

/**
 * The draft's result count. Its own component inside the drawer's content, so
 * it is computed only while the drawer is mounted — not on every catalogue
 * change behind a closed drawer — and from deferred inputs, so ticking a chip
 * never waits for the count.
 */
function PreviewCount({
  count,
  filters,
  negative,
}: {
  count: (filters: SearchFilters, negativePromptQuery: string) => number;
  filters: SearchFilters;
  negative: string;
}) {
  const deferredFilters = useDeferredValue(filters);
  const deferredNegative = useDeferredValue(negative);
  return count(deferredFilters, deferredNegative).toLocaleString();
}

function FilterGroup({
  title,
  values,
  selected,
  onChange,
  searchable = false,
  hideCounts = false,
}: {
  title: string;
  values: SearchFacetValue[];
  selected: readonly string[];
  onChange: (values: string[]) => void;
  searchable?: boolean;
  hideCounts?: boolean;
}) {
  const [query, setQuery] = useState("");
  const shown = values
    .filter((entry) => entry.value.toLocaleLowerCase().includes(query.toLocaleLowerCase()))
    .slice(0, query ? 80 : 24);
  const toggle = (value: string) =>
    onChange(
      selected.includes(value) ? selected.filter((entry) => entry !== value) : [...selected, value],
    );
  if (values.length === 0) return null;
  return (
    <section className="space-y-2">
      <div className="flex items-center justify-between">
        <h3 className="text-xs font-semibold">{title}</h3>
        {selected.length > 0 ? (
          <button
            className="text-[11px] text-muted-foreground hover:text-foreground"
            onClick={() => onChange([])}
          >
            Clear
          </button>
        ) : null}
      </div>
      {searchable && values.length > 10 ? (
        <div className="relative">
          <Search className="absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            className="pl-7"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={`Find ${title.toLocaleLowerCase()}…`}
          />
        </div>
      ) : null}
      <div className="flex flex-wrap gap-1.5">
        {shown.map((entry) => (
          <button
            key={entry.value}
            type="button"
            onClick={() => toggle(entry.value)}
            className={`inline-flex max-w-full items-center gap-1 rounded-full border px-2 py-1 text-[11px] transition-colors ${selected.includes(entry.value) ? "border-primary bg-primary text-primary-foreground" : "border-border bg-muted/40 hover:bg-muted"}`}
          >
            <span className="truncate">{entry.value}</span>
            {hideCounts ? null : <span className="opacity-60">{entry.count}</span>}
            {selected.includes(entry.value) ? <X className="h-2.5 w-2.5" /> : null}
          </button>
        ))}
      </div>
    </section>
  );
}

function NumberRange({
  label,
  min,
  max,
  onMin,
  onMax,
}: {
  label: string;
  min?: number;
  max?: number;
  onMin: (value?: number) => void;
  onMax: (value?: number) => void;
}) {
  return (
    <div className="space-y-1">
      <span className="text-xs font-medium">{label}</span>
      <div className="grid grid-cols-2 gap-1">
        <Input
          aria-label={`${label} minimum`}
          type="number"
          placeholder="Min"
          value={min ?? ""}
          onChange={(event) => onMin(optionalNumber(event.target.value))}
        />
        <Input
          aria-label={`${label} maximum`}
          type="number"
          placeholder="Max"
          value={max ?? ""}
          onChange={(event) => onMax(optionalNumber(event.target.value))}
        />
      </div>
    </div>
  );
}

function optionalNumber(value: string): number | undefined {
  const parsed = Number(value);
  return value && Number.isFinite(parsed) ? parsed : undefined;
}
function dateValue(value?: number): string {
  return value ? new Date(value).toISOString().slice(0, 10) : "";
}
function dateNumber(value: string, end: boolean): number | undefined {
  if (!value) return undefined;
  const date = new Date(`${value}T${end ? "23:59:59.999" : "00:00:00"}`);
  return Number.isFinite(date.getTime()) ? date.getTime() : undefined;
}
function humanize(value: string): string {
  return value
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (character) => character.toLocaleUpperCase());
}
