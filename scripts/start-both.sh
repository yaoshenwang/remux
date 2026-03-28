#!/bin/bash
# Start remux main branch (port 3456) and dev branch (port 3457)
# Tokens are fixed so URLs survive restarts.
#
# For auto-rebuild on dev changes, use instead:
#   REMUX_TOKEN=remux-dev-token REMUX_PORT=3457 scripts/watch-restart.sh

REMUX_DIR="/Users/wangyaoshen/dev/remux"
MAIN_DIR="$REMUX_DIR/.worktrees/main"
DEV_DIR="$REMUX_DIR"

TOKEN_MAIN="remux-main-token"
TOKEN_DEV="remux-dev-token"
SHARED_RUNTIME_PORT="${REMUX_RUNTIME_V2_SHARED_PORT:-3737}"
SHARED_RUNTIME_URL="http://127.0.0.1:${SHARED_RUNTIME_PORT}"

# Kill existing instances
lsof -ti :3456 | xargs kill 2>/dev/null
lsof -ti :3457 | xargs kill 2>/dev/null
lsof -ti :"$SHARED_RUNTIME_PORT" | xargs kill 2>/dev/null
sleep 1

# Start shared runtime-v2 daemon
cd "$DEV_DIR"
cargo run --manifest-path Cargo.toml -p remuxd -- \
  --host 127.0.0.1 --port "$SHARED_RUNTIME_PORT" --log-format json \
  > /tmp/remux-runtime-v2-shared-stdout.log 2>&1 &

for _ in $(seq 1 30); do
  if curl -fsS "${SHARED_RUNTIME_URL}/healthz" >/dev/null 2>&1; then
    break
  fi
  sleep 1
done

# Start main branch
cd "$MAIN_DIR"
# main branch may not have --host flag yet, patch dist as fallback
sed -i '' 's/host: "127.0.0.1"/host: "0.0.0.0"/' dist/backend/cli.js 2>/dev/null
REMUXD_BASE_URL="$SHARED_RUNTIME_URL" REMUX_RUNTIME_V2_REQUIRED=1 REMUX_TOKEN="$TOKEN_MAIN" node dist/backend/cli.js \
  --no-require-password --port 3456 --no-tunnel \
  --debug-log /tmp/remux-main-debug.log > /tmp/remux-main-stdout.log 2>&1 &

# Start dev branch (has --host flag)
cd "$DEV_DIR"
REMUXD_BASE_URL="$SHARED_RUNTIME_URL" REMUX_RUNTIME_V2_REQUIRED=1 REMUX_TOKEN="$TOKEN_DEV" node dist/backend/cli.js \
  --host 0.0.0.0 --no-require-password --port 3457 --no-tunnel \
  --debug-log /tmp/remux-dev-debug.log > /tmp/remux-dev-stdout.log 2>&1 &

sleep 2
echo "=== Remux instances started ==="

# Extract main token from stdout (random each restart)
MAIN_TOKEN=$(grep -o 'token=[^ ]*' /tmp/remux-main-stdout.log | head -1 | cut -d= -f2)
echo "main: http://192.168.31.169:3456/?token=${MAIN_TOKEN:-<check /tmp/remux-main-stdout.log>}"
echo "dev:  http://192.168.31.169:3457/?token=$TOKEN_DEV"
echo ""
echo "dev URL is stable across restarts."
echo "For auto-rebuild on dev changes:"
echo "  REMUX_TOKEN=$TOKEN_DEV REMUX_PORT=3457 scripts/watch-restart.sh"
