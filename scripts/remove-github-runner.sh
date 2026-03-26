#!/bin/bash

set -euo pipefail

RUNNER_ROOT="${REMUX_RUNNER_ROOT:-$HOME/actions-runner/remux-deploy}"
REPO="${REMUX_RUNNER_REPO:-${GITHUB_REPOSITORY:-}}"

if [[ -z "$REPO" ]]; then
  REPO="$(gh repo view --json nameWithOwner --jq '.nameWithOwner')"
fi

if [[ ! -d "$RUNNER_ROOT" || ! -x "$RUNNER_ROOT/config.sh" ]]; then
  echo "runner directory not found: $RUNNER_ROOT" >&2
  exit 1
fi

cd "$RUNNER_ROOT"

REMOVE_TOKEN="$(gh api -X POST "repos/$REPO/actions/runners/remove-token" --jq '.token')"

./svc.sh stop || true
./svc.sh uninstall || true
./config.sh remove --token "$REMOVE_TOKEN" || true

echo "runner removed"
echo "  repo: $REPO"
echo "  root: $RUNNER_ROOT"
