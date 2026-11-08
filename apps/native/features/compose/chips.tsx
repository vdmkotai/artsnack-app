import { SymbolView } from "expo-symbols";
import { Pressable } from "react-native";

import { colors } from "@/theme/colors";

/**
 * A round icon button for the composer's header.
 *
 * What used to be here — a scrolling row of pills, one per setting — moved onto
 * the settings panel: see features/compose/settings-sheet.tsx. Changing four
 * values used to cost four sheets.
 */
export function IconChip({
  symbol,
  onPress,
  accessibilityLabel,
}: {
  symbol: React.ComponentProps<typeof SymbolView>["name"];
  onPress: () => void;
  accessibilityLabel: string;
}) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityLabel={accessibilityLabel}
      style={({ pressed }) => ({
        width: 36,
        height: 36,
        borderRadius: 18,
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: colors.fill,
        opacity: pressed ? 0.65 : 1,
      })}
    >
      <SymbolView
        name={symbol}
        size={16}
        tintColor={colors.label}
        style={{ width: 18, height: 18 }}
      />
    </Pressable>
  );
}
