#!/bin/bash
# Auto-deploy script for Remux runtime instances.
# Usage: auto-deploy.sh <branch> <worktree-path> <launchd-label>
#
# Checks if origin/<branch> has new commits, pulls, installs deps, and restarts.
# Designed to be called by launchd on a schedule (e.g. every 2 minutes).

set -euo pipefail

BRANCH="${1:?Usage: auto-deploy.sh <branch> <worktree-path> <launchd-label>}"
WORKTREE="${2:?}"
LABEL="${3:?}"
LOG_PREFIX="[deploy:${BRANCH}]"

cd "$WORKTREE" || { echo "$LOG_PREFIX worktree not found: $WORKTREE"; exit 1; }

# Fetch latest from origin
git fetch origin "$BRANCH" --quiet 2>/dev/null || { echo "$LOG_PREFIX fetch failed"; exit 1; }

LOCAL=$(git rev-parse HEAD 2>/dev/null)
REMOTE=$(git rev-parse "origin/${BRANCH}" 2>/dev/null)

if [ "$LOCAL" = "$REMOTE" ]; then
  # Already up to date
  exit 0
fi

echo "$LOG_PREFIX updating ${LOCAL:0:7} → ${REMOTE:0:7}"

# Pull changes
git checkout --detach "origin/${BRANCH}" --quiet 2>/dev/null

# Install dependencies if lockfile changed
if ! git diff --quiet "$LOCAL" "$REMOTE" -- pnpm-lock.yaml 2>/dev/null; then
  echo "$LOG_PREFIX pnpm-lock.yaml changed, installing deps"
  /opt/homebrew/bin/pnpm install --frozen-lockfile --prefer-offline 2>/dev/null || true
fi

# Fix node-pty spawn-helper permissions (needed after fresh install)
find node_modules -name "spawn-helper" -type f -exec chmod +x {} \; 2>/dev/null || true

# Restart the service
echo "$LOG_PREFIX restarting $LABEL"
/bin/launchctl kickstart -k "gui/501/${LABEL}" 2>/dev/null || true

echo "$LOG_PREFIX deployed ${REMOTE:0:7}"
