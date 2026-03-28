#!/bin/bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=./runtime-lib.sh
source "$SCRIPT_DIR/runtime-lib.sh"

VERIFY_PUBLIC=false
DRY_RUN=false
TARGET="${1:-all}"

if [[ $# -gt 0 ]]; then
  shift
fi

while [[ $# -gt 0 ]]; do
  case "$1" in
    --verify-public)
      VERIFY_PUBLIC=true
      shift
      ;;
    --dry-run)
      DRY_RUN=true
      shift
      ;;
    *)
      echo "Usage: scripts/sync-runtime.sh {main|dev|all} [--verify-public] [--dry-run]" >&2
      exit 1
      ;;
  esac
done

case "$TARGET" in
  main) INSTANCES=(main) ;;
  dev) INSTANCES=(dev) ;;
  all) INSTANCES=(dev main) ;;
  *)
    echo "Usage: scripts/sync-runtime.sh {main|dev|all} [--verify-public] [--dry-run]" >&2
    exit 1
    ;;
esac

cleanup() {
  release_sync_lock
}
trap cleanup EXIT

acquire_sync_lock || exit 0
git -C "$PROJECT_DIR" fetch origin --prune
ensure_runtime_worktree dev
verify_shared_runtime_plist

if [[ "$DRY_RUN" == true ]]; then
  echo "[sync] dry-run shared runtime-v2 daemon"
  echo "  workdir:      $(runtime_shared_workdir)"
  echo "  base url:     $(runtime_shared_base_url)"
else
  echo "[sync] ensuring shared runtime-v2 daemon"
  ensure_shared_runtime_running
fi

sync_instance() {
  local name="$1"
  local branch dir current_sha target_sha target_version previous_sha local_json local_sha local_branch local_dirty
  local needs_checkout=false
  local needs_restart=false
  local needs_install=true

  verify_runtime_plist "$name"
  ensure_runtime_worktree "$name"

  branch="$(runtime_branch "$name")"
  dir="$(runtime_dir "$name")"
  current_sha="$(current_worktree_sha_for "$name")"
  target_sha="$(origin_sha_for "$name")"
  target_version="$(origin_version_for "$name")"
  previous_sha="$current_sha"

  if [[ "$current_sha" != "$target_sha" ]]; then
    needs_checkout=true
    needs_restart=true
    if git -C "$dir" diff --quiet "$current_sha" "$target_sha" -- package.json package-lock.json; then
      needs_install=false
    fi
  fi

  if ! worktree_is_clean "$name"; then
    echo "[sync] runtime worktree for $name is dirty: $dir" >&2
    return 1
  fi

  if local_json="$(fetch_json "$(runtime_local_config_url "$name")" 2>/dev/null)"; then
    local_sha="$(json_field_or_empty "$local_json" gitCommitSha 2>/dev/null || true)"
    local_branch="$(json_field_or_empty "$local_json" gitBranch 2>/dev/null || true)"
    local_dirty="$(json_field_or_empty "$local_json" gitDirty 2>/dev/null || true)"
    if [[ "$local_sha" != "$target_sha" || "$local_branch" != "$branch" || "$local_dirty" != "false" ]]; then
      needs_restart=true
    fi
  else
    needs_restart=true
  fi

  if ! loaded_runtime_service_matches_expected "$name"; then
    needs_restart=true
  fi

  if [[ "$needs_checkout" == false && "$needs_restart" == false ]]; then
    echo "[sync] $name already aligned at $target_version ($target_sha)"
    if [[ "$VERIFY_PUBLIC" == true ]]; then
      verify_public_runtime "$name" "$target_sha" "$branch" "$target_version"
      echo "[sync] verified public $name at $target_sha"
    fi
    return 0
  fi

  if [[ "$DRY_RUN" == true ]]; then
    echo "[sync] dry-run $name"
    echo "  branch:       $branch"
    echo "  target sha:   $target_sha"
    echo "  current sha:  $current_sha"
    echo "  checkout:     $needs_checkout"
    echo "  npm ci:       $needs_install"
    echo "  restart:      $needs_restart"
    return 0
  fi

  echo "[sync] aligning $name -> origin/$branch ($target_version / $target_sha)"
  if [[ "$needs_checkout" == true ]]; then
    git -C "$dir" checkout --detach "$target_sha"
  fi

  if [[ "$needs_install" == true || ! -d "$dir/node_modules" ]]; then
    echo "[sync] npm ci in $dir"
    install_runtime_dependencies "$dir"
  fi

  echo "[sync] quality gate for $name"
  run_runtime_npm "$dir" run typecheck
  run_runtime_npm "$dir" test
  run_runtime_npm "$dir" run build

  echo "[sync] restarting $name"
  restart_runtime_service "$name"

  echo "[sync] waiting for local $name runtime"
  if ! wait_for_runtime_api "$name" "$target_sha" "$branch" "$target_version"; then
    echo "[sync] local runtime verification failed for $name" >&2
    return 1
  fi

  if [[ "$VERIFY_PUBLIC" == true ]]; then
    echo "[sync] waiting for public $name runtime"
    verify_public_runtime "$name" "$target_sha" "$branch" "$target_version"
  fi

  echo "[sync] $name aligned at $target_version ($target_sha)"
}

for instance in "${INSTANCES[@]}"; do
  sync_instance "$instance"
done
