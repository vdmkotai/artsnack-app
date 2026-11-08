import { GlassView, isLiquidGlassAvailable } from "expo-glass-effect";
import { SymbolView } from "expo-symbols";
import { Pressable, Text, View, type StyleProp, type ViewStyle } from "react-native";

import { colors } from "@/theme/colors";

/**
 * Liquid Glass where the OS has it, a chosen near-black where it does not.
 *
 * A BlurView is deliberately not the fallback: over black it reads as grey haze,
 * and this app's surfaces are picked rather than sampled — see docs/adr/0003.
 */
export function Glass({
  children,
  style,
  radius = 22,
}: {
  children: React.ReactNode;
  style?: StyleProp<ViewStyle>;
  radius?: number;
}) {
  if (isLiquidGlassAvailable()) {
    return (
      <GlassView
        glassEffectStyle="regular"
        colorScheme="dark"
        style={[{ borderRadius: radius, overflow: "hidden" }, style]}
      >
        {children}
      </GlassView>
    );
  }
  return (
    <View
      style={[
        { borderRadius: radius, overflow: "hidden", backgroundColor: "rgba(28,28,30,0.9)" },
        style,
      ]}
    >
      {children}
    </View>
  );
}

/**
 * A floating action over content, which is what the Library and Favourites use
 * instead of a navigation bar: a bar drawn across the top of a screen that is
 * nothing but images costs a band of pixels to say what the tab already says.
 */
export function GlassButton({
  symbol,
  label,
  onPress,
  tone = "default",
  accessibilityLabel,
}: {
  symbol?: React.ComponentProps<typeof SymbolView>["name"];
  label?: string;
  onPress: () => void;
  tone?: "default" | "danger";
  accessibilityLabel?: string;
}) {
  const tint = tone === "danger" ? colors.danger : colors.label;
  return (
    <Glass radius={19}>
      <Pressable
        onPress={onPress}
        accessibilityLabel={accessibilityLabel ?? label}
        style={({ pressed }) => ({
          height: 38,
          minWidth: label ? undefined : 38,
          paddingHorizontal: label ? 14 : 0,
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "center",
          gap: 6,
          opacity: pressed ? 0.55 : 1,
        })}
      >
        {symbol ? (
          <SymbolView
            name={symbol}
            size={15}
            weight="semibold"
            tintColor={tint}
            style={{ width: 17, height: 17 }}
          />
        ) : null}
        {label ? (
          <Text style={{ color: tint, fontSize: 15, fontWeight: "500" }}>{label}</Text>
        ) : null}
      </Pressable>
    </Glass>
  );
}
