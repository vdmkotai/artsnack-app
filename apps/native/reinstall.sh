#!/usr/bin/env bash
# Rebuild the release app and put it on the phone.
#
# Works over the cable as-is. For Wi-Fi, tick "Connect via network" once in
# Xcode → Window → Devices and Simulators → the iPhone; after that this script is
# unchanged and the cable is optional.
#
# Needs ARTSNACK_DEVICE and ARTSNACK_TEAM in the environment, and the app's
# EXPO_PUBLIC_* values in .env.local (see .env.example).
#
# CocoaPods needs a UTF-8 locale or it dies inside unicode_normalize.
set -euo pipefail

DEVICE="${ARTSNACK_DEVICE:?set ARTSNACK_DEVICE to the target iPhone UDID (xcrun devicectl list devices)}"
TEAM="${ARTSNACK_TEAM:?set ARTSNACK_TEAM to your Apple Developer Team ID}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

export LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8

if [ ! -d "$HERE/ios" ]; then
  echo "▸ ios/ is generated and gitignored — running prebuild"
  (cd "$HERE" && bunx expo prebuild --platform ios)
fi

echo "▸ pods"
(cd "$HERE/ios" && pod install >/dev/null)

echo "▸ build"
xcodebuild -workspace "$HERE/ios/ArtSnack.xcworkspace" -scheme ArtSnack \
  -configuration Release -destination "id=$DEVICE" -allowProvisioningUpdates \
  DEVELOPMENT_TEAM="$TEAM" CODE_SIGN_STYLE=Automatic \
  -derivedDataPath "$HERE/ios/build" build | tail -3

echo "▸ install"
xcrun devicectl device install app --device "$DEVICE" \
  "$HERE/ios/build/Build/Products/Release-iphoneos/ArtSnack.app"
