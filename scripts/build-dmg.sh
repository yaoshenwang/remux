#!/bin/bash
# Build Remux.app and create a DMG installer.
# Usage: ./scripts/build-dmg.sh [--version X.Y.Z]
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
APP_DIR="$ROOT_DIR/apps/macos"
BUILD_DIR="$ROOT_DIR/build"

# Read version from package.json or CLI arg
VERSION="${1:-}"
if [ -z "$VERSION" ]; then
  VERSION=$(node -p "require('$ROOT_DIR/package.json').version" 2>/dev/null || echo "0.0.0")
fi
# Strip leading 'v' if present
VERSION="${VERSION#v}"

echo "Building Remux.app v${VERSION}..."

# Step 1: Build ghostty xcframework if missing
XCFW="$ROOT_DIR/vendor/ghostty/macos/GhosttyKit.xcframework"
if [ ! -d "$XCFW" ] || [ ! -f "$XCFW/Info.plist" ]; then
  echo "GhosttyKit.xcframework not found. Building from source..."
  cd "$ROOT_DIR/vendor/ghostty"
  git submodule update --init 2>/dev/null || true
  zig build -Demit-xcframework=true -Dxcframework-target=native -Doptimize=ReleaseFast
  echo "GhosttyKit built."
fi

# Step 2: Build macOS app (release)
cd "$APP_DIR"
swift build -c release 2>&1

BINARY=$(swift build -c release --show-bin-path)/Remux
if [ ! -f "$BINARY" ]; then
  echo "Error: Binary not found at $BINARY"
  exit 1
fi

# Step 3: Create .app bundle
rm -rf "$BUILD_DIR/Remux.app"
mkdir -p "$BUILD_DIR/Remux.app/Contents/MacOS"
mkdir -p "$BUILD_DIR/Remux.app/Contents/Resources"

cp "$BINARY" "$BUILD_DIR/Remux.app/Contents/MacOS/Remux"

# Copy ghostty resources if available
if [ -d "$APP_DIR/Resources/terminfo" ]; then
  cp -r "$APP_DIR/Resources/terminfo" "$BUILD_DIR/Remux.app/Contents/Resources/"
fi
if [ -d "$APP_DIR/Resources/shell-integration" ]; then
  cp -r "$APP_DIR/Resources/shell-integration" "$BUILD_DIR/Remux.app/Contents/Resources/"
fi

cat > "$BUILD_DIR/Remux.app/Contents/Info.plist" << PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleName</key>
    <string>Remux</string>
    <key>CFBundleDisplayName</key>
    <string>Remux</string>
    <key>CFBundleIdentifier</key>
    <string>com.remux.desktop</string>
    <key>CFBundleVersion</key>
    <string>${VERSION}</string>
    <key>CFBundleShortVersionString</key>
    <string>${VERSION}</string>
    <key>CFBundleExecutable</key>
    <string>Remux</string>
    <key>CFBundlePackageType</key>
    <string>APPL</string>
    <key>CFBundleInfoDictionaryVersion</key>
    <string>6.0</string>
    <key>LSMinimumSystemVersion</key>
    <string>14.0</string>
    <key>NSHighResolutionCapable</key>
    <true/>
    <key>LSUIElement</key>
    <false/>
    <key>NSPrincipalClass</key>
    <string>NSApplication</string>
</dict>
</plist>
PLIST

echo "✓ Remux.app created at $BUILD_DIR/Remux.app"

# Step 4: Create DMG
DMG_NAME="Remux-${VERSION}-arm64.dmg"
rm -f "$BUILD_DIR/$DMG_NAME"

if command -v create-dmg &> /dev/null; then
  echo "Creating DMG with create-dmg..."
  create-dmg \
    --volname "Remux" \
    --window-pos 200 120 \
    --window-size 600 400 \
    --icon-size 100 \
    --icon "Remux.app" 150 190 \
    --app-drop-link 450 190 \
    "$BUILD_DIR/$DMG_NAME" \
    "$BUILD_DIR/Remux.app" \
    2>/dev/null || true
else
  # Fallback: simple hdiutil DMG
  echo "Creating DMG with hdiutil..."
  hdiutil create -volname "Remux" \
    -srcfolder "$BUILD_DIR/Remux.app" \
    -ov -format UDZO \
    "$BUILD_DIR/$DMG_NAME"
fi

if [ -f "$BUILD_DIR/$DMG_NAME" ]; then
  SIZE=$(du -h "$BUILD_DIR/$DMG_NAME" | cut -f1)
  echo "✓ DMG created: $BUILD_DIR/$DMG_NAME ($SIZE)"
else
  echo "⚠ DMG creation failed, but Remux.app is available"
fi
