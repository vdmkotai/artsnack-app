"use client";

import { AspectRatioOptions } from "@/components/api/aspect-ratio-options";
import type { SizeGroup } from "@/lib/atlas-dimension-options";
import type { AtlasParamValue } from "@/lib/atlas-models";

export { dimensionOptionGroups, type SizeOptions } from "@/lib/atlas-dimension-options";

export function DimensionOptions({
  groups,
  specials = [],
  value,
  label,
  disabled,
  onChange,
}: {
  groups: SizeGroup[];
  specials?: readonly string[];
  value: AtlasParamValue;
  label: string;
  disabled?: boolean;
  onChange: (value: AtlasParamValue) => void;
}) {
  const special = typeof value === "string" && specials.includes(value) ? value : null;
  const selectedGroup =
    groups.find((group) => group.options.some((option) => option.value === value)) ?? groups[0];
  const selected =
    selectedGroup.options.find((option) => option.value === value) ?? selectedGroup.options[0];
  const approximate = Math.abs(selected.width / selected.height - selectedGroup.aspect) > 0.001;
  const orientation =
    selected.width === selected.height
      ? "Square"
      : selected.width > selected.height
        ? "Landscape"
        : "Portrait";

  return (
    <div className="min-w-0 space-y-2">
      <AspectRatioOptions
        label={`${label} aspect ratio`}
        value={special ?? selectedGroup.ratio}
        options={[
          ...specials.map((word) => ({
            value: word,
            label: word.charAt(0).toUpperCase() + word.slice(1),
            aspect: null,
          })),
          ...groups.map((group) => ({
            value: group.ratio,
            label: group.ratio,
            aspect: group.aspect,
          })),
        ]}
        disabled={disabled}
        onChange={(ratio) => {
          if (specials.includes(ratio)) {
            onChange(ratio);
            return;
          }
          const group = groups.find((candidate) => candidate.ratio === ratio)!;
          // From a word there is no current size to keep, so aim for 1MP.
          const area = special ? 1024 * 1024 : selected.width * selected.height;
          const nearest = group.options.reduce((best, option) =>
            Math.abs(Math.log((option.width * option.height) / area)) <
            Math.abs(Math.log((best.width * best.height) / area))
              ? option
              : best,
          );
          onChange(nearest.value);
        }}
      />
      {special ? (
        <p className="text-xs text-muted-foreground">The model picks the size from the prompt.</p>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <select
            aria-label={`${label} resolution`}
            value={selected.value}
            disabled={disabled}
            onChange={(event) => onChange(event.target.value)}
            className="h-8 min-w-0 max-w-full rounded-md border bg-card px-2 text-xs disabled:opacity-50"
          >
            {selectedGroup.options.map((option) => (
              <option key={option.value} value={option.value}>
                {option.width} × {option.height} ·{" "}
                {((option.width * option.height) / 1_000_000).toFixed(1)} MP
              </option>
            ))}
          </select>
          <span className="text-xs text-muted-foreground">
            {orientation} · {approximate ? "≈ " : ""}
            {selectedGroup.ratio}
          </span>
        </div>
      )}
    </div>
  );
}
