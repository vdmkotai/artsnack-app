import { useAction, useMutation, useQuery } from "convex/react";
import { useEffect, useState } from "react";
import { View } from "react-native";
import { api } from "@/convex/_generated/api";
import type { Doc } from "@/convex/_generated/dataModel";
import { useComposerContext } from "@/features/compose/context";
import { OptionPicker } from "@/features/ui/option-picker";
import { SettingSegments } from "@/features/ui/setting-rows";
import { ENHANCE_MODELS, type EnhanceMedia } from "@/lib/prompt-enhance";
import { Action, Field, Note, confirm, useTask } from "./controls";

export function Recipes() {
  const recipes = useQuery(api.enhanceRecipes.list);
  const settings = useQuery(api.enhanceRecipes.settings);
  const seed = useMutation(api.enhanceRecipes.ensureSeeded);
  const setModel = useMutation(api.enhanceRecipes.setModel);
  const create = useMutation(api.enhanceRecipes.create);
  const update = useMutation(api.enhanceRecipes.update);
  const remove = useMutation(api.enhanceRecipes.remove);
  const restore = useMutation(api.enhanceRecipes.restoreBuiltins);
  const enhance = useAction(api.promptEnhance.enhance);
  const { engine, api: composer, local } = useComposerContext();
  const [editing, setEditing] = useState<Doc<"enhanceRecipes"> | "new" | null>(null);
  const [title, setTitle] = useState("");
  const [instructions, setInstructions] = useState("");
  const [media, setMedia] = useState<EnhanceMedia>("any");
  const [result, setResult] = useState<Awaited<ReturnType<typeof enhance>> | null>(null);
  const task = useTask();
  const [seedError, setSeedError] = useState("");
  useEffect(() => {
    void seed({}).catch((e: unknown) => setSeedError(String(e)));
  }, [seed]);
  const open = (recipe: Doc<"enhanceRecipes"> | "new") => {
    setEditing(recipe);
    setTitle(recipe === "new" ? "" : recipe.title);
    setInstructions(recipe === "new" ? "" : recipe.instructions);
    setMedia(recipe === "new" ? "any" : recipe.media);
  };
  const activeMedia = engine === "local" ? "image" : composer.form.mediaType;
  const prompt = engine === "local" ? local.form.prompt : composer.form.prompt;
  return (
    <View style={{ gap: 12 }}>
      {seedError !== "" && <Note>{seedError}</Note>}
      <OptionPicker
        title="Prompt enhancement model"
        selectedKey={settings?.modelId ?? ""}
        items={ENHANCE_MODELS.map((m) => ({
          key: m.id,
          label: m.label,
          description: m.note,
          value: m.id,
        }))}
        onSelect={(modelId) => void task.run(() => setModel({ modelId }))}
      />
      {editing ? (
        <>
          <Field label="Recipe title" value={title} onChange={setTitle} />
          <Field label="Instructions" value={instructions} onChange={setInstructions} multiline />
          <SettingSegments
            values={["any", "image", "video"] as const}
            value={media}
            onChange={setMedia}
          />
          <Note>
            Placeholders:{" "}
            {
              "{{media}}, {{targetModel}}, {{duration}}, {{durationFallback}}, {{aspectRatio}}, {{references}}"
            }
          </Note>
          <Action
            label="Save recipe"
            disabled={task.busy || !title.trim() || !instructions.trim()}
            onPress={() =>
              void task.run(async () => {
                if (editing === "new") await create({ title, instructions, media });
                else await update({ id: editing._id, title, instructions, media });
                setEditing(null);
              })
            }
          />
          <Action label="Cancel editing" onPress={() => setEditing(null)} />
        </>
      ) : (
        <Action label="New recipe" onPress={() => open("new")} />
      )}
      {result && (
        <>
          <Note>{result.text}</Note>
          <Note>
            {result.model.label}
            {result.costUsd === undefined ? "" : ` · $${result.costUsd.toFixed(4)}`}
            {result.fellBack ? " · used Atlas fallback" : ""}
          </Note>
          <Action
            label="Use enhanced prompt"
            onPress={() => {
              if (engine === "local") local.setForm({ prompt: result.text });
              else composer.setForm({ prompt: result.text });
              setResult(null);
            }}
          />
          <Action label="Discard result" onPress={() => setResult(null)} />
        </>
      )}
      {(recipes ?? []).map((recipe) => (
        <View key={recipe._id} style={{ gap: 7, marginTop: 12 }}>
          <Note>
            {recipe.title} · {recipe.media}
            {recipe.isDefault ? " · default" : ""}
          </Note>
          <Action
            label={`Enhance with ${recipe.title}`}
            disabled={
              task.busy ||
              !prompt.trim() ||
              (recipe.media !== "any" && recipe.media !== activeMedia)
            }
            onPress={() =>
              void task.run(async () =>
                setResult(
                  await enhance({
                    recipeId: recipe._id,
                    prompt,
                    context: {
                      media: activeMedia,
                      targetModel:
                        engine === "local"
                          ? local.form.checkpoint
                          : (composer.atlasModel?.label ?? composer.model.label),
                      duration: activeMedia === "video" ? composer.form.duration : undefined,
                      aspectRatio: engine === "api" ? composer.form.aspectRatio : undefined,
                      referenceCount: engine === "api" ? composer.selectedReferences.length : 0,
                    },
                  }),
                ),
              )
            }
          />
          <View style={{ gap: 6 }}>
            <Action label={`Edit ${recipe.title}`} onPress={() => open(recipe)} />
            <Action
              label={recipe.isDefault ? "Remove default" : "Make default"}
              disabled={task.busy}
              onPress={() =>
                void task.run(() => update({ id: recipe._id, isDefault: !recipe.isDefault }))
              }
            />
            <Action
              label={`Delete ${recipe.title}`}
              destructive
              disabled={task.busy}
              onPress={() =>
                confirm(
                  "Delete recipe",
                  recipe.title,
                  () => void task.run(() => remove({ id: recipe._id })),
                  true,
                )
              }
            />
          </View>
        </View>
      ))}
      <Action
        label="Restore built-in recipes"
        disabled={task.busy}
        onPress={() => void task.run(() => restore({}))}
      />
    </View>
  );
}
