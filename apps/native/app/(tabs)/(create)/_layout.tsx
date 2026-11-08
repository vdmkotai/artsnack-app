import Stack from "expo-router/stack";

import { colors } from "@/theme/colors";

/**
 * A form sheet gets an opaque header rather than the inherited transparent-blur
 * one: blur over a sheet that is itself an opaque surface reads as a seam, and
 * the first row of content used to slide under it.
 */
const SHEET = {
  presentation: "formSheet",
  sheetGrabberVisible: true,
  headerTransparent: false,
  headerStyle: { backgroundColor: colors.background },
  headerShadowVisible: false,
  contentStyle: { backgroundColor: colors.background },
} as const;

export default function CreateLayout() {
  return (
    <Stack
      screenOptions={{
        // No large title anywhere: it is a band of empty pixels above content
        // on a screen whose tab is already labelled, and on the composer it was
        // pushing the prompt field off the first screenful.
        headerLargeTitle: false,
        headerTransparent: true,
        headerBlurEffect: "systemChromeMaterialDark",
        headerTintColor: colors.label,
        headerTitleStyle: { color: colors.label },
        contentStyle: { backgroundColor: colors.background },
      }}
    >
      {/* The composer's own header is the model pill — see index.tsx. */}
      <Stack.Screen name="index" options={{ title: "" }} />
      <Stack.Screen
        name="engine"
        options={{ ...SHEET, title: "Engine", sheetAllowedDetents: [0.85, 1] }}
      />
      {/* Pushed from the engine sheet rather than presented from the composer:
            it is the second step of choosing a model, not a setting. */}
      <Stack.Screen
        name="atlas-models"
        options={{ ...SHEET, title: "Atlas models", sheetAllowedDetents: [0.9, 1] }}
      />
      <Stack.Screen
        name="settings"
        options={{ ...SHEET, title: "Generation settings", sheetAllowedDetents: [0.9, 1] }}
      />
      <Stack.Screen
        name="prompts"
        options={{ ...SHEET, title: "Prompts", sheetAllowedDetents: [0.85, 1] }}
      />
      {/* A full modal, not a form sheet like its neighbours: the keyboard takes
            half the screen, and a detent would leave the text editor a few lines
            tall — which is the problem it exists to solve. Its own header carries
            Cancel and Save. */}
      <Stack.Screen
        name="edit-prompt"
        options={{
          presentation: "modal",
          headerTransparent: false,
          headerStyle: { backgroundColor: colors.background },
          headerShadowVisible: false,
          contentStyle: { backgroundColor: colors.background },
        }}
      />
    </Stack>
  );
}
