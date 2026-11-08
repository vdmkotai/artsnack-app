import type { ExpoConfig } from "expo/config";

/**
 * The Expo config. The Expo CLI loads `.env` and `.env.local` from this directory
 * into `process.env` before evaluating it, so every value that identifies a
 * particular deployment comes from there — see `.env.example`.
 *
 * Only build-time identity lives here. Runtime endpoints (Convex, Clerk, the
 * media CDN) are `EXPO_PUBLIC_*` variables that Metro inlines into the bundle,
 * and the app refuses to start without them (lib/convex.ts, app/_layout.tsx).
 */
const DEFAULT_BUNDLE_ID = "com.example.artsnack.native";

/** Reverse-DNS, as App Store Connect and `expo prebuild` both require. */
const BUNDLE_ID_PATTERN = /^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/;

function bundleIdentifier(): string {
  const value = process.env.ARTSNACK_BUNDLE_ID?.trim() || DEFAULT_BUNDLE_ID;
  if (!BUNDLE_ID_PATTERN.test(value)) {
    throw new Error(
      `ARTSNACK_BUNDLE_ID must be a reverse-DNS identifier such as ${DEFAULT_BUNDLE_ID}, got "${value}".`,
    );
  }
  return value;
}

const config: ExpoConfig = {
  name: "ArtSnack",
  slug: "artsnack",
  scheme: "artsnack",
  version: "0.1.0",
  orientation: "default",
  userInterfaceStyle: "dark",
  platforms: ["ios"],
  icon: "./assets/icon.png",
  ios: {
    bundleIdentifier: bundleIdentifier(),
    supportsTablet: false,
    infoPlist: {
      UIUserInterfaceStyle: "Dark",
      ITSAppUsesNonExemptEncryption: false,
    },
  },
  plugins: [
    "expo-router",
    "expo-screen-orientation",
    "expo-secure-store",
    "expo-web-browser",
    [
      "expo-image-picker",
      {
        photosPermission:
          "ArtSnack needs your photo library so you can attach a photo as a reference or enhance one.",
      },
    ],
    [
      "expo-media-library",
      {
        savePhotosPermission: "ArtSnack saves generated images and video to your photo library.",
        isAccessMediaLocationEnabled: false,
      },
    ],
    [
      "expo-video",
      {
        supportsBackgroundPlayback: false,
        supportsPictureInPicture: false,
      },
    ],
    "@clerk/expo",
  ],
  experiments: {
    typedRoutes: true,
    reactCompiler: true,
  },
};

export default config;
