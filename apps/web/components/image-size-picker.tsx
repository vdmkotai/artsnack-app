"use client";

import { useId, useState } from "react";
import { LockKeyhole, LockKeyholeOpen, RectangleHorizontal, RectangleVertical } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Slider } from "@/components/ui/slider";
import { cn } from "@/lib/utils";
import {
  IMAGE_SIZE_PRESETS,
  matchingSizePreset,
  presetSizes,
  resizeLocked,
  snapDimension,
  type ImageSize,
} from "@/lib/image-size";

function DimensionInput({
  axis,
  value,
  onCommit,
}: {
  axis: "Width" | "Height";
  value: number;
  onCommit: (value: number) => void;
}) {
  const [draft, setDraft] = useState(String(value));
  const id = useId();
  function commit() {
    const next =
      draft.trim() && Number.isFinite(Number(draft)) ? snapDimension(Number(draft)) : value;
    setDraft(String(next));
    onCommit(next);
  }
  return (
    <div className="min-w-0 flex-1 space-y-1.5">
      <label htmlFor={id} className="text-xs text-muted-foreground">
        {axis}
      </label>
      <Input
        id={id}
        type="number"
        min={512}
        max={2048}
        step={8}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            e.currentTarget.blur();
          }
        }}
        className="font-mono text-sm"
      />
    </div>
  );
}

export function ImageSizePicker({
  width,
  height,
  onChange,
}: ImageSize & { onChange: (size: ImageSize) => void }) {
  const [locked, setLocked] = useState(true);
  const [squarePortrait, setSquarePortrait] = useState(false);
  const id = useId();
  const size = { width, height };
  const portrait = width === height ? squarePortrait : height > width;
  const preset = matchingSizePreset(size);
  const ratio = width / height;
  const sizes = preset
    ? presetSizes(preset.x, preset.y, portrait)
    : Array.from({ length: 193 }, (_, i) =>
        resizeLocked(size, width >= height ? "width" : "height", 512 + i * 8),
      ).filter(
        (s, i, all) => i === 0 || s.width !== all[i - 1].width || s.height !== all[i - 1].height,
      );
  const index = sizes.reduce(
    (best, s, i) =>
      Math.abs(s.width - width) + Math.abs(s.height - height) <
      Math.abs(sizes[best].width - width) + Math.abs(sizes[best].height - height)
        ? i
        : best,
    0,
  );
  const scale = Math.sqrt((width * height) / (preset ? preset.width * preset.height : 1024 * 1024));
  function orient(next: boolean) {
    setSquarePortrait(next);
    if (width !== height && next !== portrait) onChange({ width: height, height: width });
  }
  function edit(axis: keyof ImageSize, value: number) {
    onChange(locked ? resizeLocked(size, axis, value) : { ...size, [axis]: value });
  }
  return (
    <section aria-labelledby={id} className="space-y-4 rounded-xl border bg-muted/15 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 id={id} className="text-sm font-medium">
          Image size
        </h3>
        <output aria-live="polite" className="font-mono text-xs tabular-nums">
          {width} × {height} px
        </output>
      </div>
      <div role="group" aria-label="Aspect ratio" className="grid grid-cols-3 gap-2 sm:grid-cols-5">
        {IMAGE_SIZE_PRESETS.map((p) => {
          const x = portrait ? p.y : p.x,
            y = portrait ? p.x : p.y;
          const label = p.id === "panorama" ? (portrait ? "9:21" : "21:9") : `${x}:${y}`;
          return (
            <button
              key={p.id}
              type="button"
              aria-label={`${p.label} ${label}`}
              aria-pressed={preset?.id === p.id}
              onClick={() =>
                onChange({
                  width: portrait ? p.height : p.width,
                  height: portrait ? p.width : p.height,
                })
              }
              className={cn(
                "flex min-h-24 flex-col items-center justify-center gap-1.5 rounded-lg border px-2 py-3 text-xs transition-colors focus-visible:outline-2 focus-visible:outline-ring",
                preset?.id === p.id
                  ? "border-primary bg-primary/10 text-primary"
                  : "border-border hover:bg-muted",
              )}
            >
              <span aria-hidden="true" className="flex h-9 w-12 items-center justify-center">
                <span
                  className="rounded-[2px] border-2 border-current bg-current/10"
                  style={{
                    width: `${Math.min(44, (32 * x) / y)}px`,
                    height: `${Math.min(32, (44 * y) / x)}px`,
                  }}
                />
              </span>
              <span className="font-medium">{label}</span>
              <span className="text-muted-foreground">{p.label}</span>
            </button>
          );
        })}
      </div>
      <div role="group" aria-label="Orientation" className="flex flex-wrap gap-2">
        <Button
          type="button"
          size="sm"
          variant={!portrait ? "secondary" : "ghost"}
          aria-pressed={!portrait}
          onClick={() => orient(false)}
        >
          <RectangleHorizontal className="size-4" />
          Landscape
        </Button>
        <Button
          type="button"
          size="sm"
          variant={portrait ? "secondary" : "ghost"}
          aria-pressed={portrait}
          onClick={() => orient(true)}
        >
          <RectangleVertical className="size-4" />
          Portrait
        </Button>
        {!preset && <span className="self-center text-xs text-muted-foreground">Custom ratio</span>}
      </div>
      <div className="space-y-3">
        <div className="flex items-center justify-between text-xs">
          <span id={`${id}-scale`}>Size</span>
          <span className="text-muted-foreground">
            {scale.toFixed(2)}× · {((width * height) / 1e6).toFixed(2)} MP
          </span>
        </div>
        <Slider
          aria-labelledby={`${id}-scale`}
          value={[index]}
          min={0}
          max={Math.max(1, sizes.length - 1)}
          step={1}
          disabled={sizes.length < 2}
          onValueChange={(value) => onChange(sizes[Array.isArray(value) ? value[0] : value])}
        />
        <div className="flex justify-between text-xs text-muted-foreground">
          <span>Smaller</span>
          <span>Larger</span>
        </div>
        <p className="text-xs leading-relaxed text-muted-foreground">
          Scale changes in 0.05× steps for preset ratios. Dimensions are rounded to the nearest 8
          pixels, so proportions may vary slightly. Larger images use more VRAM and take longer to
          generate. This sets the generation size, not an upscale.
        </p>
      </div>
      <details className="border-t pt-3">
        <summary className="cursor-pointer text-xs font-medium">Custom size</summary>
        <div className="mt-3 flex items-end gap-2">
          <DimensionInput
            key={`w-${width}-${height}`}
            axis="Width"
            value={width}
            onCommit={(v) => edit("width", v)}
          />
          <Button
            type="button"
            variant="outline"
            size="icon"
            aria-label={locked ? "Unlock aspect ratio" : "Lock aspect ratio"}
            aria-pressed={locked}
            onClick={() => setLocked(!locked)}
          >
            {locked ? <LockKeyhole className="size-4" /> : <LockKeyholeOpen className="size-4" />}
          </Button>
          <DimensionInput
            key={`h-${width}-${height}`}
            axis="Height"
            value={height}
            onCommit={(v) => edit("height", v)}
          />
          <span
            aria-hidden="true"
            className="mb-2 hidden h-8 w-10 items-center justify-center sm:flex"
          >
            <span
              className="rounded-sm border border-primary bg-primary/10"
              style={{
                width: `${Math.min(40, 32 * ratio)}px`,
                height: `${Math.min(32, 40 / ratio)}px`,
              }}
            />
          </span>
        </div>
        <p className="mt-2 text-xs text-muted-foreground">
          512–2048 px per side, in steps of 8.{" "}
          {locked
            ? "Linked dimensions are rounded to the nearest valid size."
            : "Dimensions can be changed independently."}
        </p>
      </details>
    </section>
  );
}
