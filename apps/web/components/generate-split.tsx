"use client";

import * as React from "react";
import { GripVertical } from "lucide-react";
import { cn } from "@/lib/utils";
import styles from "./generate-split.module.css";

const DEFAULT_RATIO = 0.4;
const HANDLE_WIDTH = 12;
const MIN_CONTROLS = 360;
const MIN_RESULTS = 320;

function readRatio(key: string): number {
  try {
    const saved = localStorage.getItem(key);
    const ratio = saved === null ? DEFAULT_RATIO : Number(saved);
    return Number.isFinite(ratio) && ratio > 0 && ratio < 1 ? ratio : DEFAULT_RATIO;
  } catch {
    return DEFAULT_RATIO;
  }
}

function saveRatio(key: string, ratio: number) {
  try {
    localStorage.setItem(key, String(ratio));
  } catch {
    // Resizing still works when browser storage is unavailable.
  }
}

/** Desktop split; the two panels keep their normal stacked layout on mobile. */
export function GenerateSplit({
  children,
  storageKey,
  className,
}: {
  children: [React.ReactNode, React.ReactNode];
  storageKey: string;
  className?: string;
}) {
  const containerRef = React.useRef<HTMLDivElement>(null);
  /**
   * The drag in flight. Pointer moves write the column ratio straight into the
   * container's CSS variable, once per frame, and React hears about it only
   * when the drag ends — a state update per pointermove re-rendered both
   * columns, results grid included, at the pointer's event rate.
   */
  const drag = React.useRef<{
    pointerId: number;
    offset: number;
    ratio: number | null;
    frame: number;
    clientX: number;
  } | null>(null);
  const controlsId = React.useId();
  const [ratio, setRatio] = React.useState(DEFAULT_RATIO);
  const [width, setWidth] = React.useState(0);
  const [dragging, setDragging] = React.useState(false);

  React.useEffect(() => setRatio(readRatio(storageKey)), [storageKey]);

  // A width of 0 means the panel is hidden (the /generate tabs use `hidden`),
  // not that it became narrow: keeping the last real width saves a relayout of
  // both columns on every tab switch.
  React.useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const observer = new ResizeObserver(([entry]) => {
      const next = entry.contentRect.width;
      if (next > 0) setWidth(next);
    });
    observer.observe(container);
    return () => observer.disconnect();
  }, []);

  React.useEffect(() => {
    return () => {
      const current = drag.current;
      if (current?.frame) cancelAnimationFrame(current.frame);
    };
  }, []);

  React.useEffect(() => {
    if (!dragging) return;
    const { cursor, userSelect } = document.body.style;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    return () => {
      document.body.style.cursor = cursor;
      document.body.style.userSelect = userSelect;
    };
  }, [dragging]);

  const available = Math.max(MIN_CONTROLS + MIN_RESULTS, width - HANDLE_WIDTH);
  const minRatio = MIN_CONTROLS / available;
  const maxRatio = 1 - MIN_RESULTS / available;
  const effectiveRatio = Math.min(maxRatio, Math.max(minRatio, ratio));

  type Drag = NonNullable<typeof drag.current>;

  function applyDrag(current: Drag) {
    const container = containerRef.current;
    if (!container) return;
    const rect = container.getBoundingClientRect();
    const availableWidth = rect.width - HANDLE_WIDTH;
    if (availableWidth < MIN_CONTROLS + MIN_RESULTS) return;
    const controlsWidth = current.clientX - rect.left - current.offset;
    const next =
      Math.min(availableWidth - MIN_RESULTS, Math.max(MIN_CONTROLS, controlsWidth)) /
      availableWidth;
    current.ratio = next;
    container.style.setProperty("--controls-ratio", String(next));
  }

  function finishDrag() {
    const current = drag.current;
    if (!current) return;
    drag.current = null;
    if (current.frame) {
      // The last move has not been painted yet; settle on it, not the one before.
      cancelAnimationFrame(current.frame);
      applyDrag(current);
    }
    setDragging(false);
    if (current.ratio !== null) {
      setRatio(current.ratio);
      saveRatio(storageKey, current.ratio);
    }
  }

  function onKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    const step = event.shiftKey ? 0.1 : 0.02;
    let next: number;
    switch (event.key) {
      case "ArrowLeft":
        next = effectiveRatio - step;
        break;
      case "ArrowRight":
        next = effectiveRatio + step;
        break;
      case "Home":
        next = minRatio;
        break;
      case "End":
        next = maxRatio;
        break;
      case "Enter":
        next = DEFAULT_RATIO;
        break;
      default:
        return;
    }
    event.preventDefault();
    const clamped = Math.min(maxRatio, Math.max(minRatio, next));
    setRatio(clamped);
    saveRatio(storageKey, clamped);
  }

  return (
    <div
      ref={containerRef}
      className={cn(styles.split, className)}
      style={{ "--controls-ratio": ratio } as React.CSSProperties}
    >
      <div id={controlsId} className="min-w-0 min-h-0">
        {children[0]}
      </div>
      <div
        role="separator"
        aria-label="Resize settings and results"
        aria-orientation="vertical"
        aria-controls={controlsId}
        aria-valuemin={Math.round(minRatio * 100)}
        aria-valuemax={Math.round(maxRatio * 100)}
        aria-valuenow={Math.round(effectiveRatio * 100)}
        aria-valuetext={`${Math.round(effectiveRatio * 100)}% settings`}
        tabIndex={0}
        title="Drag to resize. Double-click to reset."
        className={cn(
          "group relative hidden touch-none cursor-col-resize items-center justify-center border-x bg-muted/20 hover:bg-primary/15 focus-visible:outline-2 focus-visible:outline-primary focus-visible:-outline-offset-2 lg:flex",
          dragging && "bg-primary/15",
        )}
        onPointerDown={(event) => {
          if (event.button !== 0 || !event.isPrimary) return;
          event.preventDefault();
          event.currentTarget.focus();
          event.currentTarget.setPointerCapture(event.pointerId);
          drag.current = {
            pointerId: event.pointerId,
            offset: event.clientX - event.currentTarget.getBoundingClientRect().left,
            ratio: null,
            frame: 0,
            clientX: event.clientX,
          };
          setDragging(true);
        }}
        onPointerMove={(event) => {
          const current = drag.current;
          if (current?.pointerId !== event.pointerId) return;
          current.clientX = event.clientX;
          if (current.frame) return;
          current.frame = requestAnimationFrame(() => {
            current.frame = 0;
            if (drag.current === current) applyDrag(current);
          });
        }}
        onPointerUp={(event) => {
          if (drag.current?.pointerId !== event.pointerId) return;
          finishDrag();
          event.currentTarget.releasePointerCapture(event.pointerId);
        }}
        onPointerCancel={finishDrag}
        onLostPointerCapture={finishDrag}
        onDoubleClick={() => {
          setRatio(DEFAULT_RATIO);
          saveRatio(storageKey, DEFAULT_RATIO);
        }}
        onKeyDown={onKeyDown}
      >
        <GripVertical className="pointer-events-none h-5 w-3 text-muted-foreground group-hover:text-foreground" />
      </div>
      <div className="min-w-0 min-h-0">{children[1]}</div>
    </div>
  );
}
