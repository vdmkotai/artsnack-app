import { useQuery } from "convex/react";
import { router, useFocusEffect } from "expo-router";
import { useCallback, useEffect, useState } from "react";
import { Alert, Keyboard, Pressable, ScrollView, Text, View } from "react-native";

import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { useComposerContext } from "@/features/compose/context";
import { takeHandoff } from "@/features/compose/handoff-store";
import { openPrompt } from "@/features/compose/open-prompt";
import { PromptField } from "@/features/compose/prompt-field";
import { SettingsSummary } from "@/features/compose/settings-summary";
import { useTabBarInset } from "@/features/ui/insets";
import { colors } from "@/theme/colors";

/**
 * The self-hosted composer: the two prompts, and what the settings panel is set
 * to.
 *
 * The negative prompt is on the screen rather than on the panel on purpose. It
 * costs nothing and changes everything, and here it is edited about as often as
 * the prompt itself — providers take none, which is why it exists only here.
 */
export function LocalComposer() {
  const { local: composer } = useComposerContext();
  // No `setForm` here any more: both prompts are written by the editor modal, which
  // reaches the same form through the provider on this tab's layout.
  const { form, catalog } = composer;
  const tabBar = useTabBarInset();

  /**
   * Picked up on focus: this composer stays mounted, so a Recreate from the viewer
   * would otherwise go unread.
   *
   * The dependency list is empty on purpose: an effect that re-ran when the
   * catalogue arrived would be a second chance to consume a payload that had
   * landed in between.
   */
  const [recreateId, setRecreateId] = useState<Id<"generations"> | null>(null);
  useFocusEffect(
    useCallback(() => {
      const handoff = takeHandoff("recreateLocalId");
      if (handoff.recreateLocalId) setRecreateId(handoff.recreateLocalId);
    }, []),
  );

  // Recreate. The row is fetched rather than carried, so what lands in the form
  // is the generation as it is now — the same choice the API composer makes.
  const source = useQuery(api.generations.getById, recreateId ? { id: recreateId } : "skip");
  useEffect(() => {
    if (!source || !recreateId) return;
    setRecreateId(null);
    const missing = composer.recreate(source.formState);
    if (missing.length > 0) {
      Alert.alert("Restored, with gaps", missing.join("\n"));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source, recreateId]);

  const submit = () =>
    void composer.submit().then((started) => {
      if (started) router.navigate("/(tabs)/(library)");
    });

  /** Why Generate is off, in the order the user can act on. */
  const blocker = composer.submitting
    ? null
    : form.prompt.trim().length === 0
      ? null // The empty prompt speaks for itself; the field is right there.
      : catalog === null
        ? "Waiting for the pod to answer."
        : catalog.error
          ? "No pod is answering, so there is nothing to generate on."
          : !catalog.checkpoints.includes(form.checkpoint)
            ? `“${form.checkpoint.replace(/\.(safetensors|ckpt)$/i, "") || "None"}” is not installed on this pod — pick another in Settings.`
            : form.loras.some((slot) => slot.enabled && !catalog.loras.includes(slot.loraName))
              ? "A LoRA in the chain is not installed on this pod."
              : null;

  return (
    <>
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={{
          paddingHorizontal: 17,
          paddingTop: 10,
          paddingBottom: 24,
          gap: 12,
        }}
        keyboardShouldPersistTaps="handled"
        // `on-drag`, never `interactive`: interactive dismissal is reversible, so
        // dragging down took the keyboard away and dragging back up brought it
        // straight back — which read as the keyboard appearing from nothing but
        // scrolling. Dismissing on the first drag also drops focus, so a second
        // drag over the prompt field cannot re-open it.
        keyboardDismissMode="on-drag"
        onScrollBeginDrag={() => Keyboard.dismiss()}
      >
        <BackendLine online={composer.online} detail={catalog?.error} onRetry={composer.refresh} />

        {/* Both prompts are always on screen and always labelled. The negative one
            was a single unlabelled line, which was indistinguishable from the
            placeholder of an empty positive one — and neither can be typed into
            here: they open an editor. See compose/prompt-field.tsx. */}
        <PromptField
          label="PROMPT"
          value={form.prompt}
          placeholder="Describe what to make…"
          collapsedLines={6}
          onPress={() => openPrompt("prompt")}
        />
        <PromptField
          label="NEGATIVE PROMPT"
          value={form.negativePrompt}
          placeholder="What to avoid — artefacts, styles, watermarks…"
          collapsedLines={3}
          tone="muted"
          onPress={() => openPrompt("negative")}
        />

        <SettingsSummary />

        {composer.error ? (
          <Text selectable style={{ color: colors.danger, fontSize: 14 }}>
            {composer.error}
          </Text>
        ) : null}
      </ScrollView>

      <View style={{ paddingHorizontal: 17, paddingTop: 8, paddingBottom: tabBar + 10, gap: 7 }}>
        {/* A disabled button with no explanation is the same as a broken one, and with
            the pod off this one is disabled every time. */}
        {blocker ? (
          <Text style={{ color: colors.labelTertiary, fontSize: 12.5, textAlign: "center" }}>
            {blocker}
          </Text>
        ) : null}
        <Pressable
          onPress={() => {
            Keyboard.dismiss();
            submit();
          }}
          disabled={!composer.canSubmit}
          style={({ pressed }) => ({
            height: 52,
            borderRadius: 26,
            alignItems: "center",
            justifyContent: "center",
            backgroundColor: composer.canSubmit ? colors.accent : colors.fill,
            opacity: pressed ? 0.8 : 1,
          })}
        >
          <Text
            style={{
              fontSize: 17,
              fontWeight: "600",
              color: composer.canSubmit ? colors.onAccent : colors.labelTertiary,
            }}
          >
            {composer.submitting ? "Starting…" : "Generate · free"}
          </Text>
        </Pressable>
      </View>
    </>
  );
}

/** Honest, and rechecked whenever the screen comes back. */
function BackendLine({
  online,
  detail,
  onRetry,
}: {
  online: boolean;
  detail?: string;
  onRetry: () => void;
}) {
  return (
    <Pressable
      onPress={onRetry}
      style={{ flexDirection: "row", alignItems: "center", gap: 8, paddingVertical: 2 }}
    >
      <View
        style={{
          width: 7,
          height: 7,
          borderRadius: 4,
          backgroundColor: online ? colors.working : colors.labelQuaternary,
        }}
      />
      <Text style={{ color: colors.labelSecondary, fontSize: 12.5, flex: 1 }} numberOfLines={1}>
        {online ? "Backend online" : (detail ?? "Checking the backend…")}
      </Text>
      <Text style={{ color: colors.labelTertiary, fontSize: 12.5 }}>Recheck</Text>
    </Pressable>
  );
}
