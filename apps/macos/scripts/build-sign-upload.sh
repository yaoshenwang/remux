#!/usr/bin/env bash
set -euo pipefail

# Build, sign, notarize, create DMG, generate appcast, and upload to GitHub release.
# Usage: ./scripts/build-sign-upload.sh <tag> [--allow-overwrite]
# Requires: source ~/.secrets/remux.env && export SPARKLE_PRIVATE_KEY

usage() {
  cat <<'EOF'
Usage: ./scripts/build-sign-upload.sh <tag> [--allow-overwrite]

Options:
  --allow-overwrite   Permit replacing existing release assets for the same tag.
                      Use only for emergency rerolls.
EOF
}

ALLOW_OVERWRITE="false"
POSITIONAL=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --allow-overwrite)
      ALLOW_OVERWRITE="true"
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    -*)
      echo "Unknown option: $1" >&2
      usage >&2
      exit 1
      ;;
    *)
      POSITIONAL+=("$1")
      shift
      ;;
  esac
done
set -- "${POSITIONAL[@]}"

if [[ $# -ne 1 ]]; then
  usage >&2
  exit 1
fi

TAG="$1"
VERSION="${TAG#v}"
REPO_SLUG="yaoshenwang/remux"
SIGN_HASH="A050CC7E193C8221BDBA204E731B046CDCCC1B30"
ENTITLEMENTS="remux.entitlements"
APP_PATH="build/Build/Products/Release/remux.app"
REMOTE_ASSET_DIR="$(mktemp -d "${TMPDIR:-/tmp}/remux-release-assets.XXXXXX")"
trap 'rm -rf "$REMOTE_ASSET_DIR" build/ remux-macos.dmg appcast.xml' EXIT

# --- Pre-flight ---
source ~/.secrets/remux.env
export SPARKLE_PRIVATE_KEY
for tool in zig xcodebuild create-dmg xcrun codesign ditto gh go python3 plutil; do
  command -v "$tool" >/dev/null || { echo "MISSING: $tool" >&2; exit 1; }
done
echo "Pre-flight checks passed"

# --- Build GhosttyKit (if needed) ---
if [ ! -d "GhosttyKit.xcframework" ]; then
  echo "Building GhosttyKit..."
  cd ghostty && zig build -Demit-xcframework=true -Demit-macos-app=false -Dxcframework-target=universal -Doptimize=ReleaseFast && cd ..
  rm -rf GhosttyKit.xcframework
  cp -R ghostty/macos/GhosttyKit.xcframework GhosttyKit.xcframework
else
  echo "GhosttyKit.xcframework exists, skipping build"
fi

# --- Build app (Release, unsigned) ---
echo "Building app..."
rm -rf build/
xcodebuild -scheme remux -configuration Release -derivedDataPath build CODE_SIGNING_ALLOWED=NO build 2>&1 | tail -5
echo "Build succeeded"

HELPER_PATH="$APP_PATH/Contents/Resources/bin/ghostty"
if [ ! -x "$HELPER_PATH" ]; then
  echo "Ghostty theme picker helper not found at $HELPER_PATH" >&2
  exit 1
fi

# --- Build remote daemon release assets and embed manifest ---
echo "Building remote daemon release assets..."
./scripts/build_remote_daemon_release_assets.sh \
  --version "$VERSION" \
  --release-tag "$TAG" \
  --repo "$REPO_SLUG" \
  --output-dir "$REMOTE_ASSET_DIR"

REMOTE_MANIFEST_PATH="$REMOTE_ASSET_DIR/remuxd-remote-manifest.json"
if [ ! -f "$REMOTE_MANIFEST_PATH" ]; then
  echo "Missing remote daemon manifest at $REMOTE_MANIFEST_PATH" >&2
  exit 1
fi

# --- Inject Sparkle keys ---
echo "Injecting Sparkle keys..."
SPARKLE_PUBLIC_KEY_DERIVED=$(swift scripts/derive_sparkle_public_key.swift "$SPARKLE_PRIVATE_KEY")
REMOTE_MANIFEST_JSON=$(
  python3 -c 'import json, sys; print(json.dumps(json.load(open(sys.argv[1])), separators=(",", ":")))' \
    "$REMOTE_MANIFEST_PATH"
)
APP_PLIST="$APP_PATH/Contents/Info.plist"
/usr/libexec/PlistBuddy -c "Delete :SUPublicEDKey" "$APP_PLIST" 2>/dev/null || true
/usr/libexec/PlistBuddy -c "Delete :SUFeedURL" "$APP_PLIST" 2>/dev/null || true
/usr/libexec/PlistBuddy -c "Add :SUPublicEDKey string $SPARKLE_PUBLIC_KEY_DERIVED" "$APP_PLIST"
/usr/libexec/PlistBuddy -c "Add :SUFeedURL string https://github.com/yaoshenwang/remux/releases/latest/download/appcast.xml" "$APP_PLIST"
plutil -remove REMUXRemoteDaemonManifestJSON "$APP_PLIST" >/dev/null 2>&1 || true
plutil -insert REMUXRemoteDaemonManifestJSON -string "$REMOTE_MANIFEST_JSON" "$APP_PLIST"
echo "Sparkle keys injected"

# --- Codesign ---
echo "Codesigning..."
CLI_PATH="$APP_PATH/Contents/Resources/bin/remux"
if [ -f "$CLI_PATH" ]; then
  /usr/bin/codesign --force --options runtime --timestamp --sign "$SIGN_HASH" --entitlements "$ENTITLEMENTS" "$CLI_PATH"
fi
if [ -f "$HELPER_PATH" ]; then
  /usr/bin/codesign --force --options runtime --timestamp --sign "$SIGN_HASH" --entitlements "$ENTITLEMENTS" "$HELPER_PATH"
fi
/usr/bin/codesign --force --options runtime --timestamp --sign "$SIGN_HASH" --entitlements "$ENTITLEMENTS" --deep "$APP_PATH"
/usr/bin/codesign --verify --deep --strict --verbose=2 "$APP_PATH"
echo "Codesign verified"

# --- Notarize app ---
echo "Notarizing app..."
ditto -c -k --sequesterRsrc --keepParent "$APP_PATH" remux-notary.zip
xcrun notarytool submit remux-notary.zip \
  --apple-id "$APPLE_ID" --team-id "$APPLE_TEAM_ID" --password "$APPLE_APP_SPECIFIC_PASSWORD" --wait
xcrun stapler staple "$APP_PATH"
xcrun stapler validate "$APP_PATH"
rm -f remux-notary.zip
echo "App notarized"

# --- Create and notarize DMG ---
echo "Creating DMG..."
rm -f remux-macos.dmg
create-dmg --codesign "$SIGN_HASH" remux-macos.dmg "$APP_PATH"
echo "Notarizing DMG..."
xcrun notarytool submit remux-macos.dmg \
  --apple-id "$APPLE_ID" --team-id "$APPLE_TEAM_ID" --password "$APPLE_APP_SPECIFIC_PASSWORD" --wait
xcrun stapler staple remux-macos.dmg
xcrun stapler validate remux-macos.dmg
echo "DMG notarized"

# --- Generate Sparkle appcast ---
echo "Generating appcast..."
./scripts/sparkle_generate_appcast.sh remux-macos.dmg "$TAG" appcast.xml

REMOTE_RELEASE_ASSET_PATHS=( "$REMOTE_ASSET_DIR"/remuxd-remote-* )
RELEASE_ASSET_PATHS=( remux-macos.dmg appcast.xml "${REMOTE_RELEASE_ASSET_PATHS[@]}" )
RELEASE_ASSET_NAMES=()
for asset_path in "${RELEASE_ASSET_PATHS[@]}"; do
  RELEASE_ASSET_NAMES+=( "$(basename "$asset_path")" )
done

# --- Create GitHub release (if needed) and upload ---
if gh release view "$TAG" >/dev/null 2>&1; then
  echo "Release $TAG already exists"
  EXISTING_ASSETS="$(gh release view "$TAG" --json assets --jq '.assets[].name' || true)"
  HAS_CONFLICTING_ASSET="false"
  for asset in "${RELEASE_ASSET_NAMES[@]}"; do
    if printf '%s\n' "$EXISTING_ASSETS" | grep -Fxq "$asset"; then
      HAS_CONFLICTING_ASSET="true"
      break
    fi
  done

  if [[ "$HAS_CONFLICTING_ASSET" == "true" && "$ALLOW_OVERWRITE" != "true" ]]; then
    echo "ERROR: Refusing to overwrite signed release assets for existing tag $TAG." >&2
    echo "Use a new tag, or rerun with --allow-overwrite for an emergency reroll." >&2
    exit 1
  fi

  if [[ "$ALLOW_OVERWRITE" == "true" ]]; then
    echo "Uploading with overwrite enabled for existing release $TAG..."
    gh release upload "$TAG" "${RELEASE_ASSET_PATHS[@]}" --clobber
  else
    echo "Uploading to existing release $TAG..."
    gh release upload "$TAG" "${RELEASE_ASSET_PATHS[@]}"
  fi
else
  echo "Creating release $TAG and uploading..."
  gh release create "$TAG" "${RELEASE_ASSET_PATHS[@]}" --title "$TAG" --notes "See CHANGELOG.md for details"
fi

# --- Verify ---
gh release view "$TAG"

# --- Update Homebrew cask (skip for nightlies) ---
if [[ "${REMUX_SKIP_HOMEBREW_UPDATE:-false}" != "true" && "$TAG" != *"-nightly"* ]]; then
  VERSION="${TAG#v}"
  DMG_SHA256=$(shasum -a 256 remux-macos.dmg | cut -d' ' -f1)
  echo "Updating homebrew cask to $VERSION (SHA: $DMG_SHA256)..."
  CASK_FILE="homebrew-remux/Casks/remux.rb"
  if [ -f "$CASK_FILE" ]; then
    cat > "$CASK_FILE" << CASKEOF
cask "remux" do
  version "${VERSION}"
  sha256 "${DMG_SHA256}"

  url "https://github.com/yaoshenwang/remux/releases/download/v#{version}/remux-macos.dmg"
  name "remux"
  desc "Remux native macOS client"
  homepage "https://github.com/yaoshenwang/remux"

  livecheck do
    url :url
    strategy :github_latest
  end

  depends_on macos: ">= :ventura"

  app "remux.app"
  binary "#{appdir}/remux.app/Contents/Resources/bin/remux"

  zap trash: [
    "~/Library/Application Support/remux",
    "~/Library/Caches/remux",
    "~/Library/Preferences/com.remux.macos.plist",
  ]
end
CASKEOF
    cd homebrew-remux
    git add Casks/remux.rb
    if git diff --staged --quiet; then
      echo "Homebrew cask already up to date"
    else
      git commit -m "Update remux to ${VERSION}"
      git push
      echo "Homebrew cask updated"
    fi
    cd ..
  else
    echo "WARNING: homebrew-remux submodule not found, skipping cask update"
  fi
fi

echo ""
echo "=== Release $TAG complete ==="
say "remux release complete"
