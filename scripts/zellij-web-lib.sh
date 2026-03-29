#!/bin/bash

set -euo pipefail

zellij_web_service() {
  echo "com.remux.zellij-web"
}

zellij_web_gui_domain() {
  echo "gui/$(id -u)"
}

zellij_web_bin() {
  if [[ -n "${REMUX_ZELLIJ_BIN:-}" ]]; then
    echo "$REMUX_ZELLIJ_BIN"
    return 0
  fi

  command -v zellij
}

zellij_web_config() {
  echo "${REMUX_ZELLIJ_CONFIG:-$HOME/.config/zellij/config.kdl}"
}

zellij_web_port() {
  echo "${REMUX_ZELLIJ_PORT:-8082}"
}

zellij_web_session_name() {
  echo "${REMUX_ZELLIJ_SESSION_NAME:-remux-z}"
}

zellij_web_public_url() {
  echo "${REMUX_ZELLIJ_PUBLIC_URL:-https://zellij.yaoshen.wang}"
}

zellij_web_local_url() {
  echo "https://127.0.0.1:$(zellij_web_port)/$(zellij_web_session_name)"
}

zellij_web_remote_url() {
  echo "$(zellij_web_public_url)/$(zellij_web_session_name)"
}

zellij_web_log_path() {
  echo "${REMUX_ZELLIJ_LOG_PATH:-/tmp/remux-zellij-web.log}"
}

zellij_web_plist_path() {
  echo "${REMUX_ZELLIJ_PLIST_PATH:-$HOME/Library/LaunchAgents/$(zellij_web_service).plist}"
}

zellij_web_path() {
  local bin_dir
  bin_dir="$(dirname "$(zellij_web_bin)")"
  echo "${bin_dir}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
}

zellij_web_port_is_listening() {
  local port
  port="$(zellij_web_port)"

  if lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then
    return 0
  fi

  if bash -lc "exec 3<>/dev/tcp/127.0.0.1/${port}" >/dev/null 2>&1; then
    return 0
  fi

  return 1
}

ensure_zellij_web_binary() {
  local bin
  bin="$(zellij_web_bin)"
  if [[ -z "$bin" || ! -x "$bin" ]]; then
    echo "zellij binary not found" >&2
    exit 1
  fi
}

ensure_zellij_web_config() {
  local config
  config="$(zellij_web_config)"
  if [[ ! -f "$config" ]]; then
    echo "zellij config not found: $config" >&2
    exit 1
  fi
}
