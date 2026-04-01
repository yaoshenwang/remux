#!/bin/bash
# Build Remux.app and create a DMG installer.
# Usage: ./scripts/build-dmg.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
APP_DIR="$ROOT_DIR/apps/macos"
BUILD_DIR="$ROOT_DIR/build"

echo "Building Remux.app..."
cd "$APP_DIR"
swift build -c release 2>&1

# Find the built binary
BINARY=$(swift build -c release --show-bin-path)/Remux

if [ ! -f "$BINARY" ]; then
    echo "Error: Binary not found at $BINARY"
    exit 1
fi

# Create .app bundle
mkdir -p "$BUILD_DIR/Remux.app/Contents/MacOS"
mkdir -p "$BUILD_DIR/Remux.app/Contents/Resources"

cp "$BINARY" "$BUILD_DIR/Remux.app/Contents/MacOS/Remux"

cat > "$BUILD_DIR/Remux.app/Contents/Info.plist" << 'PLIST'
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
    <string>0.4.0</string>
    <key>CFBundleShortVersionString</key>
    <string>0.4.0</string>
    <key>CFBundleExecutable</key>
    <string>Remux</string>
    <key>CFBundlePackageType</key>
    <string>APPL</string>
    <key>LSMinimumSystemVersion</key>
    <string>14.0</string>
    <key>NSHighResolutionCapable</key>
    <true/>
    <key>LSUIElement</key>
    <false/>
    <key>NSCameraUsageDescription</key>
    <string>Remux uses the camera for QR code pairing with the server.</string>
</dict>
</plist>
PLIST

echo "Remux.app created at $BUILD_DIR/Remux.app"

# Create DMG if create-dmg is available
if command -v create-dmg &> /dev/null; then
    echo "Creating DMG..."
    create-dmg \
        --volname "Remux" \
        --window-pos 200 120 \
        --window-size 600 400 \
        --icon-size 100 \
        --icon "Remux.app" 150 190 \
        --app-drop-link 450 190 \
        "$BUILD_DIR/Remux-0.4.0.dmg" \
        "$BUILD_DIR/Remux.app" \
        2>/dev/null || true
    echo "DMG created at $BUILD_DIR/Remux-0.4.0.dmg"
else
    echo "create-dmg not found. Install with: brew install create-dmg"
    echo "You can still use Remux.app directly."
fi
