"use client";

import * as React from "react";
import { Info } from "lucide-react";

import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

/**
 * The vendor's prose, behind an icon.
 *
 * 99% of the 1104 parameters in the Atlas catalogue carry a description, and the
 * median one is 47 characters — but they were rendered right-aligned in a column
 * capped at 60% of the row, which turns a short sentence into two ragged lines
 * and spends 24px of the panel on justification rather than on words. The worst
 * case in the catalogue is 750 characters, which `line-clamp-2` silently cut in
 * half; a tooltip shows all of it.
 */
export function InfoHint({ text, className }: { text: string; className?: string }) {
  return (
    <Tooltip>
      <TooltipTrigger
        // A hint, not a control: it must not be a tab stop on the way to the
        // input it describes, and there are up to ten of them per model.
        tabIndex={-1}
        aria-hidden
        className={cn(
          "shrink-0 text-muted-foreground/60 transition-colors hover:text-foreground",
          className,
        )}
      >
        <Info className="h-3 w-3" />
      </TooltipTrigger>
      <TooltipContent className="max-w-xs leading-snug">{text}</TooltipContent>
    </Tooltip>
  );
}

/**
 * One parameter, one row: name on the left, control on the right.
 *
 * The old shape was three stacked rows per parameter — label, description,
 * control — at 84 to 108px each, so a model with seven of them (and the
 * catalogue has plenty) pushed the Generate button 660px down a panel that is
 * also holding a prompt box and a reference strip. Median is four parameters,
 * p75 is six, one model has ten.
 */
export function FieldRow({
  label,
  hint,
  required,
  /** Spans both grid columns. Decided by the control, not the caller's taste. */
  wide,
  /**
   * Control under the label instead of beside it. For the handful that cannot
   * be squeezed onto a shared line — a textarea, and the ratio-plus-tier size
   * picker — where forcing the inline shape would just clip them.
   */
  stacked,
  children,
  className,
}: {
  label: string;
  hint?: string;
  required?: boolean;
  wide?: boolean;
  stacked?: boolean;
  children: React.ReactNode;
  className?: string;
}) {
  const name = (
    <span className="flex min-w-0 items-center gap-1 text-xs text-foreground">
      <span className="truncate" title={label}>
        {label}
      </span>
      {/* The vendor's own `required` flag. Every one of them still carries a
          clamped default, so this is information, not a validation state. */}
      {required && <span className="text-muted-foreground">*</span>}
      {hint && <InfoHint text={hint} />}
    </span>
  );

  if (stacked) {
    return (
      <div className={cn("space-y-1", wide && "col-span-2", className)}>
        {name}
        {children}
      </div>
    );
  }

  return (
    <div
      className={cn(
        "flex min-h-8 items-center gap-2",
        // Dense packing backfills the holes a wide control would otherwise
        // leave, so the order stays the vendor's but the rows stay full.
        wide && "col-span-2",
        className,
      )}
    >
      {name}
      <span className="ml-auto flex min-w-0 items-center gap-1.5">{children}</span>
    </div>
  );
}

/** The grid `FieldRow`s live in. Two columns, holes backfilled. */
export function FieldGrid({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("grid grid-flow-row-dense grid-cols-2 gap-x-4 gap-y-1", className)}>
      {children}
    </div>
  );
}
