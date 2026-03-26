#!/bin/bash

set -euo pipefail

RUNNER_ROOT="${REMUX_RUNNER_ROOT:-$HOME/actions-runner/remux-deploy}"
RUNNER_WORK="${REMUX_RUNNER_WORK:-_work}"
RUNNER_LABELS="${REMUX_RUNNER_LABELS:-remux-deploy}"
RUNNER_NAME="${REMUX_RUNNER_NAME:-$(hostname -s)-remux-deploy}"
REPO="${REMUX_RUNNER_REPO:-${GITHUB_REPOSITORY:-}}"

if [[ -z "$REPO" ]]; then
  REPO="$(gh repo view --json nameWithOwner --jq '.nameWithOwner')"
fi

if ! command -v gh >/dev/null 2>&1; then
  echo "gh is required" >&2
  exit 1
fi

if ! command -v curl >/dev/null 2>&1; then
  echo "curl is required" >&2
  exit 1
fi

if ! command -v tar >/dev/null 2>&1; then
  echo "tar is required" >&2
  exit 1
fi

detect_runner_os() {
  case "$(uname -s)" in
    Darwin) echo "osx" ;;
    Linux) echo "linux" ;;
    *)
      echo "unsupported OS: $(uname -s)" >&2
      exit 1
      ;;
  esac
}

detect_runner_arch() {
  case "$(uname -m)" in
    arm64|aarch64) echo "arm64" ;;
    x86_64|amd64) echo "x64" ;;
    *)
      echo "unsupported architecture: $(uname -m)" >&2
      exit 1
      ;;
  esac
}

RUNNER_OS="$(detect_runner_os)"
RUNNER_ARCH="$(detect_runner_arch)"

find_download_field() {
  local field="$1"
  gh api "repos/$REPO/actions/runners/downloads" --jq ".[] | select(.os == \"$RUNNER_OS\" and .architecture == \"$RUNNER_ARCH\") | .$field" | head -n 1
}

ensure_runner_bits() {
  mkdir -p "$RUNNER_ROOT"

  if [[ -x "$RUNNER_ROOT/config.sh" && -x "$RUNNER_ROOT/svc.sh" ]]; then
    return 0
  fi

  local filename download_url tarball
  filename="$(find_download_field filename)"
  download_url="$(find_download_field download_url)"
  tarball="$RUNNER_ROOT/$filename"

  if [[ -z "$filename" || -z "$download_url" ]]; then
    echo "unable to find runner download for $RUNNER_OS/$RUNNER_ARCH" >&2
    exit 1
  fi

  curl -fsSL "$download_url" -o "$tarball"
  tar -xzf "$tarball" -C "$RUNNER_ROOT"
  rm -f "$tarball"
}

ensure_runner_bits

cd "$RUNNER_ROOT"

REG_TOKEN="$(gh api -X POST "repos/$REPO/actions/runners/registration-token" --jq '.token')"

./config.sh \
  --url "https://github.com/$REPO" \
  --token "$REG_TOKEN" \
  --name "$RUNNER_NAME" \
  --labels "$RUNNER_LABELS" \
  --work "$RUNNER_WORK" \
  --unattended \
  --replace

./svc.sh install
./svc.sh start
./svc.sh status || true

echo "runner installed"
echo "  repo:   $REPO"
echo "  name:   $RUNNER_NAME"
echo "  labels: $RUNNER_LABELS"
echo "  root:   $RUNNER_ROOT"
