import Stack from "expo-router/stack";

import { colors } from "@/theme/colors";

/**
 * Each tab nests its own stack, because the tab navigator draws no headers.
 *
 * The viewer is *not* here: it is a root-level route (`app/viewer.tsx`), pushed
 * above the tab navigator so the tab bar is absent from the hierarchy while an
 * image is full-bleed rather than hidden by a style.
 */
export default function LibraryLayout() {
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
      {/* The grid draws no navigation bar at all — search and the selection
          actions float over it. See index.tsx. */}
      <Stack.Screen name="index" options={{ headerShown: false }} />
      <Stack.Screen name="search" options={{ headerShown: false }} />
      <Stack.Screen
        name="failure"
        options={{
          title: "Generation failed",
          presentation: "formSheet",
          sheetGrabberVisible: true,
          sheetAllowedDetents: [0.6, 1],
          headerTransparent: false,
          headerStyle: { backgroundColor: colors.background },
        }}
      />
    </Stack>
  );
}
