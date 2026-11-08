"use client";

import * as React from "react";
import { Textarea } from "@/components/ui/textarea";
import { getGrokMentionAtCaret, GrokMentionRange, replaceGrokMention } from "@/lib/grok-prompt";
import { cn } from "@/lib/utils";

interface PromptInputProps {
  id?: string;
  value: string;
  onChange: (value: string) => void;
  /** Selected references in upload order — drives the @-mention dropdown. */
  references: readonly { previewUrl: string }[];
  placeholder?: string;
  className?: string;
  /** Classes for the textarea itself, e.g. a different minimum height. */
  textareaClassName?: string;
  /**
   * Keys the mention dropdown does not consume — Enter while it is open picks
   * a reference and never reaches this.
   */
  onKeyDown?: (event: React.KeyboardEvent<HTMLTextAreaElement>) => void;
  /**
   * Where the mention list opens. "above" for a box pinned to the bottom of
   * a pane, such as a chat composer, where a list below would be cut off.
   */
  dropdownPlacement?: "below" | "above";
}

type PromptPart = { text: string; referenceIndex?: number };

/**
 * Typography shared by the textarea, the highlight overlay and the caret mirror.
 *
 * The mirror only measures correctly while it wraps text exactly as the textarea
 * does, so the three cannot be allowed to drift apart — one string, used by all.
 */
const MIRROR_CLASS =
  "absolute inset-0 overflow-hidden rounded-md border border-transparent px-2 py-2 text-base whitespace-pre-wrap break-words pointer-events-none md:text-xs/relaxed";

function promptParts(value: string): PromptPart[] {
  const parts: PromptPart[] = [];
  const tagRegex = /@image\s?(\d+)\b/gi;
  let cursor = 0;

  for (const match of value.matchAll(tagRegex)) {
    const start = match.index;
    if (start > cursor) parts.push({ text: value.slice(cursor, start) });
    parts.push({ text: match[0], referenceIndex: Number(match[1]) });
    cursor = start + match[0].length;
  }
  if (cursor < value.length) parts.push({ text: value.slice(cursor) });
  return parts;
}

/**
 * Prompt textarea with Higgsfield-style "@image N" mentions: typing "@" opens
 * a dropdown of the attached references; picking one inserts an `@imageN` tag.
 * Tags remain plain text for editing and persistence, but are visually
 * highlighted and normalized to ordinal references at the API boundary.
 */
export function PromptInput({
  id,
  value,
  onChange,
  references,
  placeholder,
  className,
  textareaClassName,
  onKeyDown,
  dropdownPlacement = "below",
}: PromptInputProps) {
  const textareaRef = React.useRef<HTMLTextAreaElement | null>(null);
  const [token, setToken] = React.useState<GrokMentionRange | null>(null);
  const [highlight, setHighlight] = React.useState(0);
  const [scroll, setScroll] = React.useState({ left: 0, top: 0 });
  /**
   * Where the dropdown goes, in pixels inside this box.
   *
   * It used to be `top-full` — pinned under the whole textarea. That reads fine
   * on a short prompt and is unusable on a long one: the box grows, so the list
   * opens hundreds of pixels below the line being typed, off the bottom of the
   * screen. It looked exactly like the tags not working, which is what it was
   * reported as.
   */
  const [caret, setCaret] = React.useState<{ top: number; lineTop: number; left: number } | null>(
    null,
  );
  const mirrorRef = React.useRef<HTMLDivElement | null>(null);
  const markerRef = React.useRef<HTMLSpanElement | null>(null);

  // Plain values, not useMemo/useCallback: the React Compiler already memoizes
  // this component, and none of these cross a props boundary.
  const parts = promptParts(value);

  const matches = !token
    ? []
    : references
        .map((ref, index) => ({ ref, n: index + 1 }))
        .filter(
          ({ n }) =>
            token.query === "" ||
            `image${n}`.startsWith(token.query) ||
            String(n).startsWith(token.query),
        );

  const open = token !== null && matches.length > 0;

  // Layout effect, not an effect: the dropdown must not paint at the old
  // position for a frame before jumping to the caret.
  React.useLayoutEffect(() => {
    const marker = markerRef.current;
    const textarea = textareaRef.current;
    if (!token || !marker || !textarea) {
      setCaret(null);
      return;
    }
    // The mirror is not scrolled — it lays out the whole value — so the
    // textarea's own scroll offset is what converts a content position into a
    // visible one.
    setCaret({
      top: marker.offsetTop - textarea.scrollTop + marker.offsetHeight,
      lineTop: marker.offsetTop - textarea.scrollTop,
      left: marker.offsetLeft - textarea.scrollLeft,
    });
  }, [token, value, scroll]);

  const syncToken = (nextValue: string) => {
    const el = textareaRef.current;
    if (!el) {
      setToken(null);
      return;
    }
    const next = getGrokMentionAtCaret(nextValue, el.selectionStart ?? 0);
    setToken(next);
    setHighlight(0);
  };

  const insert = (n: number) => {
    if (!token) return;
    const replacement = replaceGrokMention(value, token, n);
    onChange(replacement.value);
    setToken(null);
    requestAnimationFrame(() => {
      const el = textareaRef.current;
      if (el) {
        el.focus();
        el.setSelectionRange(replacement.caret, replacement.caret);
      }
    });
  };

  return (
    <div className={cn("relative", className)}>
      {value && (
        <div
          aria-hidden="true"
          className={cn(MIRROR_CLASS, "bg-input/20 text-transparent dark:bg-input/30")}
        >
          <div style={{ transform: `translate(${-scroll.left}px, ${-scroll.top}px)` }}>
            {parts.map((part, index) =>
              part.referenceIndex === undefined ? (
                <React.Fragment key={index}>{part.text}</React.Fragment>
              ) : (
                <span
                  key={index}
                  className={cn(
                    "rounded-sm box-decoration-clone",
                    part.referenceIndex >= 1 && part.referenceIndex <= references.length
                      ? "bg-lime-400/20"
                      : "bg-destructive/20",
                  )}
                >
                  {part.text}
                </span>
              ),
            )}
            {value.endsWith("\n") ? " " : null}
          </div>
        </div>
      )}
      {/*
        An invisible copy of the text up to the mention, so the marker span
        lands exactly where the caret is. Measuring the textarea itself is not
        possible — a textarea exposes no geometry for a character offset — and
        this is the standard way round it.
      */}
      {token && (
        <div ref={mirrorRef} aria-hidden="true" className={cn(MIRROR_CLASS, "invisible")}>
          {value.slice(0, token.start)}
          <span ref={markerRef}>@</span>
        </div>
      )}
      <Textarea
        id={id}
        ref={textareaRef}
        placeholder={placeholder}
        className={cn(
          "relative z-10 min-h-[100px] resize-y text-base md:text-xs/relaxed",
          textareaClassName,
          // Only the tag backgrounds are mirrored. Keep the browser's actual
          // text visible, including composition and external edits before React
          // has reconciled them with the highlight layer.
          value && "bg-transparent caret-foreground selection:bg-primary/30 dark:bg-transparent",
        )}
        value={value}
        onChange={(e) => {
          onChange(e.target.value);
          syncToken(e.target.value);
        }}
        onSelect={() => syncToken(value)}
        onScroll={(event) => {
          setScroll({ left: event.currentTarget.scrollLeft, top: event.currentTarget.scrollTop });
        }}
        onBlur={() => {
          // Delay so a dropdown click still lands before the token clears.
          setTimeout(() => setToken(null), 150);
        }}
        onKeyDown={(e) => {
          if (e.nativeEvent.isComposing || e.keyCode === 229) return;
          if (!open || e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) {
            onKeyDown?.(e);
            return;
          }
          if (e.key === "ArrowDown") {
            e.preventDefault();
            setHighlight((h) => (h + 1) % matches.length);
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setHighlight((h) => (h - 1 + matches.length) % matches.length);
          } else if (e.key === "Enter" || e.key === "Tab") {
            e.preventDefault();
            e.stopPropagation();
            insert(matches[highlight]?.n ?? matches[0].n);
          } else if (e.key === "Escape") {
            e.preventDefault();
            setToken(null);
          } else {
            onKeyDown?.(e);
          }
        }}
      />
      {open && (
        <div
          className={cn(
            "absolute z-30 max-h-60 w-64 overflow-y-auto rounded-md border bg-popover shadow-lg",
            dropdownPlacement === "above" ? "mb-1" : "mt-1",
          )}
          style={
            caret
              ? {
                  ...(dropdownPlacement === "above"
                    ? { bottom: `calc(100% - ${caret.lineTop}px)` }
                    : { top: caret.top }),
                  // Clamped so a mention near the right edge does not open the
                  // list off the side of the box.
                  left: `min(${Math.max(0, caret.left)}px, calc(100% - 16rem))`,
                }
              : dropdownPlacement === "above"
                ? { bottom: "100%", left: 0 }
                : { top: "100%", left: 0 }
          }
        >
          {matches.map(({ ref, n }, i) => (
            <button
              key={n}
              type="button"
              className={cn(
                "w-full flex items-center gap-3 px-3 py-2 text-sm text-left hover:bg-accent",
                i === highlight && "bg-accent",
              )}
              // onMouseDown so it fires before the textarea's blur.
              onMouseDown={(e) => {
                e.preventDefault();
                insert(n);
              }}
              onMouseEnter={() => setHighlight(i)}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={ref.previewUrl}
                alt={`Image ${n}`}
                className="h-9 w-9 rounded object-cover border"
              />
              <span className="font-medium">Image {n}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
