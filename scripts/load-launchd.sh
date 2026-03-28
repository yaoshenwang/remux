#!/bin/bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=./runtime-lib.sh
source "$SCRIPT_DIR/runtime-lib.sh"

TARGET="${1:-all}"

case "$TARGET" in
  main)
    load_shared_runtime_launchd
    load_runtime_launchd main
    ;;
  dev)
    load_shared_runtime_launchd
    load_runtime_launchd dev
    ;;
  shared|shared-runtime)
    load_shared_runtime_launchd
    ;;
  runtime)
    load_shared_runtime_launchd
    load_runtime_launchd main
    load_runtime_launchd dev
    ;;
  sync)
    load_sync_launchd
    ;;
  all)
    load_shared_runtime_launchd
    load_runtime_launchd main
    load_runtime_launchd dev
    load_sync_launchd
    ;;
  *)
    echo "Usage: scripts/load-launchd.sh {main|dev|shared|shared-runtime|runtime|sync|all}" >&2
    exit 1
    ;;
esac
