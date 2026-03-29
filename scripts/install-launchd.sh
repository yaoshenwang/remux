#!/bin/bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=./runtime-lib.sh
source "$SCRIPT_DIR/runtime-lib.sh"

mkdir -p "$HOME/Library/LaunchAgents"

write_runtime_plist() {
  local name="$1"
  local plist
  local runtime_node_bin
  local runtime_path
  local shared_runtime_base_url
  plist="$(runtime_plist_path "$name")"
  runtime_node_bin="$(resolve_runtime_node_bin)"
  runtime_path="$(runtime_shell_path)"
  shared_runtime_base_url="$(runtime_shared_base_url)"

  cat > "$plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>$(runtime_service "$name")</string>
    <key>ProgramArguments</key>
    <array>
      <string>$runtime_node_bin</string>
      <string>dist/backend/cli.js</string>
      <string>--host</string>
      <string>0.0.0.0</string>
      <string>--port</string>
      <string>$(runtime_port "$name")</string>
      <string>--no-tunnel</string>
      <string>--no-require-password</string>
      <string>--debug-log</string>
      <string>$(runtime_debug_log "$name")</string>
    </array>
    <key>WorkingDirectory</key>
    <string>$(runtime_dir "$name")</string>
    <key>EnvironmentVariables</key>
    <dict>
      <key>REMUX_TOKEN</key>
      <string>$(runtime_token "$name")</string>
      <key>REMUX_RUNTIME_BRANCH</key>
      <string>$(runtime_branch "$name")</string>
      <key>REMUXD_BASE_URL</key>
      <string>$shared_runtime_base_url</string>
      <key>REMUX_RUNTIME_V2_REQUIRED</key>
      <string>1</string>
      <key>REMUX_LOCAL_WS_ORIGIN</key>
      <string>ws://127.0.0.1:$(runtime_port "$name")</string>
      <key>PATH</key>
      <string>$runtime_path</string>
      <key>TERM</key>
      <string>xterm-256color</string>
      <key>HOME</key>
      <string>$HOME</string>
      <key>LANG</key>
      <string>en_US.UTF-8</string>
    </dict>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>ThrottleInterval</key>
    <integer>3</integer>
    <key>StandardOutPath</key>
    <string>$(runtime_stdout_log "$name")</string>
    <key>StandardErrorPath</key>
    <string>$(runtime_stderr_log "$name")</string>
  </dict>
</plist>
EOF
}

write_shared_runtime_plist() {
  local plist
  local runtime_cargo_bin
  local runtime_path
  local workdir
  plist="$(runtime_shared_plist_path)"
  runtime_cargo_bin="$(resolve_runtime_cargo_bin)"
  runtime_path="$(runtime_shell_path)"
  workdir="$(runtime_shared_workdir)"

  cat > "$plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>$(runtime_shared_service)</string>
    <key>ProgramArguments</key>
    <array>
      <string>$runtime_cargo_bin</string>
      <string>run</string>
      <string>--manifest-path</string>
      <string>Cargo.toml</string>
      <string>-p</string>
      <string>remuxd</string>
      <string>--</string>
      <string>--host</string>
      <string>127.0.0.1</string>
      <string>--port</string>
      <string>$(runtime_shared_port)</string>
      <string>--log-format</string>
      <string>json</string>
    </array>
    <key>WorkingDirectory</key>
    <string>$workdir</string>
    <key>EnvironmentVariables</key>
    <dict>
      <key>PATH</key>
      <string>$runtime_path</string>
      <key>HOME</key>
      <string>$HOME</string>
      <key>REMUX_RUNTIME_BRANCH</key>
      <string>$(runtime_shared_branch)</string>
      <key>LANG</key>
      <string>en_US.UTF-8</string>
      <key>TERM</key>
      <string>xterm-256color</string>
    </dict>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>ThrottleInterval</key>
    <integer>3</integer>
    <key>StandardOutPath</key>
    <string>$(runtime_shared_stdout_log)</string>
    <key>StandardErrorPath</key>
    <string>$(runtime_shared_stderr_log)</string>
  </dict>
</plist>
EOF
}

write_sync_plist() {
  local plist
  local runtime_manager_dir
  local runtime_path
  plist="$(runtime_sync_plist_path)"
  runtime_manager_dir="$(runtime_dir dev)"
  runtime_path="$(runtime_shell_path)"

  cat > "$plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>com.remux.runtime-sync</string>
    <key>ProgramArguments</key>
    <array>
      <string>/bin/bash</string>
      <string>$runtime_manager_dir/scripts/sync-runtime.sh</string>
      <string>all</string>
      <string>--verify-public</string>
    </array>
    <key>WorkingDirectory</key>
    <string>$runtime_manager_dir</string>
    <key>RunAtLoad</key>
    <true/>
    <key>StartInterval</key>
    <integer>60</integer>
    <key>ThrottleInterval</key>
    <integer>30</integer>
    <key>StandardOutPath</key>
    <string>/tmp/remux-runtime-sync.log</string>
    <key>StandardErrorPath</key>
    <string>/tmp/remux-runtime-sync.log</string>
    <key>EnvironmentVariables</key>
    <dict>
      <key>PATH</key>
      <string>$runtime_path</string>
      <key>HOME</key>
      <string>$HOME</string>
      <key>LANG</key>
      <string>en_US.UTF-8</string>
    </dict>
  </dict>
</plist>
EOF
}

write_runtime_plist main
write_runtime_plist dev
write_shared_runtime_plist
write_sync_plist

echo "installed:"
echo "  $(runtime_plist_path main)"
echo "  $(runtime_plist_path dev)"
echo "  $(runtime_shared_plist_path)"
echo "  $(runtime_sync_plist_path)"
echo
echo "next:"
echo "  npm run runtime:load-launchd"
