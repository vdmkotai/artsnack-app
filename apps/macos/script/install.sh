#!/usr/bin/env bash
# Builds ArtSnack Native, wraps it in a signed .app and installs it to
# /Applications — the counterpart of `bun run desktop:install` for the
# Electron shell. Run on the Mac:
#
#   apps/macos/script/install.sh            # build, sign, install, launch
#   apps/macos/script/install.sh --no-open  # … without launching
#
# Signing uses the "Developer ID Application" identity in the login keychain,
# as electron-builder does; without one it signs ad hoc, which is enough to run
# here but makes the Keychain ask again after every rebuild. A stable
# signature is also what lets the Keychain item holding the sign-in survive
# reinstalls.
#
# Build-time settings, read from the environment:
#   ARTSNACK_BUNDLE_ID   the bundle id (default: the placeholder
#                        com.example.artsnack); baked into the binary too.
#   ARTSNACK_CONVEX_URL, ARTSNACK_CLERK_FRONTEND_API, ARTSNACK_WEB_ORIGIN,
#   ARTSNACK_MEDIA_ORIGIN (and their _DEV variants)
#                        baked in as the app's defaults; see README.md. An app
#                        started from the Finder gets no shell environment, so
#                        without them (or a config.json) it opens its setup
#                        window.
set -euo pipefail

cd "$(dirname "$0")/.."
ROOT="$PWD"
APP_NAME="ArtSnack Native"
BUNDLE_ID="${ARTSNACK_BUNDLE_ID:-com.example.artsnack}"
# The binary reports the same identity (option_env! in crates/app/src/main.rs).
export ARTSNACK_BUNDLE_ID="$BUNDLE_ID"
TARGET_APP="/Applications/$APP_NAME.app"
OPEN=1
[[ "${1:-}" == "--no-open" ]] && OPEN=0

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "install.sh builds a macOS app bundle; run it on the Mac." >&2
  exit 1
fi

VERSION="$(sed -n 's/^version = "\(.*\)"/\1/p' Cargo.toml | head -1)"
BUILD="$(git -C "$ROOT" rev-list --count HEAD 2>/dev/null || echo 1)"

if [[ -z "${ARTSNACK_CONVEX_URL:-}" ]]; then
  echo "Note: ARTSNACK_CONVEX_URL and the other endpoints are not set, so none are baked in;" \
    "the app reads them from config.json or shows its setup window (README.md)."
fi

echo "Building $APP_NAME $VERSION ($BUILD)…"
cargo build --release -p artsnack

BUNDLE="$ROOT/target/bundle/$APP_NAME.app"
rm -rf "$BUNDLE"
mkdir -p "$BUNDLE/Contents/MacOS" "$BUNDLE/Contents/Resources"
cp "$ROOT/target/release/artsnack" "$BUNDLE/Contents/MacOS/artsnack"
sed -e "s/__VERSION__/$VERSION/" -e "s/__BUILD__/$BUILD/" -e "s/__BUNDLE_ID__/$BUNDLE_ID/g" \
  "$ROOT/resources/Info.plist" > "$BUNDLE/Contents/Info.plist"

# The icon: the Electron app's 1024 px PNG, turned into an .icns.
ICON_PNG="$ROOT/../desktop/resources/icon.png"
if [[ -f "$ICON_PNG" ]]; then
  ICONSET="$(mktemp -d)/AppIcon.iconset"
  mkdir -p "$ICONSET"
  for size in 16 32 128 256 512; do
    sips -z $size $size "$ICON_PNG" --out "$ICONSET/icon_${size}x${size}.png" >/dev/null
    sips -z $((size * 2)) $((size * 2)) "$ICON_PNG" --out "$ICONSET/icon_${size}x${size}@2x.png" >/dev/null
  done
  iconutil -c icns "$ICONSET" -o "$BUNDLE/Contents/Resources/AppIcon.icns"
fi

IDENTITY="$(security find-identity -v -p codesigning | sed -n 's/.*"\(Developer ID Application: [^"]*\)".*/\1/p' | head -1)"
if [[ -n "$IDENTITY" ]]; then
  echo "Signing with $IDENTITY"
  codesign --force --options runtime --timestamp --sign "$IDENTITY" "$BUNDLE"
else
  echo "No Developer ID identity found; signing ad hoc."
  codesign --force --sign - "$BUNDLE"
fi

# Only ever replace something that is ours.
if [[ -d "$TARGET_APP" ]]; then
  if ! /usr/libexec/PlistBuddy -c "Print :CFBundleIdentifier" "$TARGET_APP/Contents/Info.plist" 2>/dev/null | grep -qx "$BUNDLE_ID"; then
    echo "$TARGET_APP exists and is not $APP_NAME (bundle id mismatch). Not touching it." >&2
    exit 1
  fi
  osascript -e "tell application \"$APP_NAME\" to quit" >/dev/null 2>&1 || true
  sleep 0.8
  rm -rf "$TARGET_APP"
fi

ditto "$BUNDLE" "$TARGET_APP"
xattr -dr com.apple.quarantine "$TARGET_APP" 2>/dev/null || true
# Register the artsnack-native:// scheme with Launch Services now rather than
# on first launch, so a sign-in link works straight away.
/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -f "$TARGET_APP"
echo "Installed $APP_NAME $VERSION to $TARGET_APP"

if [[ $OPEN == 1 ]]; then
  # A terminal inside an Electron-based tool carries ELECTRON_RUN_AS_NODE=1;
  # harmless here, but keep the environment clean as the Electron installer does.
  env -u ELECTRON_RUN_AS_NODE open -a "$TARGET_APP"
fi
