#!/usr/bin/env bash
# Rasterises resources/icon.svg into the 1024px PNG electron-builder turns into
# an .icns at build time. Uses Chrome rather than ImageMagick because
# ImageMagick's own SVG renderer drops the gradients and the drop shadow.
set -euo pipefail
cd "$(dirname "$0")/.."
CHROME="${CHROME:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}"
"$CHROME" --headless=new --disable-gpu --hide-scrollbars --force-device-scale-factor=1 \
  --window-size=1024,1024 --default-background-color=00000000 \
  --screenshot="$PWD/resources/icon.png" "file://$PWD/resources/icon.svg" 2>/dev/null
echo "wrote resources/icon.png"
