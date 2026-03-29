#!/bin/bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
RUNTIME_STATE_ROOT="${REMUX_RUNTIME_STATE_ROOT:-$HOME/.remux}"
RUNTIME_WORKTREE_ROOT="${REMUX_RUNTIME_WORKTREE_ROOT:-$RUNTIME_STATE_ROOT/runtime-worktrees}"
# Keep the sync lock outside ephemeral checkouts so launchd sync and Actions deploys share it.
SYNC_LOCK_DIR="${REMUX_RUNTIME_SYNC_LOCK_DIR:-$RUNTIME_STATE_ROOT/runtime-sync.lock}"
# Include Cargo so runtime deploys can build native workspace components without shell init files.
RUNTIME_BASE_PATH="${REMUX_RUNTIME_BASE_PATH:-${CARGO_HOME:-$HOME/.cargo}/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin}"
LAUNCHD_GUI_DOMAIN="gui/$(id -u)"

runtime_node_candidates() {
  if [[ -n "${REMUX_RUNTIME_NODE_BIN:-}" ]]; then
    printf '%s\n' "$REMUX_RUNTIME_NODE_BIN"
    return 0
  fi

  if [[ -n "${REMUX_RUNTIME_NODE_SEARCH_PATHS:-}" ]]; then
    local -a candidates
    local IFS=':'
    read -r -a candidates <<<"$REMUX_RUNTIME_NODE_SEARCH_PATHS" || true
    printf '%s\n' "${candidates[@]}"
    return 0
  fi

  printf '%s\n' \
    /opt/homebrew/opt/node@22/bin/node \
    /opt/homebrew/opt/node@20/bin/node \
    /usr/local/opt/node@22/bin/node \
    /usr/local/opt/node@20/bin/node

  command -v node 2>/dev/null || true
}

resolve_runtime_node_bin() {
  local candidate

  while IFS= read -r candidate; do
    if [[ -n "$candidate" && -x "$candidate" ]]; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done < <(runtime_node_candidates)

  echo "[runtime] unable to resolve a supported node binary" >&2
  return 1
}

runtime_node_dir() {
  dirname "$(resolve_runtime_node_bin)"
}

resolve_runtime_cargo_bin() {
  local candidate

  if [[ -n "${REMUX_RUNTIME_CARGO_BIN:-}" ]]; then
    if [[ -x "$REMUX_RUNTIME_CARGO_BIN" ]]; then
      printf '%s\n' "$REMUX_RUNTIME_CARGO_BIN"
      return 0
    fi
    echo "[runtime] REMUX_RUNTIME_CARGO_BIN is not executable: $REMUX_RUNTIME_CARGO_BIN" >&2
    return 1
  fi

  candidate="${CARGO_HOME:-$HOME/.cargo}/bin/cargo"
  if [[ -x "$candidate" ]]; then
    printf '%s\n' "$candidate"
    return 0
  fi

  candidate="$(command -v cargo 2>/dev/null || true)"
  if [[ -n "$candidate" && -x "$candidate" ]]; then
    printf '%s\n' "$candidate"
    return 0
  fi

  echo "[runtime] unable to resolve cargo for the shared runtime toolchain" >&2
  return 1
}

resolve_runtime_npm_bin() {
  local candidate

  if [[ -n "${REMUX_RUNTIME_NPM_BIN:-}" ]]; then
    if [[ -x "$REMUX_RUNTIME_NPM_BIN" ]]; then
      printf '%s\n' "$REMUX_RUNTIME_NPM_BIN"
      return 0
    fi
    echo "[runtime] REMUX_RUNTIME_NPM_BIN is not executable: $REMUX_RUNTIME_NPM_BIN" >&2
    return 1
  fi

  candidate="$(runtime_node_dir)/npm"
  if [[ -x "$candidate" ]]; then
    printf '%s\n' "$candidate"
    return 0
  fi

  candidate="$(command -v npm 2>/dev/null || true)"
  if [[ -n "$candidate" && -x "$candidate" ]]; then
    printf '%s\n' "$candidate"
    return 0
  fi

  echo "[runtime] unable to resolve npm for the runtime toolchain" >&2
  return 1
}

runtime_shell_path() {
  printf '%s:%s\n' "$(runtime_node_dir)" "$RUNTIME_BASE_PATH"
}

run_runtime_npm() {
  local dir="$1"
  shift
  local npm_bin
  npm_bin="$(resolve_runtime_npm_bin)"
  (
    cd "$dir"
    PATH="$(runtime_shell_path)" "$npm_bin" "$@"
  )
}

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

runtime_shared_branch() {
  echo "${REMUX_SHARED_RUNTIME_BRANCH:-dev}"
}

runtime_dir() {
  ensure_instance_name "$1"
  case "$1" in
    main) echo "$RUNTIME_WORKTREE_ROOT/runtime-main" ;;
    dev) echo "$RUNTIME_WORKTREE_ROOT/runtime-dev" ;;
  esac
}

runtime_shared_dir() {
  echo "$RUNTIME_WORKTREE_ROOT/runtime-shared"
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

runtime_shared_service() {
  echo "com.remux.runtime-v2-shared"
}

runtime_shared_port() {
  echo "${REMUX_RUNTIME_V2_SHARED_PORT:-3737}"
}

runtime_shared_base_url() {
  echo "http://127.0.0.1:$(runtime_shared_port)"
}

runtime_local_ws_origin() {
  ensure_instance_name "$1"
  echo "ws://127.0.0.1:$(runtime_port "$1")"
}

runtime_shared_stdout_log() {
  echo "/tmp/remux-runtime-v2-shared-stdout.log"
}

runtime_shared_stderr_log() {
  echo "/tmp/remux-runtime-v2-shared-stderr.log"
}

runtime_shared_plist_path() {
  echo "$HOME/Library/LaunchAgents/$(runtime_shared_service).plist"
}

runtime_shared_workdir() {
  echo "$(runtime_shared_dir)"
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

runtime_shared_meta_url() {
  echo "$(runtime_shared_base_url)/v2/meta"
}

shared_runtime_meta_json() {
  fetch_json "$(runtime_shared_meta_url)"
}

json_field_or_empty() {
  local json="$1"
  local field="$2"

  "$(resolve_runtime_node_bin)" - "$json" "$field" <<'NODE'
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

source_runtime_contract_json() {
  local dir="$1"

  "$(resolve_runtime_node_bin)" - "$dir" <<'NODE'
const fs = require("fs");
const path = require("path");
const childProcess = require("child_process");

const dir = process.argv[2];
const packageJsonPath = path.join(dir, "package.json");
const corePath = path.join(dir, "crates", "remux-core", "src", "lib.rs");
const serverPath = path.join(dir, "crates", "remux-server", "src", "lib.rs");

const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
const coreSource = fs.readFileSync(corePath, "utf8");
const serverSource = fs.readFileSync(serverPath, "utf8");
const protocolVersion = coreSource.match(/RUNTIME_V2_PROTOCOL_VERSION:\s*&str\s*=\s*"([^"]+)"/)?.[1];
const controlWebsocketPath = serverSource.match(/\.route\("([^"]+)",\s*get\(control_socket\)\)/)?.[1];
const terminalWebsocketPath = serverSource.match(/\.route\("([^"]+)",\s*get\(terminal_socket\)\)/)?.[1];

if (!protocolVersion || !controlWebsocketPath || !terminalWebsocketPath) {
  throw new Error(`unable to resolve runtime-v2 contract from ${dir}`);
}

let gitCommitSha;
try {
  gitCommitSha = childProcess.execFileSync("git", ["-C", dir, "rev-parse", "HEAD"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
} catch {}

process.stdout.write(JSON.stringify({
  version: packageJson.version,
  ...(gitCommitSha ? { gitCommitSha } : {}),
  protocolVersion,
  controlWebsocketPath,
  terminalWebsocketPath,
}));
NODE
}

source_runtime_contract_json_for_ref() {
  local dir="$1"
  local ref="$2"

  "$(resolve_runtime_node_bin)" - "$dir" "$ref" <<'NODE'
const childProcess = require("child_process");

const dir = process.argv[2];
const ref = process.argv[3];
const show = (filePath) =>
  childProcess.execFileSync("git", ["-C", dir, "show", `${ref}:${filePath}`], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });

const packageJson = JSON.parse(show("package.json"));
const coreSource = show("crates/remux-core/src/lib.rs");
const serverSource = show("crates/remux-server/src/lib.rs");
const protocolVersion = coreSource.match(/RUNTIME_V2_PROTOCOL_VERSION:\s*&str\s*=\s*"([^"]+)"/)?.[1];
const controlWebsocketPath = serverSource.match(/\.route\("([^"]+)",\s*get\(control_socket\)\)/)?.[1];
const terminalWebsocketPath = serverSource.match(/\.route\("([^"]+)",\s*get\(terminal_socket\)\)/)?.[1];

if (!protocolVersion || !controlWebsocketPath || !terminalWebsocketPath) {
  throw new Error(`unable to resolve runtime-v2 contract from ${dir} at ${ref}`);
}

process.stdout.write(JSON.stringify({
  version: packageJson.version,
  gitCommitSha: ref,
  protocolVersion,
  controlWebsocketPath,
  terminalWebsocketPath,
}));
NODE
}

runtime_contract_summary() {
  local json="$1"
  local version sha protocol control terminal

  version="$(json_field_or_empty "$json" version 2>/dev/null || true)"
  sha="$(json_field_or_empty "$json" gitCommitSha 2>/dev/null || true)"
  protocol="$(json_field_or_empty "$json" protocolVersion 2>/dev/null || true)"
  control="$(json_field_or_empty "$json" controlWebsocketPath 2>/dev/null || true)"
  terminal="$(json_field_or_empty "$json" terminalWebsocketPath 2>/dev/null || true)"

  printf 'version=%s sha=%s protocol=%s control=%s terminal=%s' \
    "${version:-?}" "${sha:-?}" "${protocol:-?}" "${control:-?}" "${terminal:-?}"
}

runtime_contract_matches() {
  local candidate_json="$1"
  local expected_json="$2"
  local field candidate_value expected_value

  for field in protocolVersion controlWebsocketPath terminalWebsocketPath; do
    candidate_value="$(json_field_or_empty "$candidate_json" "$field" 2>/dev/null || true)"
    expected_value="$(json_field_or_empty "$expected_json" "$field" 2>/dev/null || true)"
    if [[ "$candidate_value" != "$expected_value" ]]; then
      return 1
    fi
  done

  return 0
}

runtime_contract_diff_summary() {
  local candidate_json="$1"
  local expected_json="$2"
  local field candidate_value expected_value
  local -a diffs=()

  for field in protocolVersion controlWebsocketPath terminalWebsocketPath; do
    candidate_value="$(json_field_or_empty "$candidate_json" "$field" 2>/dev/null || true)"
    expected_value="$(json_field_or_empty "$expected_json" "$field" 2>/dev/null || true)"
    if [[ "$candidate_value" != "$expected_value" ]]; then
      diffs+=("$field expected=${expected_value:-?} actual=${candidate_value:-?}")
    fi
  done

  if [[ ${#diffs[@]} -eq 0 ]]; then
    echo "none"
    return 0
  fi

  local IFS='; '
  echo "${diffs[*]}"
}

runtime_contract_compat_label() {
  local candidate_json="$1"
  local expected_json="$2"

  if runtime_contract_matches "$candidate_json" "$expected_json"; then
    echo "ok"
  else
    echo "blocked"
  fi
}

origin_sha_for() {
  ensure_instance_name "$1"
  git -C "$PROJECT_DIR" rev-parse "origin/$(runtime_branch "$1")"
}

origin_version_for() {
  ensure_instance_name "$1"
  git -C "$PROJECT_DIR" show "origin/$(runtime_branch "$1"):package.json" \
    | "$(resolve_runtime_node_bin)" -e 'let raw="";process.stdin.on("data",d=>raw+=d);process.stdin.on("end",()=>process.stdout.write(JSON.parse(raw).version));'
}

current_worktree_sha_for() {
  ensure_instance_name "$1"
  git -C "$(runtime_dir "$1")" rev-parse HEAD
}

install_runtime_dependencies() {
  local dir="$1"
  # Deploy runners may export NODE_ENV=production or omit devDependencies by
  # default, but the runtime quality gate requires TypeScript/Vitest typings.
  run_runtime_npm "$dir" ci --include=dev
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

ensure_shared_runtime_worktree() {
  local branch dir
  branch="$(runtime_shared_branch)"
  dir="$(runtime_shared_dir)"

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
  local expected_node_bin
  local expected_path
  local expected_runtime_base_url
  plist="$(runtime_plist_path "$name")"
  expected_node_bin="$(resolve_runtime_node_bin)"
  expected_path="$(runtime_shell_path)"
  expected_runtime_base_url="$(runtime_shared_base_url)"

  if [[ ! -f "$plist" ]]; then
    echo "[runtime] missing launchd plist for $name: $plist" >&2
    echo "[runtime] run: npm run runtime:install-launchd" >&2
    return 1
  fi

  if ! grep -Fq "$(runtime_dir "$name")" "$plist"; then
    echo "[runtime] $plist does not point to $(runtime_dir "$name")" >&2
    echo "[runtime] rerun: npm run runtime:install-launchd" >&2
    return 1
  fi

  if ! grep -Fq "REMUX_RUNTIME_BRANCH" "$plist"; then
    echo "[runtime] $plist does not export REMUX_RUNTIME_BRANCH" >&2
    echo "[runtime] rerun: npm run runtime:install-launchd" >&2
    return 1
  fi

  if ! grep -Fq "$expected_node_bin" "$plist"; then
    echo "[runtime] $plist does not point to the resolved node binary: $expected_node_bin" >&2
    echo "[runtime] rerun: npm run runtime:install-launchd" >&2
    return 1
  fi

  if ! grep -Fq "$expected_path" "$plist"; then
    echo "[runtime] $plist does not prefix PATH with the resolved runtime toolchain" >&2
    echo "[runtime] rerun: npm run runtime:install-launchd" >&2
    return 1
  fi

  if ! grep -Fq "<key>REMUXD_BASE_URL</key>" "$plist" || ! grep -Fq "<string>$expected_runtime_base_url</string>" "$plist"; then
    echo "[runtime] $plist does not point to the shared runtime-v2 daemon at $expected_runtime_base_url" >&2
    echo "[runtime] rerun: npm run runtime:install-launchd" >&2
    return 1
  fi

  if ! grep -Fq "<key>REMUX_RUNTIME_V2_REQUIRED</key>" "$plist" || ! grep -Fq "<string>1</string>" "$plist"; then
    echo "[runtime] $plist does not pin public services to runtime-v2" >&2
    echo "[runtime] rerun: npm run runtime:install-launchd" >&2
    return 1
  fi

  if ! grep -Fq "<key>REMUX_LOCAL_WS_ORIGIN</key>" "$plist" || ! grep -Fq "<string>$(runtime_local_ws_origin "$name")</string>" "$plist"; then
    echo "[runtime] $plist does not advertise the local websocket fast path for $name" >&2
    echo "[runtime] rerun: npm run runtime:install-launchd" >&2
    return 1
  fi

  return 0
}

verify_shared_runtime_plist() {
  local plist
  local expected_path
  local expected_cargo_bin
  plist="$(runtime_shared_plist_path)"
  expected_path="$(runtime_shell_path)"
  expected_cargo_bin="$(resolve_runtime_cargo_bin)"

  if [[ ! -f "$plist" ]]; then
    echo "[runtime] missing shared runtime plist: $plist" >&2
    echo "[runtime] run: npm run runtime:install-launchd" >&2
    return 1
  fi

  if ! grep -Fq "$(runtime_shared_workdir)" "$plist"; then
    echo "[runtime] $plist does not point to $(runtime_shared_workdir)" >&2
    echo "[runtime] rerun: npm run runtime:install-launchd" >&2
    return 1
  fi

  if ! grep -Fq "<string>$expected_cargo_bin</string>" "$plist" || ! grep -Fq "<string>remuxd</string>" "$plist"; then
    echo "[runtime] $plist does not launch the shared remuxd daemon with the resolved cargo binary" >&2
    echo "[runtime] rerun: npm run runtime:install-launchd" >&2
    return 1
  fi

  if ! grep -Fq "<string>$(runtime_shared_port)</string>" "$plist"; then
    echo "[runtime] $plist does not expose the shared runtime on port $(runtime_shared_port)" >&2
    echo "[runtime] rerun: npm run runtime:install-launchd" >&2
    return 1
  fi

  if ! grep -Fq "<key>REMUX_RUNTIME_BRANCH</key>" "$plist" || ! grep -Fq "<string>$(runtime_shared_branch)</string>" "$plist"; then
    echo "[runtime] $plist does not pin the shared runtime branch to $(runtime_shared_branch)" >&2
    echo "[runtime] rerun: npm run runtime:install-launchd" >&2
    return 1
  fi

  if ! grep -Fq "$expected_path" "$plist"; then
    echo "[runtime] $plist does not prefix PATH with the resolved runtime toolchain" >&2
    echo "[runtime] rerun: npm run runtime:install-launchd" >&2
    return 1
  fi

  return 0
}

loaded_service_working_dir() {
  local service="$1"
  local service_output=""

  service_output="$(launchctl print "$(runtime_service_domain "$service")" 2>/dev/null || true)"
  awk -F' = ' '/working directory = / { print $2; exit }' <<<"$service_output"
}

loaded_service_description() {
  local service="$1"
  launchctl print "$(runtime_service_domain "$service")" 2>/dev/null || true
}

loaded_shared_runtime_service_matches_expected() {
  local service_description=""
  service_description="$(loaded_service_description "$(runtime_shared_service)")"

  [[ -n "$service_description" ]] || return 1
  grep -Fq "working directory = $(runtime_shared_workdir)" <<<"$service_description" || return 1
  grep -Fq "REMUX_RUNTIME_BRANCH => $(runtime_shared_branch)" <<<"$service_description" || return 1

  return 0
}

loaded_runtime_service_matches_expected() {
  ensure_instance_name "$1"
  local name="$1"
  local service_description=""
  local expected_working_dir
  expected_working_dir="$(runtime_dir "$name")"
  service_description="$(loaded_service_description "$(runtime_service "$name")")"

  [[ -n "$service_description" ]] || return 1
  grep -Fq "working directory = $expected_working_dir" <<<"$service_description" || return 1
  grep -Fq "REMUX_RUNTIME_BRANCH => $(runtime_branch "$name")" <<<"$service_description" || return 1
  grep -Fq "REMUXD_BASE_URL => $(runtime_shared_base_url)" <<<"$service_description" || return 1
  grep -Fq "REMUX_RUNTIME_V2_REQUIRED => 1" <<<"$service_description" || return 1
  grep -Fq "REMUX_LOCAL_WS_ORIGIN => $(runtime_local_ws_origin "$name")" <<<"$service_description" || return 1

  return 0
}

shared_runtime_matches_expected() {
  local expected_sha="$1"
  local expected_branch="$2"
  local expected_version="$3"
  local json actual_sha actual_branch actual_version actual_dirty

  if ! json="$(shared_runtime_meta_json 2>/dev/null)"; then
    return 1
  fi

  actual_sha="$(json_field_or_empty "$json" gitCommitSha 2>/dev/null || true)"
  actual_branch="$(json_field_or_empty "$json" gitBranch 2>/dev/null || true)"
  actual_version="$(json_field_or_empty "$json" version 2>/dev/null || true)"
  actual_dirty="$(json_field_or_empty "$json" gitDirty 2>/dev/null || true)"

  [[ "$actual_sha" == "$expected_sha" ]] || return 1
  [[ "$actual_version" == "$expected_version" ]] || return 1
  [[ "$actual_dirty" == "false" ]] || return 1

  if [[ -n "$expected_branch" ]]; then
    [[ "$actual_branch" == "$expected_branch" ]] || return 1
  fi

  return 0
}

restart_runtime_service() {
  ensure_instance_name "$1"
  local name="$1"
  local service
  local plist
  service="$(runtime_service "$name")"
  plist="$(runtime_plist_path "$name")"

  if [[ ! -f "$plist" ]]; then
    echo "[runtime] launchd plist not installed for $name: $plist" >&2
    return 1
  fi

  if loaded_runtime_service_matches_expected "$name"; then
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

  launchctl bootout "$LAUNCHD_GUI_DOMAIN" "$plist" 2>/dev/null \
    || launchctl bootout "$(runtime_service_domain "$service")" 2>/dev/null \
    || true
  launchctl bootstrap "$LAUNCHD_GUI_DOMAIN" "$plist"
}

load_runtime_launchd() {
  ensure_instance_name "$1"
  load_launchd_service "$(runtime_service "$1")" "$(runtime_plist_path "$1")"
}

restart_shared_runtime_service() {
  local service
  local plist
  service="$(runtime_shared_service)"
  plist="$(runtime_shared_plist_path)"

  if [[ ! -f "$plist" ]]; then
    echo "[runtime] shared runtime launchd plist not installed: $plist" >&2
    return 1
  fi

  if loaded_shared_runtime_service_matches_expected; then
    launchctl kickstart -k "$(runtime_service_domain "$service")"
    return 0
  fi

  load_launchd_service "$service" "$plist"
  launchctl kickstart -k "$(runtime_service_domain "$service")"
}

load_shared_runtime_launchd() {
  local loaded_working_dir
  loaded_working_dir="$(loaded_service_working_dir "$(runtime_shared_service)")"
  if loaded_shared_runtime_service_matches_expected && [[ "$loaded_working_dir" == "$(runtime_shared_workdir)" ]] && shared_runtime_meta_json >/dev/null 2>&1; then
    return 0
  fi
  load_launchd_service "$(runtime_shared_service)" "$(runtime_shared_plist_path)"
}

load_sync_launchd() {
  load_launchd_service "$(runtime_sync_service)" "$(runtime_sync_plist_path)"
}

ensure_shared_runtime_running() {
  if shared_runtime_meta_json >/dev/null 2>&1 && loaded_shared_runtime_service_matches_expected; then
    return 0
  fi

  load_shared_runtime_launchd

  local deadline=$((SECONDS + 60))
  while (( SECONDS < deadline )); do
    if shared_runtime_meta_json >/dev/null 2>&1; then
      return 0
    fi
    sleep 2
  done

  echo "[runtime] shared runtime-v2 daemon failed to become healthy at $(runtime_shared_base_url)" >&2
  return 1
}

wait_for_shared_runtime_api() {
  local expected_sha="$1"
  local expected_branch="$2"
  local expected_version="$3"
  local json
  local deadline=$((SECONDS + 60))

  while (( SECONDS < deadline )); do
    if shared_runtime_matches_expected "$expected_sha" "$expected_branch" "$expected_version"; then
      return 0
    fi
    sleep 2
  done

  if json="$(shared_runtime_meta_json 2>/dev/null)"; then
    local actual_sha actual_branch actual_dirty actual_version
    actual_sha="$(json_field_or_empty "$json" gitCommitSha 2>/dev/null || true)"
    actual_branch="$(json_field_or_empty "$json" gitBranch 2>/dev/null || true)"
    actual_dirty="$(json_field_or_empty "$json" gitDirty 2>/dev/null || true)"
    actual_version="$(json_field_or_empty "$json" version 2>/dev/null || true)"
    echo "[runtime] shared runtime mismatch: expected branch=$expected_branch sha=$expected_sha version=$expected_version dirty=false" >&2
    echo "[runtime] shared runtime actual: version=${actual_version:-?} branch=${actual_branch:-?} sha=${actual_sha:-?} dirty=${actual_dirty:-?}" >&2
  fi

  return 1
}

ensure_shared_runtime_matches_expected() {
  local expected_sha="$1"
  local expected_branch="$2"
  local expected_version="$3"

  if shared_runtime_matches_expected "$expected_sha" "$expected_branch" "$expected_version"; then
    return 0
  fi

  if shared_runtime_meta_json >/dev/null 2>&1 || loaded_shared_runtime_service_matches_expected; then
    restart_shared_runtime_service
  else
    load_shared_runtime_launchd
  fi

  wait_for_shared_runtime_api "$expected_sha" "$expected_branch" "$expected_version"
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
current_shared_worktree_sha() {
  git -C "$(runtime_shared_dir)" rev-parse HEAD
}

shared_worktree_is_clean() {
  local dir
  dir="$(runtime_shared_dir)"
  [[ -z "$(git -C "$dir" status --porcelain --untracked-files=no)" ]]
}
