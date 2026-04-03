#!/bin/bash
# Delegate macOS release packaging to the integrated native client workflow.
# Usage: ./scripts/build-dmg.sh [args passed through to apps/macos/scripts/build-sign-upload.sh]
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
APP_DIR="$ROOT_DIR/apps/macos"

if [ ! -d "$APP_DIR/GhosttyTabs.xcodeproj" ]; then
  echo "error: integrated macOS client not found at $APP_DIR" >&2
  exit 1
fi

cd "$APP_DIR"
exec ./scripts/build-sign-upload.sh "$@"
