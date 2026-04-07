#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: ./scripts/bundle-runtime-binaries.sh <app-path> [<app-path> ...]

Builds runtime helper binaries and copies them into each app bundle's
Contents/Resources/bin directory.

Bundled artifacts:
  - remux-agent (macOS arm64 build)
  - remux-agent-linux-x86_64
  - remux-agent-linux-aarch64
  - remuxd (native macOS build, only if ./remuxd exists)
EOF
}

if [[ $# -lt 1 ]]; then
  usage >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

if ! command -v zig >/dev/null 2>&1; then
  echo "zig is required to bundle runtime binaries" >&2
  exit 1
fi

ARTIFACT_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/remux-runtime-binaries.XXXXXX")"
ARTIFACT_BIN_DIR="$ARTIFACT_ROOT/bin"
mkdir -p "$ARTIFACT_BIN_DIR"
trap 'rm -rf "$ARTIFACT_ROOT"' EXIT

build_zig_artifact() {
  local source_dir="$1"
  local binary_name="$2"
  local output_name="$3"
  shift 3

  if [[ ! -d "$PROJECT_DIR/$source_dir" ]]; then
    return 0
  fi

  local prefix_dir="$ARTIFACT_ROOT/prefix-$output_name"
  rm -rf "$prefix_dir"
  mkdir -p "$prefix_dir"

  local zig_env=()
  for arg in "$@"; do
    if [[ "$arg" == -Dtarget=*macos* ]]; then
      local sdk_path
      sdk_path="$(xcrun --sdk macosx --show-sdk-path)"
      zig_env=(env "C_INCLUDE_PATH=$sdk_path/usr/include")
      break
    fi
  done

  (
    cd "$PROJECT_DIR/$source_dir"
    if [[ ${#zig_env[@]} -gt 0 ]]; then
      "${zig_env[@]}" zig build -Doptimize=ReleaseFast "$@" --prefix "$prefix_dir"
    else
      zig build -Doptimize=ReleaseFast "$@" --prefix "$prefix_dir"
    fi
  )

  local built_binary="$prefix_dir/bin/$binary_name"
  if [[ ! -x "$built_binary" ]]; then
    echo "missing built binary: $built_binary" >&2
    exit 1
  fi

  cp "$built_binary" "$ARTIFACT_BIN_DIR/$output_name"
  chmod +x "$ARTIFACT_BIN_DIR/$output_name"
}

build_zig_artifact "agent" "remux-agent" "remux-agent" -Dtarget=aarch64-macos
build_zig_artifact "agent" "remux-agent" "remux-agent-linux-x86_64" -Dtarget=x86_64-linux-gnu
build_zig_artifact "agent" "remux-agent" "remux-agent-linux-aarch64" -Dtarget=aarch64-linux-gnu
build_zig_artifact "remuxd" "remuxd" "remuxd"

if [[ -z "$(find "$ARTIFACT_BIN_DIR" -mindepth 1 -maxdepth 1 -type f -print -quit)" ]]; then
  echo "no runtime binaries were built" >&2
  exit 1
fi

for app_path in "$@"; do
  if [[ ! -d "$app_path" ]]; then
    echo "app not found: $app_path" >&2
    exit 1
  fi

  bin_dir="$app_path/Contents/Resources/bin"
  mkdir -p "$bin_dir"

  while IFS= read -r artifact_path; do
    artifact_name="$(basename "$artifact_path")"
    cp "$artifact_path" "$bin_dir/$artifact_name"
    chmod +x "$bin_dir/$artifact_name"
  done < <(find "$ARTIFACT_BIN_DIR" -mindepth 1 -maxdepth 1 -type f | sort)
done
