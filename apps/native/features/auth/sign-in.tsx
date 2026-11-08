import { useHostedAuth } from "@clerk/expo/hosted-auth";
import { useState } from "react";
import { ActivityIndicator, Pressable, Text, View } from "react-native";

import { colors } from "@/theme/colors";

/**
 * Sign-in, seen once.
 *
 * Clerk's token cache is expo-secure-store, so the session survives cold
 * launches and this screen does not come back. Google is the only enabled
 * social connection on the production Clerk instance and is how the existing
 * account signs in on the web app too.
 */
export default function SignInScreen() {
  const { startHostedAuth } = useHostedAuth();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await startHostedAuth({
        mode: "sign-in",
        authSessionOptions: {
          preferEphemeralSession: false,
        },
      });
    } catch (cause) {
      setError(clerkErrorMessage(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <View
      style={{ flex: 1, backgroundColor: colors.background, justifyContent: "center", padding: 28 }}
    >
      <Text
        style={{
          color: colors.label,
          fontSize: 34,
          fontWeight: "700",
          letterSpacing: -0.9,
          marginBottom: 8,
        }}
      >
        ArtSnack
      </Text>
      <Text style={{ color: colors.labelTertiary, fontSize: 15, marginBottom: 28 }}>
        Continue with the same Google account you use on the web.
      </Text>

      {error ? (
        <Text selectable style={{ color: colors.danger, fontSize: 14, marginBottom: 14 }}>
          {error}
        </Text>
      ) : null}

      <Pressable
        onPress={() => void submit()}
        disabled={busy}
        accessibilityRole="button"
        accessibilityLabel="Continue with Google"
        style={{
          height: 52,
          borderRadius: 26,
          alignItems: "center",
          justifyContent: "center",
          backgroundColor: busy ? colors.fill : colors.accent,
        }}
      >
        {busy ? (
          <ActivityIndicator color={colors.label} />
        ) : (
          <Text style={{ color: colors.onAccent, fontSize: 17, fontWeight: "600" }}>
            Continue with Google
          </Text>
        )}
      </Pressable>
    </View>
  );
}

function clerkErrorMessage(cause: unknown) {
  if (cause instanceof Error) return cause.message;
  if (cause && typeof cause === "object" && "errors" in cause) {
    const errors = (cause as { errors?: Array<{ longMessage?: string; message?: string }> }).errors;
    const message = errors?.[0]?.longMessage ?? errors?.[0]?.message;
    if (message) return message;
  }
  return "Could not sign in with Google";
}
