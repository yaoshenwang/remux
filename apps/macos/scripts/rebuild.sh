#!/bin/bash
# Rebuild and restart remux app

set -e

cd "$(dirname "$0")/.."

# Kill existing app if running
pkill -9 -f "remux" 2>/dev/null || true

# Build
swift build

# Copy to app bundle
cp .build/debug/remux .build/debug/remux.app/Contents/MacOS/

# Open the app
open .build/debug/remux.app
