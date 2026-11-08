import Stack from "expo-router/stack";

import { FavouritesProvider } from "@/features/favourites/context";
import { colors } from "@/theme/colors";

export default function FavouritesLayout() {
  return (
    // The filter sheet and the grid are sibling routes, so the scope they share
    // lives on the layout — the same arrangement as (create). See context.tsx.
    <FavouritesProvider>
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
        {/* No navigation bar: the folder rail floats over the grid. See index.tsx. */}
        <Stack.Screen name="index" options={{ headerShown: false }} />
        {/* The viewer is a root route — see app/viewer.tsx. */}
        <Stack.Screen name="storage" options={{ title: "Storage" }} />
        <Stack.Screen
          name="filters"
          options={{
            title: "Filters",
            presentation: "formSheet",
            sheetGrabberVisible: true,
            sheetAllowedDetents: [0.75, 1],
            // A form sheet gets an opaque header rather than the inherited
            // transparent-blur one: blur over a sheet that is itself an opaque
            // surface reads as a seam.
            headerTransparent: false,
            headerStyle: { backgroundColor: colors.background },
            headerShadowVisible: false,
            contentStyle: { backgroundColor: colors.background },
          }}
        />
      </Stack>
    </FavouritesProvider>
  );
}
