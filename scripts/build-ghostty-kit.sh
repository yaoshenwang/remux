#!/bin/bash
# Build GhosttyKit.xcframework from the ghostty submodule.
# Prerequisites: zig (brew install zig), Xcode Command Line Tools
# Usage: ./scripts/build-ghostty-kit.sh [--debug]

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
GHOSTTY_DIR="$ROOT_DIR/vendor/ghostty"

if [ ! -f "$GHOSTTY_DIR/build.zig" ]; then
    echo "Error: ghostty submodule not found at $GHOSTTY_DIR"
    echo "Run: git submodule update --init vendor/ghostty"
    exit 1
fi

if ! command -v zig &> /dev/null; then
    echo "Error: zig not found. Install with: brew install zig"
    exit 1
fi

OPTIMIZE="ReleaseFast"
if [ "${1:-}" = "--debug" ]; then
    OPTIMIZE="Debug"
fi

echo "Building GhosttyKit.xcframework (optimize=$OPTIMIZE)..."
cd "$GHOSTTY_DIR"
zig build -Demit-xcframework=true -Doptimize="$OPTIMIZE"

# Check output — ghostty emits to macos/GhosttyKit.xcframework
XCFW_PATH="$GHOSTTY_DIR/macos/GhosttyKit.xcframework"
if [ -d "$XCFW_PATH" ]; then
    echo "Success: $XCFW_PATH"
    echo "Size: $(du -sh "$XCFW_PATH" | cut -f1)"
else
    echo "Error: xcframework not found at expected path"
    echo "Checking macos/ and zig-out/ contents:"
    ls -la "$GHOSTTY_DIR/macos/" 2>/dev/null || echo "macos/ not found"
    ls -la "$GHOSTTY_DIR/zig-out/" 2>/dev/null || echo "zig-out/ not found"
    exit 1
fi
