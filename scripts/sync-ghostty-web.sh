#!/bin/bash
# Sync ghostty-web assets from npm package to RemuxKit bundle resources.
# Run after `pnpm install` to update the WKWebView terminal resources (iOS).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
SRC_DIR="$ROOT_DIR/node_modules/ghostty-web/dist"
DST_DIR="$ROOT_DIR/packages/RemuxKit/Sources/RemuxKit/Terminal/Resources"

if [ ! -d "$SRC_DIR" ]; then
    echo "Error: ghostty-web not found at $SRC_DIR"
    echo "Run 'pnpm install' first."
    exit 1
fi

echo "Syncing ghostty-web assets..."

# Copy main JS and WASM files
cp "$SRC_DIR/ghostty-web.js" "$DST_DIR/"
cp "$SRC_DIR/ghostty-vt.wasm" "$DST_DIR/" 2>/dev/null || true

# Record version
node -e "console.log(require('$ROOT_DIR/node_modules/ghostty-web/package.json').version)" \
    > "$DST_DIR/ghostty-web-version.txt" 2>/dev/null || echo "unknown" > "$DST_DIR/ghostty-web-version.txt"

echo "Done. ghostty-web $(cat "$DST_DIR/ghostty-web-version.txt") synced to $DST_DIR"
