"use client";

import * as React from "react";
import Link from "next/link";
import { useAction, useMutation, useQuery } from "convex/react";
import { ConvexError } from "convex/values";
import { toast } from "sonner";
import { ArrowLeft, ChevronDown, CornerDownLeft, Loader2, PenLine, Sparkles } from "lucide-react";

import { api } from "@/convex/_generated/api";
import type { Doc, Id } from "@/convex/_generated/dataModel";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Textarea } from "@/components/ui/textarea";
import {
  defaultRecipeFor,
  ENHANCE_MODELS,
  getEnhanceModel,
  MAX_CUSTOM_INSTRUCTION,
  recipesFor,
  type EnhanceContext,
} from "@/lib/prompt-enhance";
import { cn } from "@/lib/utils";

type Recipe = Doc<"enhanceRecipes">;

type EnhanceArgs = {
  prompt: string;
  context: EnhanceContext;
} & (
  | { recipeId: Id<"enhanceRecipes">; instruction?: never }
  | { instruction: string; recipeId?: never }
);

type EnhanceResult = {
  text: string;
  costUsd?: number;
  model: { label: string; provider: "grok" | "atlas" };
  fellBack: boolean;
  reason?: string;
};

/**
 * Kept out of the component: React Compiler cannot lower a `try` with a
 * finalizer and drops memoization for the whole component when it meets one.
 * This never rejects — every outcome becomes a toast.
 */
async function runEnhance(
  enhance: (args: EnhanceArgs) => Promise<EnhanceResult>,
  args: EnhanceArgs,
  recipeTitle: string,
  onReplace: (text: string) => void,
): Promise<void> {
  try {
    const result = await enhance(args);
    onReplace(result.text);
    const via =
      result.model.provider === "atlas" ? `Atlas · ${result.model.label}` : result.model.label;
    const cost = result.costUsd !== undefined ? ` · $${result.costUsd.toFixed(4)}` : "";
    toast(`${recipeTitle} · via ${via}${cost}`, {
      description: result.fellBack
        ? `Grok did not answer (${result.reason ?? "unknown"}), Atlas did.`
        : undefined,
      action: { label: "Undo", onClick: () => onReplace(args.prompt) },
      duration: 8000,
    });
  } catch (error) {
    toast.error(
      error instanceof ConvexError
        ? String(error.data)
        : error instanceof Error
          ? error.message
          : "Could not enhance the prompt",
    );
  }
}

/** The last custom instruction, offered again next time — they tend to repeat. */
const LAST_INSTRUCTION_KEY = "enhance-last-custom-instruction";

function readLastInstruction(): string {
  try {
    return localStorage.getItem(LAST_INSTRUCTION_KEY) ?? "";
  } catch {
    return "";
  }
}

function saveLastInstruction(value: string) {
  try {
    localStorage.setItem(LAST_INSTRUCTION_KEY, value);
  } catch {
    // Storage blocked: the instruction simply is not remembered.
  }
}

/**
 * The Enhance split button beside the prompt field.
 *
 * One click runs the default recipe for the current media type; the chevron
 * lists the rest. The result replaces the field, and the previous wording
 * rides on the toast's Undo — cheaper than a preview step and no extra click
 * on the happy path, which is the whole brief.
 *
 * "Custom instruction…" at the foot of the list swaps the menu for a text box:
 * a recipe written for this one prompt, run by the same model and not saved.
 */
export function PromptEnhanceButton({
  value,
  onReplace,
  context,
  className,
}: {
  value: string;
  onReplace: (text: string) => void;
  context: EnhanceContext;
  className?: string;
}) {
  const recipes = useQuery(api.enhanceRecipes.list);
  const settings = useQuery(api.enhanceRecipes.settings);
  const ensureSeeded = useMutation(api.enhanceRecipes.ensureSeeded);
  const setModel = useMutation(api.enhanceRecipes.setModel);
  const enhance = useAction(api.promptEnhance.enhance);
  const [open, setOpen] = React.useState(false);
  const [busy, setBusy] = React.useState<string | null>(null);
  const [customMode, setCustomMode] = React.useState(false);
  const [instruction, setInstruction] = React.useState("");
  const instructionRef = React.useRef<HTMLTextAreaElement>(null);

  // Straight into the box, with the remembered instruction selected so typing
  // replaces it and Enter reruns it.
  React.useEffect(() => {
    if (!customMode) return;
    const box = instructionRef.current;
    box?.focus();
    box?.select();
  }, [customMode]);

  // First visit: copy the built-ins in. Idempotent server-side, and only
  // fired once the settings query has confirmed there is nothing yet.
  const seeding = React.useRef(false);
  React.useEffect(() => {
    if (!settings || settings.seeded || seeding.current) return;
    seeding.current = true;
    void ensureSeeded().catch(() => {
      seeding.current = false;
    });
  }, [settings, ensureSeeded]);

  const listed = React.useMemo(
    () => recipesFor(recipes ?? [], context.media),
    [recipes, context.media],
  );
  const fallback = defaultRecipeFor(recipes ?? [], context.media);
  const model = getEnhanceModel(settings?.modelId);
  const trimmed = value.trim();

  const run = React.useCallback(
    async (recipe: Recipe) => {
      if (!trimmed || busy) return;
      setOpen(false);
      setBusy(recipe._id);
      await runEnhance(
        enhance,
        { prompt: trimmed, recipeId: recipe._id, context },
        recipe.title,
        onReplace,
      );
      setBusy(null);
    },
    [trimmed, busy, enhance, context, onReplace],
  );

  const runCustom = async () => {
    const text = instruction.trim();
    if (!trimmed || !text || busy) return;
    saveLastInstruction(text);
    setOpen(false);
    setBusy("custom");
    await runEnhance(
      enhance,
      { prompt: trimmed, instruction: text, context },
      "Custom instruction",
      onReplace,
    );
    setBusy(null);
  };

  const openCustom = () => {
    setInstruction(readLastInstruction());
    setCustomMode(true);
  };

  const disabled = !trimmed || busy !== null || !fallback;

  return (
    <div className={cn("inline-flex items-center", className)}>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="h-7 gap-1.5 rounded-r-none px-2 text-xs"
        disabled={disabled}
        title={
          !trimmed
            ? "Write something first"
            : fallback
              ? `Enhance with “${fallback.title}” · ${model.label}`
              : "No recipe for this media type"
        }
        onClick={() => fallback && void run(fallback)}
      >
        {busy ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
        ) : (
          <Sparkles className="h-3.5 w-3.5" />
        )}
        {busy ? "Enhancing" : "Enhance"}
      </Button>
      <Popover
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          // Every opening starts at the list; the text box is one click away.
          if (!next) setCustomMode(false);
        }}
      >
        <PopoverTrigger
          render={
            <Button
              type="button"
              variant="ghost"
              size="sm"
              aria-label="Choose an enhance recipe"
              className="h-7 w-6 rounded-l-none border-l border-border/60 px-0 text-xs"
              disabled={busy !== null}
            />
          }
        >
          <ChevronDown className="h-3.5 w-3.5" />
        </PopoverTrigger>
        <PopoverContent align="end" className="w-72 p-1">
          {customMode ? (
            <form
              className="space-y-2 p-1"
              onSubmit={(event) => {
                event.preventDefault();
                void runCustom();
              }}
            >
              <div className="flex items-center gap-1">
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label="Back to recipes"
                  onClick={() => setCustomMode(false)}
                >
                  <ArrowLeft />
                </Button>
                <span className="text-sm font-medium">Custom instruction</span>
              </div>
              <Textarea
                ref={instructionRef}
                value={instruction}
                maxLength={MAX_CUSTOM_INSTRUCTION}
                rows={4}
                placeholder="e.g. Add more visual details about the lighting and the setting"
                className="min-h-24 resize-none text-sm"
                onChange={(event) => setInstruction(event.target.value)}
                onKeyDown={(event) => {
                  // Enter runs, Shift+Enter breaks the line — a chat box's
                  // convention, and this is one sentence to a model.
                  if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                    event.preventDefault();
                    void runCustom();
                  }
                }}
              />
              <Button
                type="submit"
                size="sm"
                className="w-full gap-1.5"
                disabled={!trimmed || !instruction.trim()}
                title={trimmed ? undefined : "Write a prompt first"}
              >
                <Sparkles />
                Enhance
                <CornerDownLeft className="ml-auto opacity-60" />
              </Button>
            </form>
          ) : recipes === undefined ? (
            <div className="flex justify-center py-6">
              <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
            </div>
          ) : (
            <>
              {listed.length === 0 ? (
                <p className="px-3 py-6 text-center text-sm text-muted-foreground">
                  No recipes for {context.media} yet.
                </p>
              ) : (
                listed.map((recipe) => (
                  <button
                    key={recipe._id}
                    type="button"
                    disabled={!trimmed}
                    className="flex w-full items-center justify-between gap-2 rounded-sm px-2 py-1.5 text-left text-sm hover:bg-accent disabled:opacity-50"
                    onClick={() => void run(recipe)}
                  >
                    <span className="min-w-0">
                      <span className="block truncate">{recipe.title}</span>
                      <span className="block truncate text-xs text-muted-foreground">
                        {recipe.modelId
                          ? `Runs on ${getEnhanceModel(recipe.modelId).label} · `
                          : ""}
                        {recipe.instructions.split("\n")[0].replace(/\{\{\s*\w+\s*\}\}/g, "…")}
                      </span>
                    </span>
                    {recipe === fallback && (
                      <span className="shrink-0 text-[0.625rem] font-medium tracking-wide text-muted-foreground uppercase">
                        default
                      </span>
                    )}
                  </button>
                ))
              )}
              <div className="my-1 border-t" />
              <button
                type="button"
                className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm hover:bg-accent"
                onClick={openCustom}
              >
                <PenLine className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                <span className="min-w-0">
                  <span className="block truncate">Custom instruction…</span>
                  <span className="block truncate text-xs text-muted-foreground">
                    Tell the model what to change
                  </span>
                </span>
              </button>
            </>
          )}
          <div className="mt-1 flex items-center justify-between gap-2 border-t px-2 py-1.5 text-xs text-muted-foreground">
            {/* The same setting as /prompts → Recipes, switchable right here:
                when one model declines a prompt, the next try is one click.
                Native select — a nested popover would close this one. */}
            <label className="flex min-w-0 items-center gap-1" title={model.note}>
              <span className="shrink-0">Model</span>
              <select
                value={model.id}
                onChange={(event) =>
                  void setModel({ modelId: event.target.value }).catch((error: unknown) =>
                    toast.error(
                      error instanceof Error ? error.message : "Could not change the model",
                    ),
                  )
                }
                className="min-w-0 truncate rounded border bg-background px-1 py-0.5 text-xs text-foreground"
              >
                {ENHANCE_MODELS.map((option) => (
                  <option key={option.id} value={option.id}>
                    {option.provider === "atlas"
                      ? `${option.label} · Atlas`
                      : `${option.label} · subscription`}
                  </option>
                ))}
              </select>
            </label>
            <Link
              href="/prompts?tab=recipes"
              className="hover:underline"
              onClick={() => setOpen(false)}
            >
              Edit recipes →
            </Link>
          </div>
        </PopoverContent>
      </Popover>
    </div>
  );
}
