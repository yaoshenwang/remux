#!/bin/bash
# Archive and upload Remux iOS app to TestFlight.
# Uses App Store Connect API Key for authentication.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
IOS_DIR="$ROOT_DIR/apps/ios"
BUILD_DIR="$ROOT_DIR/build/ios"
VERSION=$(node -p "require('$ROOT_DIR/package.json').version" 2>/dev/null || echo "0.0.0")

# App Store Connect API Key config
API_KEY_ID="2D79888WND"
API_ISSUER_ID="871408b2-72c1-4989-9530-5b72d99f4f27"
API_KEY_PATH="$HOME/.private_keys/AuthKey_${API_KEY_ID}.p8"

if [ ! -f "$API_KEY_PATH" ]; then
  echo "Error: API key not found at $API_KEY_PATH"
  exit 1
fi

AUTH_ARGS=(
  -authenticationKeyPath "$API_KEY_PATH"
  -authenticationKeyID "$API_KEY_ID"
  -authenticationKeyIssuerID "$API_ISSUER_ID"
)

echo "=== Uploading Remux iOS v${VERSION} to TestFlight ==="

# Clean build directory
rm -rf "$BUILD_DIR"
mkdir -p "$BUILD_DIR"

# Step 1: Archive
echo "Archiving..."
xcodebuild archive \
  -project "$IOS_DIR/Remux.xcodeproj" \
  -scheme Remux \
  -destination "generic/platform=iOS" \
  -archivePath "$BUILD_DIR/Remux.xcarchive" \
  -allowProvisioningUpdates \
  "${AUTH_ARGS[@]}" \
  -quiet

if [ ! -d "$BUILD_DIR/Remux.xcarchive" ]; then
  echo "Error: Archive failed"
  exit 1
fi
echo "✓ Archive created"

# Step 2: Export IPA for App Store / TestFlight
echo "Exporting IPA..."

cat > "$BUILD_DIR/ExportOptions.plist" << 'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>method</key>
    <string>app-store-connect</string>
    <key>signingStyle</key>
    <string>automatic</string>
    <key>uploadSymbols</key>
    <true/>
    <key>manageAppVersionAndBuildNumber</key>
    <true/>
</dict>
</plist>
PLIST

xcodebuild -exportArchive \
  -archivePath "$BUILD_DIR/Remux.xcarchive" \
  -exportOptionsPlist "$BUILD_DIR/ExportOptions.plist" \
  -exportPath "$BUILD_DIR/export" \
  -allowProvisioningUpdates \
  "${AUTH_ARGS[@]}" \
  -quiet

echo "✓ IPA exported"

# Step 3: Upload to App Store Connect (TestFlight)
echo "Uploading to TestFlight..."

IPA=$(find "$BUILD_DIR/export" -name "*.ipa" | head -1)
if [ -z "$IPA" ]; then
  echo "Error: No IPA found in export directory"
  exit 1
fi

xcrun altool --upload-app \
  --type ios \
  --file "$IPA" \
  --apiKey "$API_KEY_ID" \
  --apiIssuer "$API_ISSUER_ID"

echo ""
echo "=== Done ==="
echo "Archive: $BUILD_DIR/Remux.xcarchive"
echo "IPA:     $IPA"
echo ""
echo "Check TestFlight status: https://appstoreconnect.apple.com/apps/6761521429/testflight"
