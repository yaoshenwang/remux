#!/usr/bin/env bash
set -euo pipefail

URL="${1:-https://example.com/form}"
SURFACE="${2:-surface:1}"

remux browser "$SURFACE" goto "$URL"
remux browser "$SURFACE" get url
remux browser "$SURFACE" wait --load-state complete --timeout-ms 15000
remux browser "$SURFACE" snapshot --interactive

echo "Now run fill/click commands using refs from the snapshot above."
