#!/bin/bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=./runtime-lib.sh
source "$SCRIPT_DIR/runtime-lib.sh"

TARGET="${1:-all}"

case "$TARGET" in
  main)
    ensure_shared_runtime_worktree
    ensure_runtime_worktree main
    load_shared_runtime_launchd
    load_runtime_launchd main
    ;;
  dev)
    ensure_shared_runtime_worktree
    ensure_runtime_worktree dev
    load_shared_runtime_launchd
    load_runtime_launchd dev
    ;;
  shared|shared-runtime)
    ensure_shared_runtime_worktree
    load_shared_runtime_launchd
    ;;
  runtime)
    ensure_shared_runtime_worktree
    ensure_runtime_worktree main
    ensure_runtime_worktree dev
    load_shared_runtime_launchd
    load_runtime_launchd main
    load_runtime_launchd dev
    ;;
  sync)
    load_sync_launchd
    ;;
  all)
    ensure_shared_runtime_worktree
    ensure_runtime_worktree main
    ensure_runtime_worktree dev
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
