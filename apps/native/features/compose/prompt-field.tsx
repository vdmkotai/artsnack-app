import { Pressable, Text, View } from "react-native";

import { colors, CONTINUOUS, TABULAR } from "@/theme/colors";

/**
 * A prompt, shown but never edited in place.
 *
 * Three arrangements were tried on this screen and each broke on the same fact: a
 * multiline `TextInput` on iOS is a UITextView with its own scroll view, and a
 * prompt is long enough that the field is most of the screen.
 *
 * - As a plain growing field it claimed every drag that began inside it, so the
 *   keyboard appeared from nothing but scrolling the page.
 * - With its inner scroll disabled it grew to fit instead, so a long prompt pushed
 *   the rest of the composer off the bottom and could not be collapsed.
 * - Swapping between a `Text` preview and a focused field fixed the drag but left
 *   the growing: editing a nine-hundred-character prompt meant scrolling the *page*
 *   to reach the end of the field, past a settings summary and a Generate button.
 *
 * So the field is not a field. It is a preview that opens an editor of its own —
 * a modal whose only content is the text, which is the one place a UITextView can
 * own the scroll gesture without fighting anything. See `prompt-editor.tsx`.
 *
 * Both prompts are drawn at all times and each is labelled. The negative one used
 * to be a single unlabelled line, which made it indistinguishable from the
 * placeholder of an empty positive one.
 */
export function PromptField({
  label,
  value,
  placeholder,
  /** Lines shown in the preview. The editor is where the rest is. */
  collapsedLines,
  tone = "default",
  onPress,
}: {
  label: string;
  value: string;
  placeholder: string;
  collapsedLines: number;
  tone?: "default" | "muted";
  onPress: () => void;
}) {
  const has = value.trim().length > 0;
  const muted = tone === "muted";

  return (
    <Pressable
      onPress={onPress}
      accessibilityLabel={`Edit ${label.toLowerCase()}`}
      style={({ pressed }) => ({
        backgroundColor: colors.surface,
        borderRadius: 16,
        paddingHorizontal: 16,
        paddingTop: 11,
        paddingBottom: 12,
        gap: 6,
        opacity: pressed ? 0.75 : 1,
        ...CONTINUOUS,
      })}
    >
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <Text
          style={{
            color: colors.labelTertiary,
            fontSize: 11,
            fontWeight: "600",
            letterSpacing: 0.7,
            flex: 1,
          }}
        >
          {label}
        </Text>
        {has ? (
          <Text style={{ color: colors.labelQuaternary, fontSize: 11, ...TABULAR }}>
            {value.length}
          </Text>
        ) : null}
        <Text style={{ color: colors.accent, fontSize: 12.5, fontWeight: "600" }}>
          {has ? "Edit" : "Write"}
        </Text>
      </View>
      <Text
        numberOfLines={has ? collapsedLines : 1}
        style={{
          color: has ? (muted ? colors.labelSecondary : colors.label) : colors.labelQuaternary,
          fontSize: muted ? 15 : 17,
          lineHeight: muted ? 21 : 23,
        }}
      >
        {has ? value : placeholder}
      </Text>
    </Pressable>
  );
}
