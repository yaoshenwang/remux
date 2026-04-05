#!/usr/bin/env bash
# Regression test for release runner disk cleanup before macOS publish.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
REPO_ROOT="$(cd "$ROOT_DIR/../.." && pwd)"
WORKFLOW="$REPO_ROOT/.github/workflows/publish.yml"
SCRIPT="$ROOT_DIR/scripts/ci-preflight-free-space.sh"

if ! grep -Fq 'Reclaim macOS runner disk space' "$WORKFLOW"; then
  echo "FAIL: publish workflow must reclaim macOS runner disk space before release builds"
  exit 1
fi

if ! grep -Fq 'bash apps/macos/scripts/ci-preflight-free-space.sh' "$WORKFLOW"; then
  echo "FAIL: publish workflow must invoke ci-preflight-free-space.sh"
  exit 1
fi

TMPDIR_ROOT="$(mktemp -d)"
trap 'rm -rf "$TMPDIR_ROOT"' EXIT

HOME_DIR="$TMPDIR_ROOT/home"
WORKSPACE="$TMPDIR_ROOT/workspace"

mkdir -p \
  "$HOME_DIR/Library/Developer/Xcode/DerivedData/GhosttyTabs-test/Build" \
  "$HOME_DIR/Library/Caches/org.swift.swiftpm/cache" \
  "$HOME_DIR/.npm/_cacache/content-v2" \
  "$HOME_DIR/.npm/_npx/123" \
  "$WORKSPACE/apps/macos/build/output" \
  "$WORKSPACE/apps/macos/GhosttyKit.xcframework/arm64" \
  "$WORKSPACE/vendor/ghostty/.zig-cache/o" \
  "$WORKSPACE/vendor/ghostty/zig-out/bin" \
  "$WORKSPACE/vendor/ghostty/macos/GhosttyKit.xcframework/x86_64"

touch \
  "$HOME_DIR/Library/Developer/Xcode/DerivedData/GhosttyTabs-test/Build/marker" \
  "$HOME_DIR/Library/Caches/org.swift.swiftpm/cache/marker" \
  "$HOME_DIR/.npm/_cacache/content-v2/marker" \
  "$HOME_DIR/.npm/_npx/123/marker" \
  "$WORKSPACE/apps/macos/build/output/marker" \
  "$WORKSPACE/apps/macos/GhosttyKit.xcframework/arm64/marker" \
  "$WORKSPACE/vendor/ghostty/.zig-cache/o/marker" \
  "$WORKSPACE/vendor/ghostty/zig-out/bin/marker" \
  "$WORKSPACE/vendor/ghostty/macos/GhosttyKit.xcframework/x86_64/marker"

REMUX_CI_HOME_DIR="$HOME_DIR" \
REMUX_CI_WORKSPACE="$WORKSPACE" \
REMUX_CI_FREE_SPACE_PATH="$TMPDIR_ROOT" \
REMUX_CI_MIN_FREE_GB=0 \
bash "$SCRIPT" >/dev/null

for path in \
  "$HOME_DIR/Library/Developer/Xcode/DerivedData/GhosttyTabs-test" \
  "$HOME_DIR/Library/Caches/org.swift.swiftpm" \
  "$HOME_DIR/.npm/_cacache" \
  "$HOME_DIR/.npm/_npx" \
  "$WORKSPACE/apps/macos/build" \
  "$WORKSPACE/apps/macos/GhosttyKit.xcframework" \
  "$WORKSPACE/vendor/ghostty/.zig-cache" \
  "$WORKSPACE/vendor/ghostty/zig-out" \
  "$WORKSPACE/vendor/ghostty/macos/GhosttyKit.xcframework"
do
  if [ -e "$path" ]; then
    echo "FAIL: ci-preflight-free-space.sh must remove $path"
    exit 1
  fi
done

echo "PASS: ci-preflight-free-space.sh reclaims release runner caches"
