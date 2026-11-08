"use client";

import * as React from "react";
import { Check, Copy, CornerDownLeft, PenLine } from "lucide-react";

import { Button } from "@/components/ui/button";
import { copyText } from "@/lib/copy-text";
import { diffWords, type StudioVariant } from "@/lib/prompt-studio";
import { cn } from "@/lib/utils";

/**
 * One variant: its label, a title and a one-line summary in the user's
 * language, and the English prompt — clamped to a few lines until opened. A
 * revision shows its changes against the variant it came from, inline.
 */
export const StudioVariantCard = React.memo(function StudioVariantCard({
  variant,
  parent,
  inPrompt,
  replying,
  onInsert,
  onRefine,
}: {
  variant: StudioVariant;
  /** The variant this one revises, when it is still in the session. */
  parent?: StudioVariant;
  /** The prompt field holds exactly this text. */
  inPrompt: boolean;
  /** The composer is answering this variant. */
  replying: boolean;
  onInsert: (label: string) => void;
  onRefine: (label: string) => void;
}) {
  const [expanded, setExpanded] = React.useState(false);
  const [showChanges, setShowChanges] = React.useState(true);
  const [copied, setCopied] = React.useState(false);

  const diff = parent && showChanges ? diffWords(parent.prompt, variant.prompt) : null;
  const words = variant.prompt.split(/\s+/).filter(Boolean).length;

  const copy = () => {
    void copyText(variant.prompt).then((ok) => {
      if (!ok) return;
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  return (
    <div
      className={cn(
        "rounded-lg border bg-card p-3",
        inPrompt && "border-primary/60",
        replying && "ring-1 ring-primary/50",
      )}
    >
      <div className="flex items-center gap-2">
        <span className="inline-flex h-5 min-w-5 shrink-0 items-center justify-center rounded bg-muted px-1 text-[0.6875rem] font-semibold tabular-nums">
          {variant.label}
        </span>
        <span className="min-w-0 flex-1 truncate text-sm font-medium">{variant.title}</span>
        {inPrompt ? (
          <span className="inline-flex shrink-0 items-center gap-1 rounded-full border border-primary/50 bg-primary/15 px-2 py-0.5 text-[0.6875rem] text-primary-foreground">
            <Check className="size-3" />
            In prompt
          </span>
        ) : (
          <span className="shrink-0 text-[0.6875rem] text-muted-foreground tabular-nums">
            {words} words
          </span>
        )}
      </div>

      {variant.changes && (
        <p className="mt-1.5 text-xs/relaxed">
          <span className="text-muted-foreground">Changed: </span>
          {variant.changes}
        </p>
      )}
      {variant.summary && <p className="mt-1.5 text-xs/relaxed">{variant.summary}</p>}

      <button
        type="button"
        onClick={() => setExpanded((open) => !open)}
        title={expanded ? "Collapse" : "Show the whole prompt"}
        className={cn(
          "relative mt-2 block w-full rounded-md bg-muted/40 px-2.5 py-2 text-left font-mono text-[0.6875rem]/relaxed break-words whitespace-pre-wrap text-muted-foreground",
          !expanded && "max-h-[4.6rem] overflow-hidden",
        )}
      >
        {diff
          ? diff.map((segment, index) =>
              segment.kind === "same" ? (
                <React.Fragment key={index}>{segment.text}</React.Fragment>
              ) : segment.kind === "added" ? (
                <ins key={index} className="rounded-sm bg-primary/35 text-foreground no-underline">
                  {segment.text}
                </ins>
              ) : (
                <del key={index} className="text-destructive/80">
                  {segment.text}
                </del>
              ),
            )
          : variant.prompt}
        {!expanded && (
          <span className="pointer-events-none absolute inset-x-0 bottom-0 h-6 rounded-b-md bg-linear-to-t from-card to-transparent" />
        )}
      </button>

      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        <Button
          type="button"
          size="sm"
          variant={inPrompt ? "outline" : "default"}
          onClick={() => onInsert(variant.label)}
        >
          <CornerDownLeft />
          {inPrompt ? "Use again" : "Use this prompt"}
        </Button>
        <Button
          type="button"
          size="sm"
          variant={replying ? "secondary" : "outline"}
          onClick={() => onRefine(variant.label)}
        >
          <PenLine />
          Refine
        </Button>
        {parent && (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="text-muted-foreground"
            onClick={() => setShowChanges((shown) => !shown)}
          >
            {showChanges ? "Hide changes" : `Changes vs ${parent.label}`}
          </Button>
        )}
        <span className="flex-1" />
        <Button
          type="button"
          size="icon-sm"
          variant="ghost"
          aria-label="Copy the prompt"
          title="Copy the prompt"
          onClick={copy}
        >
          {copied ? <Check /> : <Copy />}
        </Button>
      </div>
    </div>
  );
});
