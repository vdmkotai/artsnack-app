"use client";

import { useId } from "react";
import { LockKeyhole, ArrowRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { AtlasParamValue } from "@/lib/atlas-models";
import {
  tencentLongEdge,
  tencentOutputSize,
  tencentSizing,
  type ImageDimensions,
} from "@/lib/tencent-upscale";
import { cn } from "@/lib/utils";

const ENGINES = [
  ["fidelity", "Preserve details", "Photos & products. Prioritize fidelity to the source."],
  ["super", "AI artwork", "Illustrations & generated images."],
  ["ultra", "Enhance details", "Stronger detail enhancement. Inspect fine textures afterward."],
  ["standard", "Quick upscale", "General-purpose enlargement. Fastest processing mode."],
] as const;

export function TencentUpscaleParams({
  params,
  onChange,
  source,
  disabled,
}: {
  params: Record<string, AtlasParamValue>;
  onChange: (name: string, value: AtlasParamValue) => void;
  source?: ImageDimensions;
  disabled?: boolean;
}) {
  const id = useId();
  const sizing = tencentSizing(params);
  const output = tencentOutputSize(params, source);
  const multiplier = sizing.mode === "percent";
  const longEdge =
    sizing.mode === "aspect" && !!sizing.long_side && Object.keys(sizing).length === 2;
  const safe = multiplier || longEdge;
  const scale =
    source && output ? output.width / source.width : multiplier ? Number(sizing.percent) : null;
  const format = String(params.encode_format ?? "JPEG");
  const setLongEdge = (pixels: number) =>
    Object.entries(tencentLongEdge(pixels)).forEach(([key, value]) => onChange(key, value));
  const sizeText = (size: ImageDimensions) =>
    `${size.width.toLocaleString("en-US")} × ${size.height.toLocaleString("en-US")}`;

  return (
    <fieldset disabled={disabled} className="min-w-0 space-y-4 rounded-xl border bg-card p-3">
      <legend className="px-1 text-sm font-medium">Upscale image</legend>
      <div className="space-y-2">
        <p className="text-xs font-medium">Output size</p>
        <div className="grid grid-cols-3 gap-2">
          {[
            ["2K", 2048],
            ["4K", 4096],
            ["5K", 5120],
          ].map(([label, pixels]) => (
            <Button
              key={label}
              type="button"
              variant={longEdge && sizing.long_side === pixels ? "default" : "outline"}
              className="h-auto flex-col gap-0.5 py-2"
              aria-pressed={longEdge && sizing.long_side === pixels}
              aria-label={`${label} · ${pixels} pixels on the longest side`}
              onClick={() => setLongEdge(Number(pixels))}
            >
              <span className="text-sm">{label}</span>
              <span className="text-[10px] opacity-75">{pixels} px · long edge</span>
            </Button>
          ))}
        </div>
        <div className="flex flex-wrap items-end gap-2">
          <label className="min-w-0 flex-1 space-y-1 text-xs" htmlFor={`${id}-method`}>
            <span>Set size by</span>
            <select
              id={`${id}-method`}
              className="h-8 w-full rounded-md border bg-background px-2"
              value={multiplier ? "scale" : longEdge ? "edge" : "legacy"}
              onChange={(event) =>
                event.target.value === "scale" ? onChange("mode", "percent") : setLongEdge(5120)
              }
            >
              {!safe && <option value="legacy">Saved custom dimensions</option>}
              <option value="edge">Longest side · pixels</option>
              <option value="scale">Scale multiplier · ×</option>
            </select>
          </label>
          {safe && (
            <label className="w-28 space-y-1 text-xs" htmlFor={`${id}-size`}>
              <span>{multiplier ? "Enlarge by" : "Longest side"}</span>
              <Input
                id={`${id}-size`}
                type="number"
                min={multiplier ? 1 : 2}
                max={multiplier ? 10 : undefined}
                step={multiplier ? 0.1 : 1}
                value={Number(multiplier ? sizing.percent : sizing.long_side)}
                onChange={(event) => {
                  const value = Number(event.target.value);
                  if (!Number.isFinite(value) || value < (multiplier ? 1 : 2)) return;
                  if (multiplier) onChange("percent", Math.min(10, value));
                  else setLongEdge(Math.round(value));
                }}
              />
            </label>
          )}
        </div>
        {!safe && (
          <p role="alert" className="text-xs text-amber-500">
            {sizing.mode === "fixed"
              ? "Saved settings force dimensions and may stretch the image."
              : "Saved settings use width, height or short edge."}{" "}
            Choose a size above to use a single longest-side target and preserve proportions.
          </p>
        )}
      </div>
      <div className="space-y-2 rounded-lg bg-muted/50 p-3" aria-live="polite">
        <p className="flex items-center gap-1.5 text-xs font-medium">
          <LockKeyhole className="size-3.5" />
          {sizing.mode === "fixed"
            ? "Proportions are not locked in saved settings"
            : "Original proportions · no stretching or cropping"}
        </p>
        {source && output ? (
          <>
            <div className="flex flex-wrap items-center gap-2 font-mono text-sm tabular-nums">
              <span className="text-muted-foreground">{sizeText(source)}</span>
              <ArrowRight className="size-3.5" />
              <strong>{sizeText(output)} px</strong>
            </div>
            <p className="text-[11px] text-muted-foreground">
              Estimated output · {((output.width * output.height) / 1e6).toFixed(1)} MP ·{" "}
              {scale?.toFixed(2)}× per side. Pixel rounding may vary slightly.
            </p>
          </>
        ) : (
          <p className="text-xs text-muted-foreground">
            {safe
              ? "Attach an image to see the expected output dimensions."
              : "Choose a preset to preview the output size."}
          </p>
        )}
        {multiplier && (
          <p className="text-[11px] text-muted-foreground">
            {sizing.percent}× multiplies both width and height. This is a multiplier, not a
            percentage.
          </p>
        )}
        {scale !== null && scale > 4 && (
          <p role="alert" className="text-xs text-amber-500">
            Large upscale: about {(scale * scale).toFixed(1)}× as many pixels. Processing and saving
            can take longer. For 5K, use the 5K preset above.
          </p>
        )}
        {scale !== null && scale < 1 && (
          <p className="text-xs text-amber-500">
            This target is smaller than your source and will reduce its resolution.
          </p>
        )}
      </div>
      <div className="space-y-2">
        <p className="text-xs font-medium">Image treatment</p>
        <div className="grid grid-cols-2 gap-2">
          {ENGINES.map(([value, label, help]) => (
            <button
              key={value}
              type="button"
              aria-pressed={(params.type ?? "ultra") === value}
              onClick={() => onChange("type", value)}
              className={cn(
                "rounded-lg border p-2 text-left transition-colors focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-50",
                (params.type ?? "ultra") === value
                  ? "border-primary bg-primary/10"
                  : "hover:bg-muted/50",
              )}
            >
              <span className="block text-xs font-medium">{label}</span>
              <span className="mt-1 block text-[11px] text-muted-foreground">{help}</span>
            </button>
          ))}
        </div>
        <p className="text-[11px] text-muted-foreground">
          Proportions stay the same; AI enhancement can still change fine details.
        </p>
      </div>
      <details className="text-xs">
        <summary className="cursor-pointer text-muted-foreground">File format · {format}</summary>
        <div className="mt-3 space-y-3">
          <label className="block space-y-1" htmlFor={`${id}-format`}>
            <span>Output format</span>
            <select
              id={`${id}-format`}
              className="h-8 w-full rounded-md border bg-background px-2"
              value={format}
              onChange={(event) => onChange("encode_format", event.target.value)}
            >
              <option value="PNG">PNG · lossless, larger file</option>
              <option value="JPEG">JPEG · smaller file</option>
              <option value="WEBP">WebP · compact file</option>
              <option value="BMP">BMP · uncompressed, very large file</option>
            </select>
          </label>
          {["JPEG", "WEBP"].includes(format) && (
            <label className="block space-y-1" htmlFor={`${id}-quality`}>
              <span>File quality · 1–100</span>
              <Input
                id={`${id}-quality`}
                type="number"
                min={1}
                max={100}
                value={Number(params.encode_quality ?? 80)}
                onChange={(event) =>
                  onChange(
                    "encode_quality",
                    Math.max(1, Math.min(100, Math.round(Number(event.target.value) || 1))),
                  )
                }
              />
              <span className="block text-[11px] text-muted-foreground">
                Higher means less compression and a larger file. It does not change the output
                dimensions.
              </span>
            </label>
          )}
        </div>
      </details>
    </fieldset>
  );
}
