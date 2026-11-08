import { Color } from "expo-router";
import { Platform } from "react-native";

/**
 * The interface has no brand colour — see docs/adr/0003.
 *
 * Surfaces are fixed hexes rather than `Color.ios.systemBackground`, because
 * they are a deliberate near-black chosen to sit under generated images, not
 * whatever the system decides. The semantic four are the system's, so they
 * follow Increase Contrast and the accessibility settings for free.
 */
export const colors = {
  /** Behind the feed and the viewer. True black, so OLED gives us the frame. */
  background: "#000000",
  /** Cards, sheets, grouped list rows. */
  surface: "#1C1C1E",
  /** Anything raised above a sheet — a context menu, a lifted row. */
  surfaceRaised: "#2C2C2E",

  label: "#FFFFFF",
  labelSecondary: "rgba(255,255,255,0.62)",
  labelTertiary: "rgba(255,255,255,0.34)",
  labelQuaternary: "rgba(255,255,255,0.20)",

  separator: "rgba(255,255,255,0.09)",
  fill: "rgba(255,255,255,0.11)",

  /** Primary action. A white capsule with black text — never a colour. */
  accent: "#FFFFFF",
  onAccent: "#000000",

  /** Colour appears only where it means something. */
  working: Platform.select({ ios: Color.ios.systemTeal, default: "#30D5C8" })!,
  danger: Platform.select({ ios: Color.ios.systemRed, default: "#FF453A" })!,
  caution: Platform.select({ ios: Color.ios.systemOrange, default: "#FF9F0A" })!,
} as const;

/** Continuous curvature, not a rounded rectangle. Capsules are the exception. */
export const CONTINUOUS = { borderCurve: "continuous" } as const;

/** Prices and counters must not jitter as they recompute. */
export const TABULAR = { fontVariant: ["tabular-nums" as const] };
