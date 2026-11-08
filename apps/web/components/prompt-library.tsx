"use client";

import * as React from "react";
import Link from "next/link";
import { useMutation } from "convex/react";
import { useQuery as useCachedQuery } from "@/lib/convex-cache";
import { toast } from "sonner";
import { BookmarkPlus, Library, Loader2, Search } from "lucide-react";

import { api } from "@/convex/_generated/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";

/**
 * Kept out of the component for the same reason as the helpers in
 * app/generate/page.tsx: React Compiler cannot lower a `try` with a finalizer,
 * and when it meets one it drops automatic memoization for the whole enclosing
 * component. Swallowing here means the caller's `setIsSaving(false)` needs no
 * `finally` — this never rejects.
 */
async function savePromptText(
  savePrompt: (args: { text: string }) => Promise<{ duplicate: boolean }>,
  text: string,
): Promise<void> {
  try {
    const result = await savePrompt({ text });
    toast.success(result.duplicate ? "Already saved" : "Prompt saved");
  } catch (error) {
    toast.error(error instanceof Error ? error.message : "Could not save the prompt");
  }
}

/**
 * Save the current prompt, or drop a saved one into the field.
 *
 * Sits with the prompt input rather than on the library page, because that is
 * where the decision happens — you know a wording is worth keeping the moment
 * you finish typing it, and you want the old one back before you start.
 */
export function PromptLibrary({
  value,
  onInsert,
  className,
}: {
  /** Current prompt, offered for saving. */
  value: string;
  onInsert: (text: string) => void;
  className?: string;
}) {
  const prompts = useCachedQuery(api.savedPrompts.list);
  const savePrompt = useMutation(api.savedPrompts.save);
  const [open, setOpen] = React.useState(false);
  const [filter, setFilter] = React.useState("");
  const [isSaving, setIsSaving] = React.useState(false);

  const trimmed = value.trim();

  const matches = React.useMemo(() => {
    const needle = filter.trim().toLowerCase();
    const all = prompts ?? [];
    if (!needle) return all;
    return all.filter(
      (row) => row.title.toLowerCase().includes(needle) || row.text.toLowerCase().includes(needle),
    );
  }, [prompts, filter]);

  const save = React.useCallback(async () => {
    if (!trimmed || isSaving) return;
    setIsSaving(true);
    await savePromptText(savePrompt, trimmed);
    setIsSaving(false);
  }, [trimmed, isSaving, savePrompt]);

  return (
    <div className={cn("flex items-center gap-1", className)}>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="h-7 gap-1.5 px-2 text-xs"
        disabled={!trimmed || isSaving}
        title={trimmed ? "Save this prompt" : "Nothing to save yet"}
        onClick={() => void save()}
      >
        {isSaving ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
        ) : (
          <BookmarkPlus className="h-3.5 w-3.5" />
        )}
        Save
      </Button>

      <Popover
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          // A filter left behind makes the count on the trigger disagree with
          // the list the next time the popover opens.
          if (!next) setFilter("");
        }}
      >
        <PopoverTrigger
          render={
            <Button type="button" variant="ghost" size="sm" className="h-7 gap-1.5 px-2 text-xs" />
          }
        >
          <Library className="h-3.5 w-3.5" />
          Saved
          {prompts && prompts.length > 0 && (
            <span className="text-muted-foreground tabular-nums">{prompts.length}</span>
          )}
        </PopoverTrigger>
        <PopoverContent align="end" className="w-[min(30rem,calc(100vw-2rem))] p-0">
          <div className="flex items-center gap-2 border-b px-3 py-2">
            <Search className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            <Input
              value={filter}
              onChange={(event) => setFilter(event.target.value)}
              placeholder="Filter saved prompts"
              className="h-7 border-0 p-0 text-sm shadow-none focus-visible:ring-0"
            />
          </div>

          <div className="max-h-[min(24rem,60vh)] overflow-y-auto">
            {prompts === undefined ? (
              <div className="flex justify-center py-8">
                <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
              </div>
            ) : matches.length === 0 ? (
              <p className="px-3 py-8 text-center text-sm text-muted-foreground">
                {prompts.length === 0
                  ? "Nothing saved yet — write a prompt and press Save."
                  : "No prompt matches that."}
              </p>
            ) : (
              matches.map((row) => (
                <button
                  key={row._id}
                  type="button"
                  className="block w-full border-b px-3 py-2 text-left last:border-b-0 hover:bg-accent"
                  onClick={() => {
                    // Inserting replaces the field. Anything already typed
                    // there took effort too, so it is offered back rather than
                    // quietly discarded.
                    const previous = value;
                    onInsert(row.text);
                    setOpen(false);
                    setFilter("");
                    if (previous.trim() && previous !== row.text) {
                      toast("Prompt replaced", {
                        action: { label: "Undo", onClick: () => onInsert(previous) },
                      });
                    }
                  }}
                >
                  <span className="block truncate text-sm font-medium">{row.title}</span>
                  <span className="line-clamp-2 text-xs break-words text-muted-foreground">
                    {row.text}
                  </span>
                </button>
              ))
            )}
          </div>

          <div className="border-t px-3 py-2">
            <Link href="/prompts" className="text-xs text-muted-foreground hover:underline">
              Manage all prompts →
            </Link>
          </div>
        </PopoverContent>
      </Popover>
    </div>
  );
}
