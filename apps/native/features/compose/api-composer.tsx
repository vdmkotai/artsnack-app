import { useQuery } from "convex/react";
import { router, useFocusEffect } from "expo-router";
import { useCallback, useEffect, useState } from "react";
import { Keyboard, Pressable, ScrollView, Text, View } from "react-native";

import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { useTabBarInset } from "@/features/ui/insets";
import { higgsfieldVideoModel } from "@/lib/api-models";
import {
  atlasFamilyReadsTags,
  atlasFrameSlots,
  atlasReferenceHint,
  atlasVariants,
  atlasMaxReferences,
  resolveAtlasVariant,
} from "@/lib/atlas-models";
import { activeAtlasParams, withAtlasModel } from "@/lib/normalize-form";
import { Action } from "@/features/tools/controls";
import { referenceProfileFor } from "@/lib/reference-profile";
import { colors, CONTINUOUS, TABULAR } from "@/theme/colors";

import { useComposerContext } from "./context";
import { takeHandoff } from "./handoff-store";
import { openPrompt } from "./open-prompt";
import { PromptField } from "./prompt-field";
import { ReferenceStrip } from "./reference-strip";
import { SettingsSummary } from "./settings-summary";

/**
 * The hosted-provider composer: a prompt, its references, and what the settings
 * panel is set to.
 *
 * State comes from the context, never from a second `useComposer()` call: the
 * engine sheet and the settings panel are separate routes editing this same form,
 * and a private copy here is what used to leave the header showing Seedream after
 * Grok had been picked.
 */
export function ApiComposer() {
  const { api: composer } = useComposerContext();
  const { form, setForm, model, references } = composer;
  const tabBar = useTabBarInset();

  // Picked up on focus rather than on mount: the Create tab stays mounted, so a
  // handoff arriving from the Library would otherwise sit unread until the app
  // restarted.
  const [reproduceId, setReproduceId] = useState<Id<"grokGenerations"> | null>(null);
  useFocusEffect(
    useCallback(() => {
      const handoff = takeHandoff("reference", "references", "reproduceId");
      // `addReference`, never `setReferences([...composer.references, …])`: this
      // callback's dependency list is empty — it has to be, or the handoff would be
      // re-consumed on every change — so `composer.references` here is frozen at the
      // first render and appending to it dropped whatever had been attached since.
      if (handoff.reference) composer.addReference(handoff.reference);
      for (const reference of handoff.references ?? []) composer.addReference(reference);
      if (handoff.reproduceId) setReproduceId(handoff.reproduceId);
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []),
  );

  // The row is fetched rather than carried, so the settings restored are the
  // current ones — the web makes the same choice for the same reason.
  const source = useQuery(api.grokGenerations.get, reproduceId ? { id: reproduceId } : "skip");
  useEffect(() => {
    if (!source || !reproduceId) return;
    setReproduceId(null);
    // The whole row: reproduce is a faithful restore — provider, model, Atlas
    // parameter bag and references included — exactly as on the web.
    void composer.reproduce(source);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source, reproduceId]);

  const isImage = form.mediaType === "image";
  const variants = composer.atlasModel ? atlasVariants(composer.atlasModel) : {};
  const inputModes =
    !isImage && variants.image && variants.reference
      ? { frames: variants.image, references: variants.reference }
      : null;

  // Higgsfield's video models are not interchangeable: only the Seedance pair
  // takes a reference list, and a frame model takes one media input per slot —
  // the aggregate cap of 9 would offer slots the vendor rejects. Forced off
  // under Atlas, where `model` is the dormant registry entry. Same derivation
  // as the web form.
  const hfVideo =
    !composer.atlasModel && !isImage && model.video.kind === "higgsfield-video"
      ? higgsfieldVideoModel(model.video, form.videoJobType)
      : null;
  const videoMaxReferences = hfVideo
    ? hfVideo.supportsReferences
      ? hfVideo.maxReferences
      : (hfVideo.supportsStartFrame ? 1 : 0) + (hfVideo.supportsEndFrame ? 1 : 0)
    : model.video.maxReferences;
  // Atlas declares its slots per model: `image` + `last_image` is a first/last
  // pair, where a counted badge would describe an ordering the vendor does not
  // have. Higgsfield frame models get the same treatment.
  const frameSlots = composer.atlasModel
    ? atlasFrameSlots(composer.atlasModel)
    : hfVideo && !hfVideo.supportsReferences
      ? [
          ...(hfVideo.supportsStartFrame ? ["Start"] : []),
          ...(hfVideo.supportsEndFrame ? ["End"] : []),
        ]
      : null;

  const submit = () =>
    void composer.submit().then((started) => {
      // Straight to where the result will appear. Watching a form you have
      // finished with is not the job.
      if (started) router.navigate("/(tabs)/(library)");
    });

  return (
    <>
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={{
          paddingHorizontal: 17,
          paddingTop: 10,
          paddingBottom: 24,
          gap: 13,
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
        {/* One prompt here, and only one: the hosted providers take no negative
            prompt, so showing an empty field for it would promise a control that
            does not reach them. */}
        <PromptField
          label="PROMPT"
          value={form.prompt}
          placeholder="Describe what to make…"
          collapsedLines={6}
          onPress={() => openPrompt("prompt")}
        />

        <ReferenceStrip
          references={references}
          issues={composer.referenceIssues}
          // Atlas states its own capacity per model, and it is not derivable
          // from the registry entry — `model` is whichever legacy model was
          // last chosen and is dormant while Atlas drives the form.
          max={composer.maxReferences ?? (isImage ? model.image.maxReferences : videoMaxReferences)}
          // Without this the strip's own picker defaulted to fal's box — 2048px and
          // 4MB — and xAI rejects a reference over 768px or 400KB outright, so
          // attaching from the library while on Grok produced a failed generation.
          // `attachReference` already resolved the profile per provider; the picker
          // was the path that did not. Keyed on the form's provider for the same
          // reason as the cap above.
          profile={referenceProfileFor(form.provider)}
          slots={frameSlots}
          // A "none"-dialect Atlas model parses nothing out of the prompt, so
          // the badge counts instead of advertising a tag the vendor would
          // receive as literal text.
          tagged={composer.atlasModel ? atlasFamilyReadsTags(composer.atlasModel) : true}
          hint={
            composer.atlasModel && composer.maxReferences !== undefined
              ? atlasReferenceHint(composer.atlasModel, composer.maxReferences)
              : null
          }
          onChange={composer.setReferences}
        />
        {references.length > 0 && (
          <Text style={{ color: colors.labelTertiary, fontSize: 12 }}>
            Tap a reference to include or exclude it. Hold to reorder. References stay until you
            remove them.
          </Text>
        )}
        {inputModes && (
          <View style={{ gap: 7 }}>
            <Action
              label={`${composer.atlasModel?.id === inputModes.frames.id ? "✓ " : ""}Use Start / End frames`}
              disabled={
                composer.selectedReferences.length > atlasMaxReferences(inputModes.frames) ||
                resolveAtlasVariant(
                  inputModes.frames,
                  composer.selectedReferences.length,
                  form.prompt,
                  activeAtlasParams(form),
                ).id !== inputModes.frames.id
              }
              onPress={() => setForm(withAtlasModel(form, inputModes.frames))}
            />
            <Action
              label={`${composer.atlasModel?.id === inputModes.references.id ? "✓ " : ""}Use reference images`}
              onPress={() => setForm(withAtlasModel(form, inputModes.references))}
            />
          </View>
        )}

        <SettingsSummary />
      </ScrollView>

      <View
        style={{
          paddingHorizontal: 17,
          paddingTop: 8,
          // The whole reason the tab bar had to become a JS one: this number did
          // not exist before, and the button sat behind the bar.
          paddingBottom: tabBar + 10,
        }}
      >
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
            flexDirection: "row",
            gap: 9,
            backgroundColor: composer.canSubmit ? colors.accent : colors.fill,
            opacity: pressed ? 0.8 : 1,
            ...CONTINUOUS,
          })}
        >
          <Text
            style={{
              fontSize: 17,
              fontWeight: "600",
              color: composer.canSubmit ? colors.onAccent : colors.labelTertiary,
            }}
          >
            {composer.submitting ? "Starting…" : "Generate"}
          </Text>
          {/* The price is on the button because that is the last place it can
              still change anything. */}
          <Text
            style={{
              fontSize: 15,
              opacity: 0.55,
              color: composer.canSubmit ? colors.onAccent : colors.labelTertiary,
              ...TABULAR,
            }}
          >
            · {composer.priceLabel}
          </Text>
        </Pressable>
      </View>
    </>
  );
}
