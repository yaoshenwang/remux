#!/bin/bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=./runtime-lib.sh
source "$SCRIPT_DIR/runtime-lib.sh"

VERIFY_PUBLIC=false
DRY_RUN=false
PROMOTE_SHARED_RUNTIME=false
TARGET="${1:-all}"

usage() {
  echo "Usage: scripts/sync-runtime.sh {main|dev|all} [--verify-public] [--dry-run] [--promote-shared-runtime]" >&2
}

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
    --promote-shared-runtime)
      PROMOTE_SHARED_RUNTIME=true
      shift
      ;;
    *)
      usage
      exit 1
      ;;
  esac
done

case "$TARGET" in
  main) INSTANCES=(main) ;;
  dev) INSTANCES=(dev) ;;
  all) INSTANCES=(dev main) ;;
  *)
    usage
    exit 1
    ;;
esac

package_version_for_ref() {
  local dir="$1"
  local ref="${2:-HEAD}"

  git -C "$dir" show "$ref:package.json" \
    | "$(resolve_runtime_node_bin)" -e 'let raw="";process.stdin.on("data",d=>raw+=d);process.stdin.on("end",()=>process.stdout.write(JSON.parse(raw).version));'
}

runtime_local_base_url() {
  ensure_instance_name "$1"
  echo "http://127.0.0.1:$(runtime_port "$1")"
}

run_gateway_healthcheck() {
  local name="$1"
  local base_url="$2"

  echo "[sync] healthcheck $name via $base_url"
  "$(resolve_runtime_node_bin)" "$PROJECT_DIR/scripts/runtime-healthcheck.mjs" \
    --url "$base_url" \
    --token "$(runtime_token "$name")" \
    --timeout-ms 8000
}

run_gateway_healthchecks() {
  local name="$1"

  run_gateway_healthcheck "$name" "$(runtime_local_base_url "$name")"
  if [[ "$VERIFY_PUBLIC" == true ]]; then
    run_gateway_healthcheck "$name" "$(runtime_public_url "$name")"
  fi
}

shared_runtime_promote_report() {
  local status="$1"
  local before_json="$2"
  local target_json="$3"
  local after_json="$4"
  local main_gateway_json="$5"
  local dev_gateway_json="$6"
  local report_dir report_path

  report_dir="$RUNTIME_STATE_ROOT/reports"
  report_path="$report_dir/shared-runtime-promote-$(date -u +"%Y%m%dT%H%M%SZ").json"
  mkdir -p "$report_dir"

  "$(resolve_runtime_node_bin)" - "$report_path" "$status" "$before_json" "$target_json" "$after_json" "$main_gateway_json" "$dev_gateway_json" <<'NODE'
const fs = require("fs");

const [reportPath, status, beforeRaw, targetRaw, afterRaw, mainRaw, devRaw] = process.argv.slice(2);
const parse = (raw) => (raw ? JSON.parse(raw) : null);

fs.writeFileSync(
  reportPath,
  JSON.stringify(
    {
      status,
      generatedAt: new Date().toISOString(),
      beforeSharedRuntime: parse(beforeRaw),
      targetSharedRuntimeContract: parse(targetRaw),
      afterSharedRuntime: parse(afterRaw),
      gateways: {
        main: parse(mainRaw),
        dev: parse(devRaw),
      },
    },
    null,
    2,
  ),
);
NODE

  echo "[sync] shared runtime promote report ($status)"
  echo "  report:       $report_path"
  if [[ -n "$before_json" ]]; then
    echo "  before:       $(runtime_contract_summary "$before_json")"
  fi
  echo "  target:       $(runtime_contract_summary "$target_json")"
  echo "  gateway main: $(runtime_contract_summary "$main_gateway_json") compat=$(runtime_contract_compat_label "$target_json" "$main_gateway_json")"
  echo "  gateway dev:  $(runtime_contract_summary "$dev_gateway_json") compat=$(runtime_contract_compat_label "$target_json" "$dev_gateway_json")"
  if [[ -n "$after_json" ]]; then
    echo "  after:        $(runtime_contract_summary "$after_json")"
  fi
}

verify_shared_runtime_target_compatible() {
  local target_json="$1"
  local main_gateway_json="$2"
  local dev_gateway_json="$3"
  local failed=false

  if ! runtime_contract_matches "$target_json" "$main_gateway_json"; then
    echo "[sync] shared runtime target is incompatible with main gateway source: $(runtime_contract_diff_summary "$target_json" "$main_gateway_json")" >&2
    failed=true
  fi

  if ! runtime_contract_matches "$target_json" "$dev_gateway_json"; then
    echo "[sync] shared runtime target is incompatible with dev gateway source: $(runtime_contract_diff_summary "$target_json" "$dev_gateway_json")" >&2
    failed=true
  fi

  if [[ "$failed" == true ]]; then
    return 1
  fi

  return 0
}

restart_and_verify_gateway() {
  local name="$1"
  local branch dir sha version

  ensure_runtime_worktree "$name"
  verify_runtime_plist "$name"

  branch="$(runtime_branch "$name")"
  dir="$(runtime_dir "$name")"
  sha="$(current_worktree_sha_for "$name")"
  version="$(package_version_for_ref "$dir" HEAD)"

  echo "[sync] restarting $name after shared runtime change"
  restart_runtime_service "$name"
  wait_for_runtime_api "$name" "$sha" "$branch" "$version"
  if [[ "$VERIFY_PUBLIC" == true ]]; then
    verify_public_runtime "$name" "$sha" "$branch" "$version"
  fi
}

rollback_runtime_instance() {
  local name="$1"
  local previous_sha="$2"
  local previous_version="$3"
  local target_sha="$4"
  local branch dir

  if [[ -z "$previous_sha" || "$previous_sha" == "$target_sha" ]]; then
    echo "[sync] unable to roll back $name: missing previous sha" >&2
    return 1
  fi

  ensure_runtime_worktree "$name"
  verify_runtime_plist "$name"

  branch="$(runtime_branch "$name")"
  dir="$(runtime_dir "$name")"

  echo "[sync] rolling back $name -> $previous_version ($previous_sha)"
  git -C "$dir" checkout --detach "$previous_sha"

  if ! git -C "$dir" diff --quiet "$previous_sha" "$target_sha" -- package.json package-lock.json; then
    echo "[sync] npm ci in $dir for rollback"
    install_runtime_dependencies "$dir"
  fi

  run_runtime_npm "$dir" run build
  restart_runtime_service "$name"
  wait_for_runtime_api "$name" "$previous_sha" "$branch" "$previous_version"
  if [[ "$VERIFY_PUBLIC" == true ]]; then
    verify_public_runtime "$name" "$previous_sha" "$branch" "$previous_version"
  fi
  run_gateway_healthchecks "$name"
}

rollback_shared_runtime() {
  local previous_sha="$1"
  local previous_version="$2"
  local target_sha="$3"
  local shared_dir

  if [[ -z "$previous_sha" || "$previous_sha" == "$target_sha" ]]; then
    echo "[sync] unable to roll back shared runtime-v2: missing previous sha" >&2
    return 1
  fi

  ensure_shared_runtime_worktree
  verify_shared_runtime_plist

  shared_dir="$(runtime_shared_dir)"
  echo "[sync] rolling back shared runtime-v2 -> $previous_version ($previous_sha)"
  git -C "$shared_dir" checkout --detach "$previous_sha"
  restart_shared_runtime_service
  wait_for_shared_runtime_api "$previous_sha" "$(runtime_shared_branch)" "$previous_version"

  restart_and_verify_gateway dev
  restart_and_verify_gateway main
  run_gateway_healthchecks dev
  run_gateway_healthchecks main
}

promote_shared_runtime() {
  local target_sha="$1"
  local target_version="$2"
  local shared_dir previous_sha previous_version
  local before_shared_json target_contract_json main_gateway_contract_json dev_gateway_contract_json after_shared_json

  ensure_shared_runtime_worktree
  ensure_runtime_worktree main
  verify_shared_runtime_plist

  if ! shared_worktree_is_clean; then
    echo "[sync] shared runtime worktree is dirty: $(runtime_shared_dir)" >&2
    return 1
  fi

  if ! worktree_is_clean main; then
    echo "[sync] main runtime worktree is dirty: $(runtime_dir main)" >&2
    return 1
  fi

  shared_dir="$(runtime_shared_dir)"
  previous_sha="$(current_shared_worktree_sha)"
  previous_version="$(package_version_for_ref "$shared_dir" HEAD)"
  before_shared_json="$(shared_runtime_meta_json 2>/dev/null || true)"
  target_contract_json="$(source_runtime_contract_json_for_ref "$(runtime_dir dev)" "$target_sha")"
  main_gateway_contract_json="$(source_runtime_contract_json "$(runtime_dir main)")"
  dev_gateway_contract_json="$target_contract_json"

  if ! verify_shared_runtime_target_compatible "$target_contract_json" "$main_gateway_contract_json" "$dev_gateway_contract_json"; then
    shared_runtime_promote_report "blocked" "$before_shared_json" "$target_contract_json" "" "$main_gateway_contract_json" "$dev_gateway_contract_json"
    return 1
  fi

  if [[ "$previous_sha" == "$target_sha" ]] && shared_runtime_matches_expected "$target_sha" "$(runtime_shared_branch)" "$target_version"; then
    echo "[sync] shared runtime-v2 already aligned at $target_version ($target_sha)"
    shared_runtime_promote_report "noop" "$before_shared_json" "$target_contract_json" "$before_shared_json" "$main_gateway_contract_json" "$dev_gateway_contract_json"
    return 0
  fi

  echo "[sync] promoting shared runtime-v2 -> origin/$(runtime_shared_branch) ($target_version / $target_sha)"
  git -C "$shared_dir" checkout --detach "$target_sha"

  if ! ensure_shared_runtime_matches_expected "$target_sha" "$(runtime_shared_branch)" "$target_version"; then
    echo "[sync] shared runtime verification failed after promote" >&2
    rollback_shared_runtime "$previous_sha" "$previous_version" "$target_sha" || true
    after_shared_json="$(shared_runtime_meta_json 2>/dev/null || true)"
    shared_runtime_promote_report "rolled-back" "$before_shared_json" "$target_contract_json" "$after_shared_json" "$main_gateway_contract_json" "$dev_gateway_contract_json"
    return 1
  fi

  after_shared_json="$(shared_runtime_meta_json)"
  if ! runtime_contract_matches "$after_shared_json" "$target_contract_json"; then
    echo "[sync] shared runtime contract verification failed after promote: $(runtime_contract_diff_summary "$after_shared_json" "$target_contract_json")" >&2
    rollback_shared_runtime "$previous_sha" "$previous_version" "$target_sha" || true
    after_shared_json="$(shared_runtime_meta_json 2>/dev/null || true)"
    shared_runtime_promote_report "rolled-back" "$before_shared_json" "$target_contract_json" "$after_shared_json" "$main_gateway_contract_json" "$dev_gateway_contract_json"
    return 1
  fi

  if ! restart_and_verify_gateway dev || ! restart_and_verify_gateway main; then
    echo "[sync] gateway restart failed after shared runtime promote" >&2
    rollback_shared_runtime "$previous_sha" "$previous_version" "$target_sha" || true
    after_shared_json="$(shared_runtime_meta_json 2>/dev/null || true)"
    shared_runtime_promote_report "rolled-back" "$before_shared_json" "$target_contract_json" "$after_shared_json" "$main_gateway_contract_json" "$dev_gateway_contract_json"
    return 1
  fi

  if ! run_gateway_healthchecks dev || ! run_gateway_healthchecks main; then
    echo "[sync] attach healthcheck failed after shared runtime promote" >&2
    rollback_shared_runtime "$previous_sha" "$previous_version" "$target_sha" || true
    after_shared_json="$(shared_runtime_meta_json 2>/dev/null || true)"
    shared_runtime_promote_report "rolled-back" "$before_shared_json" "$target_contract_json" "$after_shared_json" "$main_gateway_contract_json" "$dev_gateway_contract_json"
    return 1
  fi

  after_shared_json="$(shared_runtime_meta_json)"
  shared_runtime_promote_report "applied" "$before_shared_json" "$target_contract_json" "$after_shared_json" "$main_gateway_contract_json" "$dev_gateway_contract_json"
  echo "[sync] shared runtime-v2 aligned at $target_version ($target_sha)"
}

cleanup() {
  release_sync_lock
}
trap cleanup EXIT

acquire_sync_lock || exit 0
git -C "$PROJECT_DIR" fetch origin --prune
ensure_runtime_worktree dev
ensure_shared_runtime_worktree
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
  local branch dir current_sha target_sha target_version previous_sha previous_version
  local local_json local_sha local_branch local_dirty
  local needs_checkout=false
  local needs_restart=false
  local needs_install=false
  local needs_shared_runtime_restart=false

  verify_runtime_plist "$name"
  ensure_runtime_worktree "$name"

  branch="$(runtime_branch "$name")"
  dir="$(runtime_dir "$name")"
  current_sha="$(current_worktree_sha_for "$name")"
  target_sha="$(origin_sha_for "$name")"
  target_version="$(origin_version_for "$name")"
  previous_sha="$current_sha"
  previous_version="$(package_version_for_ref "$dir" HEAD)"

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

  if [[ "$name" == "dev" && "$PROMOTE_SHARED_RUNTIME" == true ]]; then
    if ! shared_runtime_matches_expected "$target_sha" "$(runtime_shared_branch)" "$target_version"; then
      needs_shared_runtime_restart=true
    fi
  fi

  if [[ "$needs_checkout" == false && "$needs_restart" == false && "$needs_shared_runtime_restart" == false ]]; then
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
    if [[ "$name" == "dev" ]]; then
      echo "  shared-v2:    $needs_shared_runtime_restart"
    fi
    echo "  restart:      $needs_restart"
    return 0
  fi

  if [[ "$needs_checkout" == true || "$needs_restart" == true ]]; then
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
      rollback_runtime_instance "$name" "$previous_sha" "$previous_version" "$target_sha" || true
      return 1
    fi

    if [[ "$VERIFY_PUBLIC" == true ]]; then
      echo "[sync] waiting for public $name runtime"
      if ! verify_public_runtime "$name" "$target_sha" "$branch" "$target_version"; then
        echo "[sync] public runtime verification failed for $name" >&2
        rollback_runtime_instance "$name" "$previous_sha" "$previous_version" "$target_sha" || true
        return 1
      fi
    fi

    if ! run_gateway_healthchecks "$name"; then
      echo "[sync] attach healthcheck failed for $name" >&2
      rollback_runtime_instance "$name" "$previous_sha" "$previous_version" "$target_sha" || true
      return 1
    fi
  else
    echo "[sync] $name gateway already aligned at $target_version ($target_sha)"
  fi

  if [[ "$name" == "dev" && "$needs_shared_runtime_restart" == true ]]; then
    if ! promote_shared_runtime "$target_sha" "$target_version"; then
      echo "[sync] shared runtime promotion failed for $name" >&2
      return 1
    fi
  fi

  echo "[sync] $name aligned at $target_version ($target_sha)"
}

for instance in "${INSTANCES[@]}"; do
  sync_instance "$instance"
done
