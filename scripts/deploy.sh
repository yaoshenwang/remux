#!/bin/bash
# Deploy remux instance: build and restart via launchd.
# Usage:
#   scripts/deploy.sh dev      # rebuild + restart dev (port 3457)
#   scripts/deploy.sh main     # rebuild + restart main (port 3456)
#   scripts/deploy.sh all      # both

set -euo pipefail

REMUX_DIR="/Users/wangyaoshen/dev/remux"
MAIN_DIR="$REMUX_DIR/.worktrees/main"
DEV_DIR="$REMUX_DIR"

deploy_instance() {
  local name="$1"
  local dir="$2"
  local service="com.remux.${name}"

  echo "[deploy] building $name in $dir ..."
  (cd "$dir" && npm run build 2>&1 | tail -3)

  echo "[deploy] restarting $name ..."
  # Kill the process; launchd auto-restarts with new build
  local pid
  pid=$(launchctl list "$service" 2>/dev/null | awk -F'"PID" = ' '/PID/{gsub(/[^0-9]/,"",$2); print $2}' || true)
  if [[ -n "$pid" && "$pid" != "0" ]]; then
    kill "$pid" 2>/dev/null || true
  else
    # Service might not be loaded yet
    launchctl load "$HOME/Library/LaunchAgents/${service}.plist" 2>/dev/null || true
  fi

  sleep 3
  local new_pid
  new_pid=$(launchctl list "$service" 2>/dev/null | awk -F'"PID" = ' '/PID/{gsub(/[^0-9]/,"",$2); print $2}' || echo "?")
  echo "[deploy] $name running (pid=$new_pid)"
}

case "${1:-}" in
  dev)
    deploy_instance "dev" "$DEV_DIR"
    ;;
  main)
    deploy_instance "main" "$MAIN_DIR"
    ;;
  all)
    deploy_instance "dev" "$DEV_DIR"
    deploy_instance "main" "$MAIN_DIR"
    ;;
  *)
    echo "Usage: scripts/deploy.sh {dev|main|all}"
    exit 1
    ;;
esac

echo "[deploy] done"
