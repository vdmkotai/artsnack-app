import { Stack, router } from "expo-router";
import { Keyboard, KeyboardAvoidingView, View } from "react-native";

import { ApiComposer } from "@/features/compose/api-composer";
import { IconChip } from "@/features/compose/chips";
import { useComposerContext } from "@/features/compose/context";
import { LocalComposer } from "@/features/local/local-composer";
import { PickerPill } from "@/features/ui/option-picker";

/**
 * The composer.
 *
 * Which one is a choice, not a route: the self-hosted form and the hosted-provider
 * form are two faces of the same tab, and the engine sheet switches between them.
 * Making the local composer a pushed screen — as it was — meant the header pill
 * lied about which engine was live, and gave the tab a back button it had no
 * business having.
 */
export default function CreateScreen() {
  const { engine, api, local } = useComposerContext();
  const isLocal = engine === "local";

  // Leaving the prompt for a sheet means you are done typing. Without this the
  // keyboard stayed up over whatever opened next.
  const go = (href: "/engine" | "/prompts") => {
    Keyboard.dismiss();
    router.push(href);
  };

  return (
    <KeyboardAvoidingView behavior="padding" style={{ flex: 1 }}>
      <Stack.Screen
        options={{
          // No large title: it was an empty band across the top of the one screen
          // in the app with no room to spare. The engine — the single most
          // consequential choice here — takes the space instead.
          headerLargeTitle: false,
          title: "",
          headerLeft: () => (
            <PickerPill
              label={isLocal ? "Local · ComfyUI" : (api.atlasModel?.label ?? api.model.label)}
              onPress={() => go("/engine")}
            />
          ),
          headerRight: () => (
            <View style={{ flexDirection: "row", gap: 8 }}>
              <IconChip
                symbol="wrench.and.screwdriver"
                accessibilityLabel="Tools"
                onPress={() => {
                  Keyboard.dismiss();
                  router.push("/tools");
                }}
              />
              <IconChip
                symbol="bookmark"
                accessibilityLabel="Saved prompts"
                onPress={() => go("/prompts")}
              />
              {/* Every generation setting lives on one panel, reached from the
                  summary line under the prompt — see settings-summary.tsx. This
                  is the one action the panel cannot hold. */}
              {isLocal ? (
                <IconChip
                  symbol="arrow.clockwise"
                  accessibilityLabel="Recheck the backend"
                  onPress={() => {
                    Keyboard.dismiss();
                    local.refresh();
                  }}
                />
              ) : null}
            </View>
          ),
        }}
      />
      {isLocal ? <LocalComposer /> : <ApiComposer />}
    </KeyboardAvoidingView>
  );
}
