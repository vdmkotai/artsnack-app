import { useMutation, useQuery } from "convex/react";
import * as Haptics from "expo-haptics";
import { router } from "expo-router";
import { SearchField } from "heroui-native";
import { useCallback, useMemo, useState } from "react";
import { Alert, Pressable, ScrollView, Text, View } from "react-native";

import type { Id } from "@/convex/_generated/dataModel";
import { api } from "@/convex/_generated/api";
import { useComposerContext } from "@/features/compose/context";
import { Row, Section } from "@/features/compose/rows";
import { colors } from "@/theme/colors";

/**
 * Saved prompts.
 *
 * There is no prompts screen on iOS: `/prompts` exists on the web only because a
 * popover cannot host editing, and a sheet can. Saving lives here and on the
 * composer's header, next to the text it saves.
 *
 * A tap replaces the field and says so with an undo, which is what the web does
 * deliberately. Long press offers the other ways in, plus edit and delete.
 */
export default function PromptsSheet() {
  const prompts = useQuery(api.savedPrompts.list) ?? [];
  const remove = useMutation(api.savedPrompts.remove);
  const update = useMutation(api.savedPrompts.update);
  const save = useMutation(api.savedPrompts.save);

  /**
   * Whichever composer is live, not always the hosted one.
   *
   * This sheet is reached from the Create tab's header, which is shown for both
   * engines — but it used to read and write `context.api` unconditionally. On the
   * self-hosted composer that meant inserting a prompt updated a form nobody was
   * looking at (the field on screen did not change), and "Save current prompt" filed
   * whatever the hosted form happened to hold, usually nothing.
   */
  const { engine, api: hosted, local } = useComposerContext();
  const prompt = engine === "local" ? local.form.prompt : hosted.form.prompt;
  const setPrompt = useCallback(
    (text: string) => {
      if (engine === "local") local.setForm({ prompt: text });
      else hosted.setForm({ prompt: text });
    },
    [engine, local, hosted],
  );

  const [filter, setFilter] = useState("");

  const visible = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    if (!needle) return prompts;
    return prompts.filter(
      (entry) =>
        entry.title.toLowerCase().includes(needle) || entry.text.toLowerCase().includes(needle),
    );
  }, [prompts, filter]);

  const insert = (text: string) => {
    const previous = prompt;
    setPrompt(text);
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    router.back();
    if (previous.trim().length > 0) {
      // The web shows a toast with Undo for exactly this. Replacing silently is
      // the one behaviour that could lose work.
      setTimeout(
        () =>
          Alert.alert("Prompt replaced", undefined, [
            { text: "Keep" },
            { text: "Undo", onPress: () => setPrompt(previous) },
          ]),
        250,
      );
    }
  };

  const optionsFor = (saved: { _id: Id<"savedPrompts">; title: string; text: string }) => {
    Alert.alert(saved.title, saved.text.slice(0, 200), [
      { text: "Replace", onPress: () => insert(saved.text) },
      {
        text: "Append to end",
        onPress: () => {
          setPrompt([prompt.trim(), saved.text].filter(Boolean).join(", "));
          router.back();
        },
      },
      {
        // The one thing a saved prompt could not do from here: a typo meant
        // deleting it and typing the whole thing again. `update`, not `save` —
        // saving the edited text would have filed a second copy beside the
        // original rather than replacing it.
        text: "Edit text",
        onPress: () =>
          Alert.prompt(
            "Edit prompt",
            saved.title,
            (text) => {
              const trimmed = text?.trim();
              if (!trimmed || trimmed === saved.text) return;
              void update({ id: saved._id, text: trimmed }).catch((error: unknown) =>
                Alert.alert(
                  "Could not save",
                  error instanceof Error ? error.message : "Unknown error",
                ),
              );
            },
            "plain-text",
            saved.text,
          ),
      },
      {
        text: "Delete",
        style: "destructive",
        onPress: () => void remove({ id: saved._id }),
      },
      { text: "Cancel", style: "cancel" },
    ]);
  };

  return (
    <ScrollView
      contentInsetAdjustmentBehavior="automatic"
      contentContainerStyle={{ paddingHorizontal: 16, paddingTop: 8, paddingBottom: 40 }}
      keyboardShouldPersistTaps="handled"
    >
      <View style={{ paddingBottom: 14 }}>
        <SearchField value={filter} onChange={setFilter}>
          <SearchField.Group>
            <SearchField.SearchIcon />
            <SearchField.Input placeholder="Filter saved prompts" autoCorrect={false} />
            <SearchField.ClearButton />
          </SearchField.Group>
        </SearchField>
      </View>

      <Section>
        <Row
          label="Save current prompt"
          detail={prompt.trim().length > 0 ? prompt.trim().slice(0, 60) : "Nothing typed"}
          onPress={() => {
            const text = prompt.trim();
            if (text.length === 0) {
              Alert.alert("Nothing to save", "Type a prompt first.");
              return;
            }
            // The mutation directly rather than the hosted composer's `savePrompt`,
            // which reads its own form: on the self-hosted engine that filed the
            // wrong text, or nothing at all.
            void save({ text }).then(
              () => void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success),
              (error: unknown) =>
                Alert.alert(
                  "Could not save",
                  error instanceof Error ? error.message : "Unknown error",
                ),
            );
          }}
        />
      </Section>

      <Section footer="Tap replaces the field. Long press for append, or to delete.">
        {visible.length === 0 ? (
          <View style={{ padding: 16 }}>
            <Text style={{ color: colors.labelTertiary, fontSize: 15 }}>
              {prompts.length === 0 ? "Nothing saved yet." : "No matches."}
            </Text>
          </View>
        ) : (
          visible.map((entry) => (
            <Pressable
              key={entry._id}
              onPress={() => insert(entry.text)}
              onLongPress={() => optionsFor(entry)}
              style={({ pressed }) => ({
                paddingHorizontal: 16,
                paddingVertical: 12,
                backgroundColor: pressed ? colors.surfaceRaised : "transparent",
              })}
            >
              <Text style={{ color: colors.label, fontSize: 16 }} numberOfLines={1}>
                {entry.title}
              </Text>
              <Text
                style={{ color: colors.labelTertiary, fontSize: 13, marginTop: 2 }}
                numberOfLines={1}
              >
                {entry.text}
              </Text>
            </Pressable>
          ))
        )}
      </Section>
    </ScrollView>
  );
}
