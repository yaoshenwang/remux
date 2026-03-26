#!/bin/bash

set -euo pipefail

RUNNER_ROOT="${REMUX_RUNNER_ROOT:-$HOME/actions-runner/remux-deploy}"
REPO="${REMUX_RUNNER_REPO:-${GITHUB_REPOSITORY:-}}"

if [[ -z "$REPO" ]]; then
  REPO="$(gh repo view --json nameWithOwner --jq '.nameWithOwner')"
fi

echo "runner-root: $RUNNER_ROOT"
if [[ -x "$RUNNER_ROOT/svc.sh" ]]; then
  (cd "$RUNNER_ROOT" && ./svc.sh status) || true
else
  echo "svc.sh not found"
fi

echo
echo "repo-runners:"
gh api "repos/$REPO/actions/runners" --jq '.runners[]? | [.id,.name,.os,.status,.busy,(.labels | map(.name) | join(","))] | @tsv' || true
