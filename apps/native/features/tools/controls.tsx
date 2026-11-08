import { useRef, useState } from "react";
import { Alert, Pressable, Text, TextInput, View } from "react-native";
import { colors } from "@/theme/colors";

export function useTask() {
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  const run = async (work: () => Promise<unknown>) => {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    try {
      await work();
    } catch (error) {
      Alert.alert("Could not complete", error instanceof Error ? error.message : String(error));
    } finally {
      lock.current = false;
      setBusy(false);
    }
  };
  return { busy, run };
}

export function Action({
  label,
  onPress,
  disabled,
  destructive,
}: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  destructive?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => ({
        padding: 15,
        borderRadius: 16,
        backgroundColor: colors.surface,
        opacity: disabled ? 0.4 : pressed ? 0.65 : 1,
      })}
    >
      <Text style={{ color: destructive ? colors.danger : colors.label, fontSize: 16 }}>
        {label}
      </Text>
    </Pressable>
  );
}

export function Field({
  label,
  value,
  onChange,
  numeric,
  multiline,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  numeric?: boolean;
  multiline?: boolean;
}) {
  return (
    <View style={{ gap: 6 }}>
      <Text style={{ color: colors.labelSecondary }}>{label}</Text>
      <TextInput
        accessibilityLabel={label}
        value={value}
        onChangeText={onChange}
        multiline={multiline}
        keyboardType={numeric ? "decimal-pad" : "default"}
        autoCapitalize="none"
        autoCorrect={false}
        style={{
          color: colors.label,
          backgroundColor: colors.surface,
          borderRadius: 12,
          padding: 12,
          minHeight: multiline ? 120 : 44,
        }}
      />
    </View>
  );
}

export function Note({ children }: { children: React.ReactNode }) {
  return (
    <Text selectable style={{ color: colors.labelSecondary, lineHeight: 20 }}>
      {children}
    </Text>
  );
}

export function confirm(label: string, message: string, run: () => void, destructive = false) {
  Alert.alert(label, message, [
    { text: "Cancel", style: "cancel" },
    { text: label, style: destructive ? "destructive" : "default", onPress: run },
  ]);
}
