#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_ROOT="$(cd "$APP_DIR/../.." && pwd)"
WORKSPACE="${REMUX_CI_WORKSPACE:-${GITHUB_WORKSPACE:-$REPO_ROOT}}"
HOME_DIR="${REMUX_CI_HOME_DIR:-$HOME}"
FREE_SPACE_PATH="${REMUX_CI_FREE_SPACE_PATH:-$WORKSPACE}"
REMUX_CI_MIN_FREE_GB="${REMUX_CI_MIN_FREE_GB:-8}"

print_free_space() {
  echo "Free space snapshot for $FREE_SPACE_PATH"
  df -h "$FREE_SPACE_PATH"
}

remove_if_present() {
  local target
  for target in "$@"; do
    if [[ -e "$target" ]]; then
      rm -rf "$target"
      echo "Removed $target"
    fi
  done
}

available_kb() {
  df -Pk "$FREE_SPACE_PATH" | awk 'NR==2 { print $4 }'
}

main() {
  local -a cleanup_targets=(
    "$WORKSPACE/apps/macos/build"
    "$WORKSPACE/apps/macos/GhosttyKit.xcframework"
    "$WORKSPACE/vendor/ghostty/.zig-cache"
    "$WORKSPACE/vendor/ghostty/zig-out"
    "$WORKSPACE/vendor/ghostty/macos/GhosttyKit.xcframework"
    "$HOME_DIR/Library/Caches/org.swift.swiftpm"
    "$HOME_DIR/.npm/_cacache"
    "$HOME_DIR/.npm/_npx"
  )
  local -a derived_data_targets=()
  local target
  local free_kb
  local required_kb

  shopt -s nullglob
  derived_data_targets=(
    "$HOME_DIR"/Library/Developer/Xcode/DerivedData/GhosttyTabs-*
  )
  shopt -u nullglob

  echo "Reclaiming release runner caches..."
  print_free_space
  remove_if_present "${cleanup_targets[@]}" "${derived_data_targets[@]}"
  print_free_space

  free_kb="$(available_kb)"
  required_kb=$((REMUX_CI_MIN_FREE_GB * 1024 * 1024))
  if (( free_kb < required_kb )); then
    echo "Insufficient free space after cleanup: ${free_kb}KB available, need at least ${required_kb}KB" >&2
    exit 1
  fi

  echo "macOS release preflight passed with ${free_kb}KB free"
}

main "$@"
