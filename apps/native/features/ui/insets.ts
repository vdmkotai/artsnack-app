import { BottomTabBarHeightContext } from "expo-router/tabs";
import { use } from "react";

/**
 * How much of the bottom of the screen the tab bar covers.
 *
 * The bar is `position: absolute` so content can scroll under the glass, which
 * means anything pinned to the bottom — the Generate button, the last row of the
 * feed — has to add this or it lands underneath and cannot be tapped. That was
 * the bug: with `NativeTabs` there was no number to add.
 *
 * `useBottomTabBarHeight` throws outside a tab navigator, and the viewer is
 * deliberately outside one, so this reads the context and falls back to zero.
 */
export function useTabBarInset(): number {
  return use(BottomTabBarHeightContext) ?? 0;
}
