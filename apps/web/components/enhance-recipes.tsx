"use client";

import * as React from "react";
import { useMutation, useQuery } from "convex/react";
import { toast } from "sonner";
import { Loader2, Plus, RotateCcw, Trash2 } from "lucide-react";

import { api } from "@/convex/_generated/api";
import type { Doc } from "@/convex/_generated/dataModel";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { ENHANCE_MODELS, getEnhanceModel, type EnhanceMedia } from "@/lib/prompt-enhance";
import { cn } from "@/lib/utils";

const MEDIA_OPTIONS: { value: EnhanceMedia; label: string }[] = [
  { value: "any", label: "Any" },
  { value: "image", label: "Image" },
  { value: "video", label: "Video" },
];

/**
 * The recipes tab of /prompts: one model for everything at the top, then the
 * recipe cards. Same save-on-blur cards as the saved prompts next door, so the
 * two tabs behave alike.
 */
export function EnhanceRecipes() {
  const recipes = useQuery(api.enhanceRecipes.list);
  const settings = useQuery(api.enhanceRecipes.settings);
  const ensureSeeded = useMutation(api.enhanceRecipes.ensureSeeded);
  const setModel = useMutation(api.enhanceRecipes.setModel);
  const create = useMutation(api.enhanceRecipes.create);
  const restore = useMutation(api.enhanceRecipes.restoreBuiltins);
  const [isCreating, setIsCreating] = React.useState(false);

  const seeding = React.useRef(false);
  React.useEffect(() => {
    if (!settings || settings.seeded || seeding.current) return;
    seeding.current = true;
    void ensureSeeded().catch(() => {
      seeding.current = false;
    });
  }, [settings, ensureSeeded]);

  const model = getEnhanceModel(settings?.modelId);

  const addRecipe = React.useCallback(async () => {
    if (isCreating) return;
    setIsCreating(true);
    try {
      await create({
        title: "New recipe",
        media: "any",
        instructions:
          "Rewrite the prompt so that… (placeholders: {{targetModel}}, {{duration}}, {{aspectRatio}}, {{references}})",
      });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not create the recipe");
    }
    setIsCreating(false);
  }, [isCreating, create]);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3 rounded-lg border bg-card p-3">
        <div className="min-w-64 flex-1 space-y-1">
          <Label className="text-xs text-muted-foreground">Model for every recipe</Label>
          <SearchableSelect
            options={ENHANCE_MODELS.map((m) => ({
              value: m.id,
              label: m.provider === "atlas" ? `${m.label} · Atlas` : m.label,
              description: m.note,
            }))}
            value={model.id}
            onValueChange={(id) =>
              void setModel({ modelId: id }).catch((error: unknown) =>
                toast.error(error instanceof Error ? error.message : "Could not change the model"),
              )
            }
            className="w-full"
          />
          <p className="text-xs text-muted-foreground">
            {model.provider === "grok"
              ? "Billed to the Grok subscription. If it cannot answer, the same model on Atlas steps in."
              : `Billed to the Atlas balance — ${model.note.replace("Atlas · ", "")}.`}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            title="Add back any built-in recipe you deleted"
            onClick={() =>
              void restore()
                .then(({ added }) =>
                  toast.success(added ? `Restored ${added}` : "Nothing to restore"),
                )
                .catch((error: unknown) =>
                  toast.error(error instanceof Error ? error.message : "Could not restore"),
                )
            }
          >
            <RotateCcw className="h-3.5 w-3.5" />
            Restore built-ins
          </Button>
          <Button size="sm" onClick={() => void addRecipe()} disabled={isCreating}>
            {isCreating ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Plus className="h-3.5 w-3.5" />
            )}
            New recipe
          </Button>
        </div>
      </div>

      {recipes === undefined ? (
        <div className="flex justify-center py-24">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      ) : recipes.length === 0 ? (
        <div className="rounded-lg border border-dashed py-24 text-center">
          <p className="text-lg">No recipes</p>
          <p className="mt-1 text-sm text-muted-foreground">Add one, or restore the built-ins.</p>
        </div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2">
          {recipes.map((recipe) => (
            <RecipeCard key={recipe._id} recipe={recipe} />
          ))}
        </div>
      )}

      <p className="text-xs text-muted-foreground">
        Placeholders a recipe may use: <code>{"{{targetModel}}"}</code>, <code>{"{{media}}"}</code>,{" "}
        <code>{"{{duration}}"}</code>, <code>{"{{durationFallback}}"}</code>,{" "}
        <code>{"{{aspectRatio}}"}</code>, <code>{"{{references}}"}</code>,{" "}
        <code>{"{{h3Inputs}}"}</code> (MiniMax H3 frames and references). They are filled from the
        generation form when the button is pressed; house rules (English, prompt only, no questions)
        are appended to every recipe.
      </p>
    </div>
  );
}

function RecipeCard({ recipe }: { recipe: Doc<"enhanceRecipes"> }) {
  const update = useMutation(api.enhanceRecipes.update);
  const remove = useMutation(api.enhanceRecipes.remove);

  const [title, setTitle] = React.useState(recipe.title);
  const [instructions, setInstructions] = React.useState(recipe.instructions);
  // Dirtiness is measured against the last server state this card adopted,
  // not the live prop: otherwise a remote edit to an untouched card would
  // flip it to "unsaved" with stale text, and the next blur would write that
  // stale text back over the remote edit.
  const [synced, setSynced] = React.useState({
    title: recipe.title,
    instructions: recipe.instructions,
  });
  const dirty = title !== synced.title || instructions !== synced.instructions;

  // Adopt a server change to an untouched card. Done while rendering, against
  // the server values last seen, rather than in an effect that read a ref during
  // render — which kept React Compiler off this card entirely. A change that
  // lands while the card is dirty is skipped, as before; the edit's own save is
  // what syncs it.
  const [seen, setSeen] = React.useState({
    title: recipe.title,
    instructions: recipe.instructions,
  });
  if (seen.title !== recipe.title || seen.instructions !== recipe.instructions) {
    const server = { title: recipe.title, instructions: recipe.instructions };
    setSeen(server);
    if (!dirty) {
      setSynced(server);
      setTitle(server.title);
      setInstructions(server.instructions);
    }
  }

  React.useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  const deleting = React.useRef(false);

  const fail = (error: unknown, fallback: string) =>
    toast.error(error instanceof Error ? error.message : fallback);

  const commit = React.useCallback(async () => {
    if (!dirty || deleting.current) return;
    try {
      await update({ id: recipe._id, title, instructions });
      setSynced({ title, instructions });
    } catch (error) {
      fail(error, "Could not save");
      setTitle(synced.title);
      setInstructions(synced.instructions);
    }
  }, [dirty, title, instructions, synced, recipe._id, update]);

  return (
    <div className="flex flex-col gap-2 rounded-lg border bg-card p-3">
      <div className="flex items-center gap-1">
        <Input
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          onBlur={() => void commit()}
          aria-label="Recipe title"
          className="h-8 border-0 bg-transparent px-0 text-sm font-medium shadow-none focus-visible:ring-0"
        />
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8 shrink-0 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
          title="Delete recipe"
          onMouseDown={() => {
            deleting.current = true;
          }}
          onClick={() => {
            if (!window.confirm(`Delete "${title}"?`)) {
              deleting.current = false;
              return;
            }
            void remove({ id: recipe._id }).catch((error: unknown) => {
              deleting.current = false;
              fail(error, "Could not delete");
            });
          }}
        >
          <Trash2 className="h-4 w-4" />
          <span className="sr-only">Delete recipe</span>
        </Button>
      </div>

      <Textarea
        value={instructions}
        onChange={(event) => setInstructions(event.target.value)}
        onBlur={() => void commit()}
        aria-label="Recipe instructions"
        rows={8}
        className="resize-y font-mono text-xs"
      />

      <div className="flex flex-wrap items-center gap-3 text-xs">
        <div className="inline-flex overflow-hidden rounded-md border">
          {MEDIA_OPTIONS.map((option) => (
            <button
              key={option.value}
              type="button"
              className={cn(
                "px-2 py-1 transition-colors",
                recipe.media === option.value
                  ? "bg-primary text-primary-foreground"
                  : "hover:bg-accent",
              )}
              onClick={() =>
                void update({ id: recipe._id, media: option.value }).catch((error: unknown) =>
                  fail(error, "Could not change media"),
                )
              }
            >
              {option.label}
            </button>
          ))}
        </div>
        <label className="ml-auto inline-flex items-center gap-2">
          <span className="text-muted-foreground">Default for {recipe.media}</span>
          <Switch
            size="sm"
            checked={recipe.isDefault}
            onCheckedChange={(checked) =>
              void update({ id: recipe._id, isDefault: checked }).catch((error: unknown) =>
                fail(error, "Could not change default"),
              )
            }
          />
        </label>
      </div>
      <label className="flex items-center gap-2 text-xs">
        <span className="shrink-0 text-muted-foreground">Model</span>
        <select
          value={recipe.modelId ?? ""}
          onChange={(event) =>
            void update({ id: recipe._id, modelId: event.target.value }).catch((error: unknown) =>
              fail(error, "Could not change the model"),
            )
          }
          className="min-w-0 flex-1 truncate rounded border bg-background px-1.5 py-1 text-xs"
        >
          <option value="">Same as every recipe</option>
          {ENHANCE_MODELS.map((option) => (
            <option key={option.id} value={option.id}>
              {option.provider === "atlas"
                ? `${option.label} · Atlas`
                : `${option.label} · subscription`}
            </option>
          ))}
        </select>
      </label>
      {dirty && <p className="text-xs text-muted-foreground">Unsaved — click away to save.</p>}
    </div>
  );
}
