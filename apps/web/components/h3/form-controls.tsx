"use client";

import * as React from "react";
import { CircleAlert, Images, Lightbulb, Upload, X } from "lucide-react";

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";

/**
 * Form pieces shared by the Self-hosted video tab's two families (MiniMax H3
 * and LTX 2.3): labelled rows, switches with "recommended"/advice marks, number
 * inputs and the image slots for frames and references.
 */

export type InputRole = "first" | "last" | "reference";
export type InputImage = {
  id: string;
  role: InputRole;
  blob: Blob;
  previewUrl: string;
  /** The output this came from, when picked out of the grid. */
  sourceUrl?: string;
};

/** One labelled row of the form, matching the API tab's density. */
export function Field({
  label,
  hint,
  recommended,
  advice,
  children,
  className,
}: {
  label: string;
  hint?: string;
  /** Shows the green "recommended" mark next to the label. */
  recommended?: boolean;
  advice?: Advice | null;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("space-y-1.5", className)}>
      <div className="flex items-center gap-1.5">
        <Label className="text-xs">{label}</Label>
        {recommended && <RecommendedMark />}
      </div>
      {children}
      {hint && <p className="text-[11px] leading-snug text-muted-foreground">{hint}</p>}
      <AdviceLine advice={advice} />
    </div>
  );
}

/** A setting worth a second look: "warn" will likely hurt the clip, "tip"
 *  would make it faster or better. */
export type Advice = { kind: "warn" | "tip"; text: string };

export function AdviceLine({ advice }: { advice?: Advice | null }) {
  if (!advice) return null;
  const Icon = advice.kind === "warn" ? CircleAlert : Lightbulb;
  return (
    <p
      className={cn(
        "flex items-start gap-1 text-[11px] leading-snug",
        advice.kind === "warn"
          ? "text-amber-600 dark:text-amber-400"
          : "text-sky-600 dark:text-sky-400",
      )}
    >
      <Icon className="mt-px h-3 w-3 shrink-0" />
      <span>{advice.text}</span>
    </p>
  );
}

/** Marks a third-party add-on: not part of official H3, results vary. */
export function CommunityMark() {
  return (
    <span
      title="Community add-on — not part of official MiniMax H3"
      className="rounded-full bg-violet-500/15 px-1.5 py-px text-[9px] font-medium tracking-wide text-violet-600 uppercase dark:text-violet-300"
    >
      community
    </span>
  );
}

export function RecommendedMark() {
  return (
    <span
      title="Recommended setting"
      className="rounded-full bg-green-500/15 px-1.5 py-px text-[9px] font-medium tracking-wide text-green-600 uppercase dark:text-green-400"
    >
      recommended
    </span>
  );
}

export function Toggle({
  label,
  hint,
  recommended,
  advice,
  checked,
  onChange,
  disabled,
  community,
}: {
  label: string;
  hint?: string;
  recommended?: boolean;
  advice?: Advice | null;
  checked: boolean;
  onChange: (value: boolean) => void;
  disabled?: boolean;
  /** A community add-on rather than part of official H3. */
  community?: boolean;
}) {
  const id = React.useId();
  return (
    <div
      className={cn(
        "flex items-start justify-between gap-3 rounded-md border px-3 py-2",
        advice?.kind === "warn" && "border-amber-500/40",
      )}
    >
      <div className="space-y-0.5">
        <div className="flex items-center gap-1.5">
          <Label htmlFor={id} className="cursor-pointer text-xs">
            {label}
          </Label>
          {recommended && <RecommendedMark />}
          {community && <CommunityMark />}
        </div>
        {hint && <p className="text-[11px] leading-snug text-muted-foreground">{hint}</p>}
        <AdviceLine advice={advice} />
      </div>
      <Switch id={id} checked={checked} onCheckedChange={onChange} disabled={disabled} />
    </div>
  );
}

export function NumberInput({
  value,
  onChange,
  min,
  max,
  step = 1,
  disabled,
}: {
  value: number;
  onChange: (value: number) => void;
  min: number;
  max: number;
  step?: number;
  disabled?: boolean;
}) {
  return (
    <Input
      disabled={disabled}
      type="number"
      className="h-8"
      value={value}
      min={min}
      max={max}
      step={step}
      onChange={(event) => onChange(Number(event.target.value))}
      onBlur={(event) => onChange(Math.min(max, Math.max(min, Number(event.target.value) || min)))}
    />
  );
}

/**
 * One input image, or the two ways to fill an empty one: a file from disk or
 * an image from favourites / history (the API tab's picker).
 */
export function ImageSlot({
  label,
  badge,
  image,
  onUpload,
  onGallery,
  onClear,
}: {
  label: string;
  /** The number the prompt's @imageN tag refers to. */
  badge?: number;
  image?: InputImage;
  onUpload: () => void;
  onGallery: () => void;
  onClear: () => void;
}) {
  return (
    <div className="space-y-1">
      <span className="text-[11px] text-muted-foreground">{label}</span>
      {image ? (
        <div className="group relative aspect-video overflow-hidden rounded-md border">
          {/* eslint-disable-next-line @next/next/no-img-element -- local blob preview */}
          <img src={image.previewUrl} alt={label} className="h-full w-full object-cover" />
          {badge !== undefined && (
            <span className="absolute left-1 top-1 rounded bg-lime-400/90 px-1.5 py-px font-mono text-[10px] font-semibold text-black">
              @image{badge}
            </span>
          )}
          <button
            type="button"
            aria-label={`Remove ${label.toLowerCase()}`}
            className="absolute right-1 top-1 rounded bg-black/60 p-0.5 text-white"
            onClick={onClear}
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      ) : (
        <div className="grid aspect-video w-full grid-cols-2 overflow-hidden rounded-md border border-dashed text-muted-foreground">
          <button
            type="button"
            onClick={onUpload}
            title="Upload from disk (or drop / paste an image)"
            className="flex flex-col items-center justify-center gap-0.5 text-[10px] hover:bg-muted/40"
          >
            <Upload className="h-4 w-4" /> Upload
          </button>
          <button
            type="button"
            onClick={onGallery}
            title="Pick from favourites or history"
            className="flex flex-col items-center justify-center gap-0.5 border-l border-dashed text-[10px] hover:bg-muted/40"
          >
            <Images className="h-4 w-4" /> Gallery
          </button>
        </div>
      )}
    </div>
  );
}
