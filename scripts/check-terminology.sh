#!/usr/bin/env bash
# check-terminology.sh — CI guard against banned old product terminology
# Exit 0 if clean, exit 1 if banned terms found.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# ── Banned patterns ─────────────────────────────────────────────────
# Each pattern is a grep -iE (extended regex, case-insensitive).
# We catch variants like ScrollMode, scroll mode, Scroll View, etc.

BANNED_PATTERNS=(
  # "scroll mode" / "ScrollMode" as a product feature name
  'scroll[[:space:]]*mode'
  'ScrollMode'
  # "scroll view" / "ScrollView" as a product surface name
  'scroll[[:space:]]*view'
  'ScrollView'
  # "scroll tab" / "scroll-tab" as a navigation label
  'scroll[[:space:]-]*tab'
)

# ── Exclude paths ────────────────────────────────────────────────────
EXCLUDE_ARGS=(
  --exclude-dir=.git
  --exclude-dir=node_modules
  --exclude-dir=.worktrees
  --exclude-dir=dist
  --exclude-dir=build
  --exclude-dir=vendor
  --exclude-dir=archive
)

# Files/dirs to skip (checked via post-filter on relative paths)
EXCLUDE_PATH_PATTERNS=(
  'docs/archive/'
  'scripts/check-terminology\.sh'
  'PRODUCT_ARCHITECTURE\.md'
  'docs/adr/'
)

# ── Allowlist patterns ───────────────────────────────────────────────
# Lines matching any of these are false positives and should be kept.
ALLOW_PATTERNS=(
  # xterm scrollback options / CLI flags
  'scrollback'
  '--scrollback'
  # DOM/React scroll methods
  'scrollTo'
  'scrollIntoView'
  'scrollBy'
  'scrollTop'
  'scrollLeft'
  'scrollHeight'
  'scrollWidth'
  # Wire protocol string literals (legacy compat)
  '"scrollback"'
  '"capture_scrollback"'
  # CSS scroll properties
  'overflow.*scroll'
  'scroll-behavior'
  'scrollbar'
  '-webkit-overflow-scrolling'
  # React Native ScrollView import/usage (component name, not our product term)
  'react-native.*ScrollView'
  'from.*react-native'
  '@react-native'
)

found=0
output=""
seen_keys=""  # dedup across overlapping patterns

for pattern in "${BANNED_PATTERNS[@]}"; do
  while IFS= read -r line; do
    [ -z "$line" ] && continue

    # Deduplicate: same file:line may match multiple patterns
    key="${line%%:*}:$(echo "$line" | cut -d: -f2)"
    case "$seen_keys" in
      *"|$key|"*) continue ;;
    esac
    seen_keys="${seen_keys}|${key}|"

    # Extract file path (everything before first colon)
    filepath="${line%%:*}"

    # Check if file matches any excluded path pattern
    skip=false
    for ep in "${EXCLUDE_PATH_PATTERNS[@]}"; do
      if echo "$filepath" | grep -qE "$ep"; then
        skip=true
        break
      fi
    done
    $skip && continue

    # Check if line matches any allowlist pattern
    # Extract the matching line content (after file:lineno:)
    line_content="${line#*:}"   # strip filename
    line_content="${line_content#*:}"  # strip line number

    allowed=false
    for ap in "${ALLOW_PATTERNS[@]}"; do
      if echo "$line_content" | grep -qi -- "$ap"; then
        allowed=true
        break
      fi
    done
    $allowed && continue

    # This is a real violation
    found=1
    output+="  $line"$'\n'
  done < <(grep -rniE "$pattern" "$REPO_ROOT" "${EXCLUDE_ARGS[@]}" 2>/dev/null || true)
done

if [ "$found" -eq 1 ]; then
  echo "ERROR: Banned product terminology found in the codebase:"
  echo ""
  echo "$output"
  echo "These terms were retired. Use the current terminology instead:"
  echo "  - 'Scroll mode/ScrollMode' -> use 'Capture view' or 'CaptureView'"
  echo "  - 'Scroll view/ScrollView' -> use 'Capture view' or 'CaptureView'"
  echo "  - 'Scroll tab/scroll-tab'  -> use the current navigation label"
  echo ""
  echo "If this is a false positive, update scripts/check-terminology.sh allowlist."
  exit 1
else
  echo "Terminology check passed -- no banned terms found."
  exit 0
fi
