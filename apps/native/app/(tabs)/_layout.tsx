import { GlassView, isLiquidGlassAvailable } from "expo-glass-effect";
import Tabs from "expo-router/tabs";
import { SymbolView } from "expo-symbols";
import { Keyboard, View, type ColorValue } from "react-native";

import { colors } from "@/theme/colors";

/**
 * The JavaScript tab bar, not `NativeTabs`.
 *
 * A real UITabBarController looked better on iOS 26 — genuine Liquid Glass —
 * but it reported no height to the screens underneath it, so the Generate button
 * sat behind the bar and could not be tapped, and it kept drawing itself over the
 * full-screen viewer. `useBottomTabBarHeight` is the whole reason this is a JS
 * bar: every screen that pins something to the bottom reads it.
 *
 * The glass is kept: `tabBarBackground` renders a GlassView behind a transparent
 * bar, which is the same material without the layout problems.
 *
 * Three destinations, down from the web's twelve: Gallery and History were the
 * same rows in two presentations, and Prompts, Models and the LoRA catalogue are
 * pickers rather than places — they open where they are needed.
 */
export default function TabLayout() {
  return (
    <Tabs
      // Switching tabs while a prompt is focused used to leave the keyboard up
      // over whatever arrived next.
      screenListeners={{ tabPress: () => Keyboard.dismiss() }}
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: colors.label,
        tabBarInactiveTintColor: colors.labelTertiary,
        // Absolute so content scrolls under the glass rather than being letterboxed
        // above it. Screens add `useBottomTabBarHeight()` where it matters.
        tabBarStyle: {
          position: "absolute",
          backgroundColor: "transparent",
          borderTopWidth: 0,
        },
        tabBarBackground: TabBarBackground,
        tabBarLabelStyle: { fontSize: 10.5, fontWeight: "500" },
        // The composer is the one screen with a text field and a primary button,
        // and the bar between them is only in the way while typing.
        tabBarHideOnKeyboard: true,
      }}
    >
      <Tabs.Screen
        name="(create)"
        options={{
          title: "Create",
          tabBarIcon: ({ color }) => <TabIcon name="wand.and.sparkles" color={color} />,
        }}
      />
      <Tabs.Screen
        name="(library)"
        options={{
          title: "Library",
          tabBarIcon: ({ color, focused }) => (
            <TabIcon name={focused ? "square.grid.2x2.fill" : "square.grid.2x2"} color={color} />
          ),
        }}
      />
      <Tabs.Screen
        name="(favourites)"
        options={{
          title: "Favourites",
          tabBarIcon: ({ color, focused }) => (
            <TabIcon name={focused ? "heart.fill" : "heart"} color={color} />
          ),
        }}
      />
    </Tabs>
  );
}

/** `sf-symbols-typescript` is not a direct dependency, so the name type is borrowed. */
type SymbolName = React.ComponentProps<typeof SymbolView>["name"];

function TabIcon({ name, color }: { name: SymbolName; color: ColorValue }) {
  return (
    <SymbolView
      name={name}
      size={25}
      tintColor={color}
      type="monochrome"
      style={{ width: 27, height: 27 }}
    />
  );
}

/**
 * Liquid Glass where the OS has it, a flat near-black bar where it does not. A
 * BlurView is deliberately not the fallback: over a black background it reads as
 * grey haze, and this app's surfaces are chosen, not sampled.
 */
function TabBarBackground() {
  if (isLiquidGlassAvailable()) {
    return <GlassView style={{ flex: 1 }} glassEffectStyle="regular" colorScheme="dark" />;
  }
  return (
    <View
      style={{
        flex: 1,
        backgroundColor: "rgba(18,18,20,0.94)",
        borderTopWidth: 1,
        borderTopColor: colors.separator,
      }}
    />
  );
}
