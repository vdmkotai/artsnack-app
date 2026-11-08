"use client";

import * as React from "react";

import density from "@/components/preview-density.module.css";

import { cn } from "@/lib/utils";

export type MasonryLayout = {
  columns: number;
  columnWidth: number;
  /** Height of everything laid out so far, in CSS pixels. */
  height: number;
};

export type MasonryItem = {
  /** Stable identity for the tile. */
  key: string;
  /** width / height — reserves the cell's height before the media loads. */
  aspect: number;
  node: React.ReactNode;
};

interface MediaMasonryProps {
  items: MasonryItem[];
  /** Narrowest a column may get before the grid drops one. */
  minColumnWidth?: number;
  /** Allow a narrow desktop results panel to reach one readable column. */
  allowSingleColumn?: boolean;
  previewScale?: number;
  gap?: number;
  className?: string;
  /**
   * Told the measured layout whenever it changes, so a feed can size its pages
   * by how much of a screen its rows actually fill.
   */
  onLayoutChange?: (layout: MasonryLayout) => void;
}

/** Column count assumed until the container reports its real width. */
const SSR_COLUMNS = 3;

const useIsomorphicLayoutEffect =
  typeof window === "undefined" ? React.useEffect : React.useLayoutEffect;

function safeAspect(aspect: number): number {
  return Number.isFinite(aspect) && aspect > 0 ? aspect : 1;
}

/**
 * Column masonry, Grok-style: equal-width columns with a hairline gutter, tile
 * height derived from the media's own aspect ratio — so portrait and landscape
 * results line up without letterboxing or cropping.
 *
 * Items land in the shortest column, which keeps columns level while staying
 * close enough to reading order for a newest-first feed. Tiles are absolutely
 * positioned rather than nested in per-column stacks: measuring a video's real
 * ratio reshuffles the columns, and a tile that changed parents would remount —
 * restarting playback and re-running every load handler.
 */
export function MediaMasonry({
  items,
  minColumnWidth = 220,
  allowSingleColumn = false,
  previewScale = 1,
  gap = 6,
  className,
  onLayoutChange,
}: MediaMasonryProps) {
  const containerRef = React.useRef<HTMLDivElement>(null);
  const [width, setWidth] = React.useState(0);

  /*
   * A width of 0 is never kept. Composer panels on /generate are hidden with
   * `hidden` rather than unmounted, and a hidden grid measures 0 — taking that
   * at face value threw away the layout on every tab switch and rebuilt it from
   * three SSR columns on the way back.
   */
  useIsomorphicLayoutEffect(() => {
    const element = containerRef.current;
    if (!element) return;

    if (element.clientWidth > 0) setWidth(element.clientWidth);
    const observer = new ResizeObserver(([entry]) => {
      const next = entry.contentRect.width;
      if (next > 0) setWidth(next);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  // Phones still get two columns — a single wide column reads as a feed, not a grid.
  const effectiveMin =
    !allowSingleColumn && width > 0 && width < 640
      ? Math.min(minColumnWidth, (width - gap) / 2)
      : minColumnWidth;
  const columnCount =
    width > 0
      ? Math.max(1, Math.floor((width + gap) / (effectiveMin * previewScale + gap)))
      : SSR_COLUMNS;
  const columnWidth = width > 0 ? (width - gap * (columnCount - 1)) / columnCount : minColumnWidth;

  const { cells, totalHeight } = React.useMemo(() => {
    // Array.from rather than `new Array(n).fill(0)`: the latter crashes the
    // React Compiler's codegen, which silently drops this whole component.
    const heights: number[] = Array.from({ length: columnCount }, () => 0);

    const placed = items.map((item) => {
      let target = 0;
      for (let i = 1; i < columnCount; i++) {
        // Bias towards the leftmost column on ties so equal tiles read left-to-right.
        if (heights[i] < heights[target] - 0.5) target = i;
      }

      const height = columnWidth / safeAspect(item.aspect);
      const cell = {
        item,
        left: target * (columnWidth + gap),
        top: heights[target],
        height,
      };
      heights[target] += height + gap;
      return cell;
    });

    return { cells: placed, totalHeight: Math.max(0, Math.max(0, ...heights) - gap) };
  }, [items, columnCount, columnWidth, gap]);

  React.useEffect(() => {
    if (width > 0) onLayoutChange?.({ columns: columnCount, columnWidth, height: totalHeight });
  }, [width, columnCount, columnWidth, totalHeight, onLayoutChange]);

  return (
    <div
      ref={containerRef}
      className={cn("relative w-full", width === 0 && "invisible", className)}
      style={{ height: `${totalHeight}px` }}
    >
      {cells.map(({ item, left, top, height }) => (
        <div
          key={item.key}
          className={cn("absolute top-0 left-0", density.cell)}
          style={{
            // 2D on purpose: `translate3d` promoted every cell to a compositing
            // layer of its own, hundreds of them on a long feed.
            transform: `translate(${left}px, ${top}px)`,
            width: `${columnWidth}px`,
            height: `${height}px`,
            // Off-screen cells skip layout and paint, and the animations inside
            // them. The cell's size is explicit, so the containment that comes
            // with it changes nothing on screen.
            contentVisibility: "auto",
            containIntrinsicSize: `${columnWidth}px ${height}px`,
          }}
        >
          {item.node}
        </div>
      ))}
    </div>
  );
}
