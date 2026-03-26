#!/bin/bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=./runtime-lib.sh
source "$SCRIPT_DIR/runtime-lib.sh"

TARGET="${1:-all}"

case "$TARGET" in
  main) INSTANCES=(main) ;;
  dev) INSTANCES=(dev) ;;
  all) INSTANCES=(dev main) ;;
  *)
    echo "Usage: scripts/check-runtime-status.sh {main|dev|all}" >&2
    exit 1
    ;;
esac

git -C "$PROJECT_DIR" fetch origin --prune >/dev/null 2>&1 || true

print_api_status() {
  local label="$1"
  local url="$2"
  local json version branch sha dirty

  if ! json="$(fetch_json "$url" 2>/dev/null)"; then
    printf '  %-8s unreachable (%s)\n' "$label" "$url"
    return 0
  fi

  version="$(json_field_or_empty "$json" version 2>/dev/null || true)"
  branch="$(json_field_or_empty "$json" gitBranch 2>/dev/null || true)"
  sha="$(json_field_or_empty "$json" gitCommitSha 2>/dev/null || true)"
  dirty="$(json_field_or_empty "$json" gitDirty 2>/dev/null || true)"

  printf '  %-8s version=%s branch=%s sha=%s dirty=%s\n' "$label" "${version:-?}" "${branch:-?}" "${sha:-?}" "${dirty:-?}"
}

for instance in "${INSTANCES[@]}"; do
  branch="$(runtime_branch "$instance")"
  remote_sha="$(origin_sha_for "$instance" 2>/dev/null || true)"
  remote_version="$(origin_version_for "$instance" 2>/dev/null || true)"
  dir="$(runtime_dir "$instance")"

  echo "$instance"
  printf '  %-8s version=%s branch=%s sha=%s\n' "origin" "${remote_version:-?}" "$branch" "${remote_sha:-missing}"

  if git -C "$dir" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    worktree_sha="$(current_worktree_sha_for "$instance" 2>/dev/null || true)"
    if worktree_is_clean "$instance"; then
      worktree_dirty="false"
    else
      worktree_dirty="true"
    fi
    printf '  %-8s path=%s sha=%s dirty=%s\n' "worktree" "$dir" "${worktree_sha:-?}" "$worktree_dirty"
  else
    printf '  %-8s missing (%s)\n' "worktree" "$dir"
  fi

  print_api_status "local" "$(runtime_local_config_url "$instance")"
  print_api_status "public" "$(runtime_public_config_url "$instance")"
  echo ""
done
