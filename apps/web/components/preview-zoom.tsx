"use client";

import * as React from "react";
import { Minus, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";

const MIN_SCALE = 0.25;
const MAX_SCALE = 2;
const STEP = 0.25;

function readScale(key: string): number {
  try {
    const saved = localStorage.getItem(key);
    const scale = saved === null ? 1 : Number(saved);
    return Number.isFinite(scale) && scale >= MIN_SCALE && scale <= MAX_SCALE ? scale : 1;
  } catch {
    return 1;
  }
}

function saveScale(key: string, scale: number) {
  try {
    localStorage.setItem(key, String(scale));
  } catch {
    // Keep zoom usable when storage is blocked.
  }
}

export function usePreviewZoom(storageKey: string) {
  const [scale, setScale] = React.useState(1);
  React.useEffect(() => setScale(readScale(storageKey)), [storageKey]);
  function changeScale(value: number) {
    const next = Math.min(MAX_SCALE, Math.max(MIN_SCALE, value));
    setScale(next);
    saveScale(storageKey, next);
  }
  return [scale, changeScale] as const;
}

export function PreviewZoom({
  scale,
  onChange,
}: {
  scale: number;
  onChange: (scale: number) => void;
}) {
  return (
    <div
      role="group"
      aria-label="Preview size"
      className="inline-flex shrink-0 items-center rounded-md border"
    >
      <Button
        variant="ghost"
        size="icon"
        className="h-7 w-7"
        aria-label="Decrease preview size"
        title="Smaller previews"
        disabled={scale <= MIN_SCALE}
        onClick={() => onChange(scale - STEP)}
      >
        <Minus className="h-3.5 w-3.5" />
      </Button>
      <Button
        variant="ghost"
        size="sm"
        className="h-7 w-12 px-0 text-xs tabular-nums"
        aria-label={`Preview size ${Math.round(scale * 100)}%. Reset to 100%`}
        title="Reset preview size"
        onClick={() => onChange(1)}
      >
        {Math.round(scale * 100)}%
      </Button>
      <Button
        variant="ghost"
        size="icon"
        className="h-7 w-7"
        aria-label="Increase preview size"
        title="Larger previews"
        disabled={scale >= MAX_SCALE}
        onClick={() => onChange(scale + STEP)}
      >
        <Plus className="h-3.5 w-3.5" />
      </Button>
    </div>
  );
}
