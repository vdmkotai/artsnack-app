"use client";

import { Sparkles, Trash2, X } from "lucide-react";
import { Button } from "@/components/ui/button";

interface SelectionToolbarProps {
  count: number;
  /** Absent hides the destructive action — a page may offer only `children`. */
  onDelete?: () => void;
  onClear: () => void;
  isDeleting?: boolean;
  onUseAsReferences?: () => void;
  /** Page-specific actions, rendered between the count and the built-ins. */
  children?: React.ReactNode;
}

export function SelectionToolbar({
  count,
  onDelete,
  onClear,
  isDeleting,
  onUseAsReferences,
  children,
}: SelectionToolbarProps) {
  if (count === 0) return null;

  return (
    <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 flex items-center gap-3 rounded-full border bg-background/95 backdrop-blur-md px-4 py-2 shadow-lg">
      <span className="text-sm font-medium whitespace-nowrap">{count} selected</span>
      {children}
      {onUseAsReferences ? (
        <Button size="sm" onClick={onUseAsReferences} className="gap-1.5">
          <Sparkles className="h-4 w-4" />
          Use as references
        </Button>
      ) : null}
      {onDelete && !onUseAsReferences ? (
        <Button
          variant="destructive"
          size="sm"
          onClick={onDelete}
          disabled={isDeleting}
          className="gap-1.5"
        >
          <Trash2 className="h-4 w-4" />
          {isDeleting ? "Deleting..." : "Delete"}
        </Button>
      ) : null}
      <Button
        variant="ghost"
        size="icon"
        onClick={onClear}
        className="h-8 w-8"
        aria-label="Clear selection"
        title="Clear selection"
      >
        <X className="h-4 w-4" />
      </Button>
    </div>
  );
}
