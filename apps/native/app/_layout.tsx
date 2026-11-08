import { ClerkProvider, useAuth } from "@clerk/expo";
import { tokenCache } from "@clerk/expo/token-cache";
import { ConvexProviderWithClerk } from "convex/react-clerk";
import { DarkTheme, Stack, ThemeProvider } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { HeroUINativeProvider } from "heroui-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";

import "../global.css";

import SignInScreen from "@/features/auth/sign-in";
import { ComposerProvider } from "@/features/compose/context";
import { applyCacheLimits } from "@/features/storage/cache";
import { lockPortrait } from "@/features/ui/orientation";
import { convex } from "@/lib/convex";
import { colors } from "@/theme/colors";

const publishableKey = process.env.EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY ?? "";
if (!publishableKey) {
  throw new Error(
    "EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY is not set — copy apps/native/.env.example to apps/native/.env.local and fill it in",
  );
}

/**
 * `ConvexProviderWithClerk` asks Clerk for a token minted from the `convex` JWT
 * template and refreshes it before it expires, which is the whole of the auth
 * integration — `packages/backend/convex/authz.ts` and `ALLOWED_USER_IDS` see the
 * same `sub` they see from the web app and need no change.
 *
 * The token cache is `expo-secure-store` behind Clerk's own wrapper, so the
 * session survives a cold launch and the sign-in screen appears exactly once.
 */
// Both libraries read their limits once, at first use, so this has to run before
// anything renders an image.
void applyCacheLimits();

// app.config.ts declares landscape so iOS will let a video rotate in fullscreen; every
// screen that is not the viewer is locked back to portrait here. See
// features/ui/orientation.ts.
lockPortrait();

export default function RootLayout() {
  return (
    <ClerkProvider publishableKey={publishableKey} tokenCache={tokenCache}>
      <ConvexProviderWithClerk client={convex} useAuth={useAuth}>
        <ThemeProvider
          value={{
            ...DarkTheme,
            colors: {
              ...DarkTheme.colors,
              background: colors.background,
              card: colors.surface,
              text: colors.label,
              border: colors.separator,
              primary: colors.label,
            },
          }}
        >
          {/* GestureHandlerRootView has to be the outermost wrapper for both the
              gesture library and HeroUI's overlays; HeroUINativeProvider is its
              direct child, which is what its Portal host expects. */}
          <GestureHandlerRootView style={{ flex: 1, backgroundColor: colors.background }}>
            <HeroUINativeProvider>
              <StatusBar style="light" />
              <AuthenticatedApp />
            </HeroUINativeProvider>
          </GestureHandlerRootView>
        </ThemeProvider>
      </ConvexProviderWithClerk>
    </ClerkProvider>
  );
}

function AuthenticatedApp() {
  const { isLoaded, isSignedIn } = useAuth();

  // Wait for the keychain before deciding which screen to render, so an
  // existing session never flashes the sign-in screen during cold launch.
  if (!isLoaded) return null;
  if (!isSignedIn) return <SignInScreen />;

  return (
    <ComposerProvider>
      <Stack screenOptions={{ headerShown: false }}>
        <Stack.Screen name="(tabs)" />
        <Stack.Screen name="tools" options={{ presentation: "modal", headerShown: true }} />
        {/* The viewer sits above the tabs rather than inside one, so the tab bar
          is absent from the hierarchy instead of hidden by a style — a full-bleed
          photograph with a bar floating over it was the old bug. */}
        <Stack.Screen
          name="viewer"
          options={{
            animation: "fade",
            contentStyle: { backgroundColor: colors.background },
          }}
        />
      </Stack>
    </ComposerProvider>
  );
}
