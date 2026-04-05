#!/usr/bin/env bash
# Regression test for universal GhosttyKit and Release build settings.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
REPO_ROOT="$(cd "$ROOT_DIR/../.." && pwd)"

for file in \
  "$REPO_ROOT/scripts/build-ghostty-kit.sh" \
  "$ROOT_DIR/.github/workflows/build-ghosttykit.yml" \
  "$ROOT_DIR/scripts/setup.sh" \
  "$ROOT_DIR/scripts/build-sign-upload.sh"
do
  if ! grep -Fq -- '-Dxcframework-target=universal' "$file"; then
    echo "FAIL: $file must build GhosttyKit with -Dxcframework-target=universal"
    exit 1
  fi
done

for file in \
  "$REPO_ROOT/vendor/ghostty/include/ghostty.h" \
  "$REPO_ROOT/vendor/ghostty/src/apprt/embedded.zig"
do
  if ! grep -Fq -- 'ghostty_surface_select_cursor_cell' "$file"; then
    echo "FAIL: $file must expose ghostty_surface_select_cursor_cell for vendor GhosttyKit builds"
    exit 1
  fi
  if ! grep -Fq -- 'ghostty_surface_clear_selection' "$file"; then
    echo "FAIL: $file must expose ghostty_surface_clear_selection for vendor GhosttyKit builds"
    exit 1
  fi
done

if ! grep -Fq -- 'pub fn selectCursorCell(self: *Surface) !bool' "$REPO_ROOT/vendor/ghostty/src/Surface.zig"; then
  echo "FAIL: vendor/ghostty/src/Surface.zig must provide selectCursorCell for stable macOS builds"
  exit 1
fi

if grep -Fq -- '| tail -5' "$ROOT_DIR/scripts/build-sign-upload.sh"; then
  echo "FAIL: build-sign-upload.sh must not truncate xcodebuild errors with tail -5"
  exit 1
fi

if ! grep -Fq -- 'tee "$BUILD_LOG"' "$ROOT_DIR/scripts/build-sign-upload.sh"; then
  echo "FAIL: build-sign-upload.sh must preserve the full xcodebuild log"
  exit 1
fi

if ! grep -Fq -- 'SIGN_IDENTITY_RESOLVER="$SCRIPT_DIR/resolve-signing-identity.sh"' "$ROOT_DIR/scripts/build-sign-upload.sh"; then
  echo "FAIL: build-sign-upload.sh must delegate signing identity selection to resolve-signing-identity.sh"
  exit 1
fi

if ! grep -Fq -- 'SIGN_HASH="$("$SIGN_IDENTITY_RESOLVER")"' "$ROOT_DIR/scripts/build-sign-upload.sh"; then
  echo "FAIL: build-sign-upload.sh must resolve the signing identity dynamically from the keychain"
  exit 1
fi

if ! grep -Fq -- 'ENTITLEMENTS="$APP_DIR/remux.entitlements"' "$ROOT_DIR/scripts/build-sign-upload.sh"; then
  echo "FAIL: build-sign-upload.sh must sign with apps/macos/remux.entitlements"
  exit 1
fi

if ! grep -Fq -- 'plutil -lint "$ENTITLEMENTS" >/dev/null' "$ROOT_DIR/scripts/build-sign-upload.sh"; then
  echo "FAIL: build-sign-upload.sh must lint the release entitlements before codesign"
  exit 1
fi

if ! grep -Fq -- 'Developer ID Application' "$ROOT_DIR/scripts/resolve-signing-identity.sh"; then
  echo "FAIL: resolve-signing-identity.sh must look up a Developer ID Application identity"
  exit 1
fi

if ! plutil -lint "$ROOT_DIR/remux.entitlements" >/dev/null; then
  echo "FAIL: apps/macos/remux.entitlements must be a valid plist"
  exit 1
fi

if ! grep -Fq -- 'MONOREPO_GHOSTTY_DIR="$MONOREPO_ROOT/vendor/ghostty"' "$ROOT_DIR/scripts/build-ghostty-cli-helper.sh"; then
  echo "FAIL: build-ghostty-cli-helper.sh must define a monorepo vendor/ghostty fallback"
  exit 1
fi

if ! grep -Fq -- 'falling back to monorepo vendor/ghostty' "$ROOT_DIR/scripts/build-ghostty-cli-helper.sh"; then
  echo "FAIL: build-ghostty-cli-helper.sh must fall back to vendor/ghostty when apps/macos/ghostty is incomplete"
  exit 1
fi

if ! grep -Fq -- 'using monorepo vendor/ghostty' "$ROOT_DIR/scripts/setup.sh"; then
  echo "FAIL: setup.sh must fall back to vendor/ghostty when apps/macos/ghostty is incomplete"
  exit 1
fi

if ! grep -Fq -- 'b.step("cli-helper", "Build the Ghostty CLI helper")' "$REPO_ROOT/vendor/ghostty/build.zig"; then
  echo "FAIL: vendor/ghostty/build.zig must expose a cli-helper step for the Xcode Run Script fallback"
  exit 1
fi

if ! grep -Fq -- 'cli_helper_step.dependOn(&exe.install_step.step);' "$REPO_ROOT/vendor/ghostty/build.zig"; then
  echo "FAIL: vendor/ghostty/build.zig must wire cli-helper to the installed ghostty binary"
  exit 1
fi

if ! awk '
  /\/\* Release \*\// { in_release=1; next }
  in_release && /ONLY_ACTIVE_ARCH = YES;/ { saw_yes=1 }
  in_release && /ONLY_ACTIVE_ARCH = NO;/ { saw_no=1 }
  in_release && /name = Release;/ { in_release=0 }
  END { exit !(saw_no && !saw_yes) }
' "$ROOT_DIR/GhosttyTabs.xcodeproj/project.pbxproj"; then
  echo "FAIL: Release configurations in project.pbxproj must use ONLY_ACTIVE_ARCH = NO"
  exit 1
fi

echo "PASS: GhosttyKit builds universal and Release configs disable ONLY_ACTIVE_ARCH"
