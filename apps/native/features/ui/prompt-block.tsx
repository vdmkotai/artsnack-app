import * as Clipboard from "expo-clipboard";
import * as Haptics from "expo-haptics";
import { SymbolView } from "expo-symbols";
import { useState } from "react";
import { Pressable, Text, View } from "react-native";

import { colors, CONTINUOUS } from "@/theme/colors";

/**
 * A prompt, and one button that copies it.
 *
 * Everywhere a prompt is readable it is also copyable — the viewer, the failure
 * sheet — and a negative prompt gets its own block with its own
 * button rather than being appended to the positive one, because pasting the two
 * together into a form that has separate fields is not what anyone wants.
 */
export function PromptBlock({
  label,
  text,
  tone = "default",
  empty = "No prompt recorded.",
}: {
  label: string;
  text: string;
  tone?: "default" | "muted";
  empty?: string;
}) {
  const [copied, setCopied] = useState(false);
  const has = text.trim().length > 0;

  const copy = () => {
    if (!has) return;
    void Clipboard.setStringAsync(text);
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    setCopied(true);
    setTimeout(() => setCopied(false), 1600);
  };

  return (
    <View style={{ gap: 7 }}>
      <View style={{ flexDirection: "row", alignItems: "center", paddingHorizontal: 2 }}>
        <Text
          style={{
            color: colors.labelTertiary,
            fontSize: 11.5,
            fontWeight: "600",
            letterSpacing: 0.7,
            flex: 1,
          }}
        >
          {label}
        </Text>
        {has ? (
          <Pressable
            onPress={copy}
            hitSlop={10}
            accessibilityLabel={`Copy ${label.toLowerCase()}`}
            style={({ pressed }) => ({
              flexDirection: "row",
              alignItems: "center",
              gap: 5,
              height: 26,
              paddingHorizontal: 10,
              borderRadius: 13,
              backgroundColor: colors.fill,
              opacity: pressed ? 0.6 : 1,
            })}
          >
            <SymbolView
              name={copied ? "checkmark" : "doc.on.doc"}
              size={11}
              weight="semibold"
              tintColor={colors.label}
              style={{ width: 13, height: 13 }}
            />
            <Text style={{ color: colors.label, fontSize: 12.5, fontWeight: "500" }}>
              {copied ? "Copied" : "Copy"}
            </Text>
          </Pressable>
        ) : null}
      </View>
      <View
        style={{
          backgroundColor: colors.surface,
          borderRadius: 12,
          padding: 13,
          ...CONTINUOUS,
        }}
      >
        <Text
          selectable
          style={{
            color: has
              ? tone === "muted"
                ? colors.labelSecondary
                : colors.label
              : colors.labelTertiary,
            fontSize: 15,
            lineHeight: 21,
          }}
        >
          {has ? text : empty}
        </Text>
      </View>
    </View>
  );
}
