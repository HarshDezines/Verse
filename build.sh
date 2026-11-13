#!/bin/bash
# Builds Verse.app next to this script. Needs Xcode Command Line Tools (xcode-select --install).
set -euo pipefail
cd "$(dirname "$0")"

APP="build/Verse.app"
ARCH="$(uname -m)"
rm -rf build
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"

echo "→ Compiling ($ARCH)…"
swiftc -O -swift-version 5 \
  -target "$ARCH-apple-macos13.0" \
  -o "$APP/Contents/MacOS/Verse" \
  Sources/*.swift

cp Info.plist "$APP/Contents/Info.plist"
cp -R web "$APP/Contents/Resources/web"

if [ -f icon/AppIcon-1024.png ]; then
  echo "→ Making icon…"
  SET="build/AppIcon.iconset"; mkdir -p "$SET"
  for s in 16 32 128 256 512; do
    sips -z $s $s icon/AppIcon-1024.png --out "$SET/icon_${s}x${s}.png" >/dev/null
    sips -z $((s*2)) $((s*2)) icon/AppIcon-1024.png --out "$SET/icon_${s}x${s}@2x.png" >/dev/null
  done
  iconutil -c icns "$SET" -o "$APP/Contents/Resources/AppIcon.icns"
  rm -rf "$SET"
fi

echo "→ Signing (ad-hoc)…"
codesign --force --deep --sign - "$APP"

echo "✓ Built $APP"
if [ "${1:-}" = "--install" ]; then
  rm -rf /Applications/Verse.app
  cp -R "$APP" /Applications/
  echo "✓ Installed to /Applications/Verse.app"
  open /Applications/Verse.app
else
  open "$APP"
fi
