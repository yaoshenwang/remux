#!/bin/bash
# Deploy remux instance: build and restart via launchd.
# Usage:
#   scripts/deploy.sh dev      # rebuild + restart dev (port 3457)
#   scripts/deploy.sh main     # rebuild + restart main (port 3456)
#   scripts/deploy.sh all      # both

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=./runtime-lib.sh
source "$SCRIPT_DIR/runtime-lib.sh"

deploy_instance() {
  local name="$1"
  local dir service port gui_domain
  ensure_instance_name "$name"
  verify_runtime_plist "$name"
  ensure_runtime_worktree "$name"

  dir="$(runtime_dir "$name")"
  service="$(runtime_service "$name")"
  port="$(runtime_port "$name")"
  gui_domain="gui/$(id -u)"

  echo "[deploy] building $name in $dir ..."
  (cd "$dir" && npm run build 2>&1 | tail -3)

  echo "[deploy] clearing listeners on :$port ..."
  lsof -ti tcp:"$port" | xargs kill 2>/dev/null || true
  sleep 2
  lsof -ti tcp:"$port" | xargs kill -9 2>/dev/null || true

  echo "[deploy] restarting $name via launchctl ..."
  local pid
  pid=$(launchctl list "$service" 2>/dev/null | awk -F'"PID" = ' '/PID/{gsub(/[^0-9]/,"",$2); print $2}' || true)
  if [[ -n "$pid" && "$pid" != "0" ]]; then
    # SIGTERM first, then SIGKILL if still alive after 2s
    kill "$pid" 2>/dev/null || true
    sleep 2
    kill -0 "$pid" 2>/dev/null && kill -9 "$pid" 2>/dev/null
  fi

  launchctl bootstrap "$gui_domain" "$HOME/Library/LaunchAgents/${service}.plist" 2>/dev/null || true
  launchctl kickstart -k "${gui_domain}/${service}"

  sleep 3
  local new_pid
  new_pid=$(launchctl list "$service" 2>/dev/null | awk -F'"PID" = ' '/PID/{gsub(/[^0-9]/,"",$2); print $2}' || echo "?")
  echo "[deploy] $name running (pid=$new_pid)"
}

case "${1:-}" in
  dev)
    deploy_instance "dev"
    ;;
  main)
    deploy_instance "main"
    ;;
  all)
    deploy_instance "dev"
    deploy_instance "main"
    ;;
  *)
    echo "Usage: scripts/deploy.sh {dev|main|all}"
    exit 1
    ;;
esac

echo "[deploy] done"
