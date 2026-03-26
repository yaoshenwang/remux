#!/bin/bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
RUNTIME_STATE_ROOT="${REMUX_RUNTIME_STATE_ROOT:-$HOME/.remux}"
RUNTIME_WORKTREE_ROOT="${REMUX_RUNTIME_WORKTREE_ROOT:-$RUNTIME_STATE_ROOT/runtime-worktrees}"
# Keep the sync lock outside ephemeral checkouts so launchd sync and Actions deploys share it.
SYNC_LOCK_DIR="${REMUX_RUNTIME_SYNC_LOCK_DIR:-$RUNTIME_STATE_ROOT/runtime-sync.lock}"
LAUNCHD_GUI_DOMAIN="gui/$(id -u)"

ensure_instance_name() {
  case "$1" in
    main|dev) ;;
    *)
      echo "unknown instance: $1" >&2
      exit 1
      ;;
  esac
}

runtime_branch() {
  ensure_instance_name "$1"
  echo "$1"
}

runtime_dir() {
  ensure_instance_name "$1"
  case "$1" in
    main) echo "$RUNTIME_WORKTREE_ROOT/runtime-main" ;;
    dev) echo "$RUNTIME_WORKTREE_ROOT/runtime-dev" ;;
  esac
}

runtime_service() {
  ensure_instance_name "$1"
  echo "com.remux.$1"
}

runtime_port() {
  ensure_instance_name "$1"
  case "$1" in
    main) echo "3456" ;;
    dev) echo "3457" ;;
  esac
}

runtime_token() {
  ensure_instance_name "$1"
  case "$1" in
    main) echo "remux-main-token" ;;
    dev) echo "remux-dev-token" ;;
  esac
}

runtime_public_url() {
  ensure_instance_name "$1"
  case "$1" in
    main) echo "https://remux.yaoshen.wang" ;;
    dev) echo "https://remux-dev.yaoshen.wang" ;;
  esac
}

runtime_debug_log() {
  ensure_instance_name "$1"
  echo "/tmp/remux-$1-debug.log"
}

runtime_stdout_log() {
  ensure_instance_name "$1"
  echo "/tmp/remux-$1-stdout.log"
}

runtime_stderr_log() {
  ensure_instance_name "$1"
  echo "/tmp/remux-$1-stderr.log"
}

runtime_plist_path() {
  ensure_instance_name "$1"
  echo "$HOME/Library/LaunchAgents/$(runtime_service "$1").plist"
}

runtime_sync_plist_path() {
  echo "$HOME/Library/LaunchAgents/com.remux.runtime-sync.plist"
}

runtime_sync_service() {
  echo "com.remux.runtime-sync"
}

runtime_service_domain() {
  echo "$LAUNCHD_GUI_DOMAIN/$1"
}

runtime_local_config_url() {
  ensure_instance_name "$1"
  echo "http://127.0.0.1:$(runtime_port "$1")/api/config"
}

runtime_public_config_url() {
  ensure_instance_name "$1"
  echo "$(runtime_public_url "$1")/api/config"
}

json_field_or_empty() {
  local json="$1"
  local field="$2"

  node - "$json" "$field" <<'NODE'
const [json, field] = process.argv.slice(2);
try {
  const value = JSON.parse(json)[field];
  if (value === undefined || value === null) {
    process.exit(1);
  }
  process.stdout.write(typeof value === "string" ? value : String(value));
} catch {
  process.exit(1);
}
NODE
}

fetch_json() {
  local url="$1"
  curl -fsS --max-time 5 "$url"
}

origin_sha_for() {
  ensure_instance_name "$1"
  git -C "$PROJECT_DIR" rev-parse "origin/$(runtime_branch "$1")"
}

origin_version_for() {
  ensure_instance_name "$1"
  git -C "$PROJECT_DIR" show "origin/$(runtime_branch "$1"):package.json" \
    | node -e 'let raw="";process.stdin.on("data",d=>raw+=d);process.stdin.on("end",()=>process.stdout.write(JSON.parse(raw).version));'
}

current_worktree_sha_for() {
  ensure_instance_name "$1"
  git -C "$(runtime_dir "$1")" rev-parse HEAD
}

install_runtime_dependencies() {
  local dir="$1"
  # Deploy runners may export NODE_ENV=production or omit devDependencies by
  # default, but the runtime quality gate requires TypeScript/Vitest typings.
  (cd "$dir" && npm ci --include=dev)
}

worktree_is_clean() {
  ensure_instance_name "$1"
  local dir
  dir="$(runtime_dir "$1")"
  [[ -z "$(git -C "$dir" status --porcelain --untracked-files=no)" ]]
}

ensure_runtime_worktree() {
  ensure_instance_name "$1"
  local branch dir
  branch="$(runtime_branch "$1")"
  dir="$(runtime_dir "$1")"

  mkdir -p "$RUNTIME_WORKTREE_ROOT"
  if git -C "$dir" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    return 0
  fi

  git -C "$PROJECT_DIR" worktree add --detach "$dir" "origin/$branch"
}

verify_runtime_plist() {
  ensure_instance_name "$1"
  local name="$1"
  local plist
  plist="$(runtime_plist_path "$name")"

  if [[ ! -f "$plist" ]]; then
    echo "[runtime] missing launchd plist for $name: $plist" >&2
    echo "[runtime] run: npm run runtime:install-launchd" >&2
    return 1
  fi

  if ! grep -q "$(runtime_dir "$name")" "$plist"; then
    echo "[runtime] $plist does not point to $(runtime_dir "$name")" >&2
    echo "[runtime] rerun: npm run runtime:install-launchd" >&2
    return 1
  fi

  if ! grep -q "REMUX_RUNTIME_BRANCH" "$plist"; then
    echo "[runtime] $plist does not export REMUX_RUNTIME_BRANCH" >&2
    echo "[runtime] rerun: npm run runtime:install-launchd" >&2
    return 1
  fi

  return 0
}

loaded_service_working_dir() {
  local service="$1"
  launchctl print "$(runtime_service_domain "$service")" 2>/dev/null | awk -F' = ' '/working directory = / { print $2; exit }'
}

restart_runtime_service() {
  ensure_instance_name "$1"
  local name="$1"
  local service
  local plist
  local expected_working_dir
  local loaded_working_dir
  service="$(runtime_service "$name")"
  plist="$(runtime_plist_path "$name")"
  expected_working_dir="$(runtime_dir "$name")"

  if [[ ! -f "$plist" ]]; then
    echo "[runtime] launchd plist not installed for $name: $plist" >&2
    return 1
  fi

  loaded_working_dir="$(loaded_service_working_dir "$service")"
  if [[ "$loaded_working_dir" == "$expected_working_dir" ]]; then
    launchctl kickstart -k "$(runtime_service_domain "$service")"
    return 0
  fi

  load_launchd_service "$service" "$plist"
  launchctl kickstart -k "$(runtime_service_domain "$service")"
}

load_launchd_service() {
  local service="$1"
  local plist="$2"

  if [[ ! -f "$plist" ]]; then
    echo "[runtime] missing launchd plist: $plist" >&2
    return 1
  fi

  launchctl bootout "$(runtime_service_domain "$service")" 2>/dev/null || true
  launchctl bootstrap "$LAUNCHD_GUI_DOMAIN" "$plist"
}

load_runtime_launchd() {
  ensure_instance_name "$1"
  load_launchd_service "$(runtime_service "$1")" "$(runtime_plist_path "$1")"
}

load_sync_launchd() {
  load_launchd_service "$(runtime_sync_service)" "$(runtime_sync_plist_path)"
}

wait_for_runtime_api() {
  ensure_instance_name "$1"
  local name="$1"
  local expected_sha="$2"
  local expected_branch="$3"
  local expected_version="$4"
  local url json actual_sha actual_branch actual_dirty actual_version
  local deadline=$((SECONDS + 60))
  url="$(runtime_local_config_url "$name")"

  while (( SECONDS < deadline )); do
    if json="$(fetch_json "$url" 2>/dev/null)"; then
      actual_sha="$(json_field_or_empty "$json" gitCommitSha 2>/dev/null || true)"
      actual_branch="$(json_field_or_empty "$json" gitBranch 2>/dev/null || true)"
      actual_dirty="$(json_field_or_empty "$json" gitDirty 2>/dev/null || true)"
      actual_version="$(json_field_or_empty "$json" version 2>/dev/null || true)"
      if [[ "$actual_sha" == "$expected_sha" && "$actual_branch" == "$expected_branch" && "$actual_dirty" == "false" ]]; then
        return 0
      fi
      if [[ -z "$actual_sha" && -z "$actual_branch" && -z "$actual_dirty" && "$actual_version" == "$expected_version" ]]; then
        return 0
      fi
    fi
    sleep 2
  done

  return 1
}

verify_public_runtime() {
  ensure_instance_name "$1"
  local name="$1"
  local expected_sha="$2"
  local expected_branch="$3"
  local expected_version="$4"
  local json actual_sha actual_branch actual_dirty actual_version

  json="$(fetch_json "$(runtime_public_config_url "$name")")"
  actual_sha="$(json_field_or_empty "$json" gitCommitSha 2>/dev/null || true)"
  actual_branch="$(json_field_or_empty "$json" gitBranch 2>/dev/null || true)"
  actual_dirty="$(json_field_or_empty "$json" gitDirty 2>/dev/null || true)"
  actual_version="$(json_field_or_empty "$json" version 2>/dev/null || true)"

  if [[ "$actual_sha" != "$expected_sha" || "$actual_branch" != "$expected_branch" || "$actual_dirty" != "false" ]]; then
    if [[ -z "$actual_sha" && -z "$actual_branch" && -z "$actual_dirty" && "$actual_version" == "$expected_version" ]]; then
      return 0
    fi
    echo "[runtime] public $name mismatch: expected branch=$expected_branch sha=$expected_sha dirty=false" >&2
    echo "[runtime] public $name actual: version=${actual_version:-?} branch=${actual_branch:-?} sha=${actual_sha:-?} dirty=${actual_dirty:-?}" >&2
    return 1
  fi
}

acquire_sync_lock() {
  mkdir -p "$(dirname "$SYNC_LOCK_DIR")"
  if mkdir "$SYNC_LOCK_DIR" 2>/dev/null; then
    printf '%s\n' "$$" > "$SYNC_LOCK_DIR/pid"
    return 0
  fi

  local existing_pid=""
  if [[ -f "$SYNC_LOCK_DIR/pid" ]]; then
    existing_pid="$(cat "$SYNC_LOCK_DIR/pid" 2>/dev/null || true)"
  fi

  if [[ -n "$existing_pid" ]] && ! kill -0 "$existing_pid" 2>/dev/null; then
    rm -rf "$SYNC_LOCK_DIR"
    mkdir "$SYNC_LOCK_DIR"
    printf '%s\n' "$$" > "$SYNC_LOCK_DIR/pid"
    return 0
  fi

  echo "[runtime] another sync is already running" >&2
  return 1
}

release_sync_lock() {
  rm -rf "$SYNC_LOCK_DIR"
}
