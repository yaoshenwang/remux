#!/bin/bash
# Rebrand remux → Remux across the codebase.
# Run from the project root after submodules are initialized and the project compiles.
# Review changes before committing.

set -euo pipefail

SOURCES_DIR="Sources"
CLI_DIR="CLI"

echo "=== Phase 1: Environment variable prefix REMUX_ → REMUX_ ==="
# Only in Sources and CLI, not in vendor/ghostty
find "$SOURCES_DIR" "$CLI_DIR" -name "*.swift" -exec sed -i '' \
    -e 's/REMUX_SURFACE_ID/REMUX_SURFACE_ID/g' \
    -e 's/REMUX_WORKSPACE_ID/REMUX_WORKSPACE_ID/g' \
    -e 's/REMUX_PANEL_ID/REMUX_PANEL_ID/g' \
    -e 's/REMUX_TAB_ID/REMUX_TAB_ID/g' \
    -e 's/REMUX_SOCKET_PATH/REMUX_SOCKET_PATH/g' \
    -e 's/REMUX_SOCKET/REMUX_SOCKET/g' \
    -e 's/REMUX_BUNDLED_CLI_PATH/REMUX_BUNDLED_CLI_PATH/g' \
    -e 's/REMUX_BUNDLE_ID/REMUX_BUNDLE_ID/g' \
    -e 's/REMUX_PORT/REMUX_PORT/g' \
    -e 's/REMUX_PORT_END/REMUX_PORT_END/g' \
    -e 's/REMUX_PORT_RANGE/REMUX_PORT_RANGE/g' \
    -e 's/REMUX_SHELL_INTEGRATION/REMUX_SHELL_INTEGRATION/g' \
    -e 's/REMUX_CLAUDE_HOOKS_DISABLED/REMUX_CLAUDE_HOOKS_DISABLED/g' \
    -e 's/REMUX_DEV_/REMUX_DEV_/g' \
    {} +

echo "=== Phase 2: Bundle identifier ==="
find "$SOURCES_DIR" -name "*.swift" -exec sed -i '' \
    -e 's/com\.remux\.app/com.remux.macos/g' \
    -e 's/com\.remux/com.remux/g' \
    {} +

echo "=== Phase 3: Notification names ==="
find "$SOURCES_DIR" -name "*.swift" -exec sed -i '' \
    -e 's/com\.remux\.themes/com.remux.themes/g' \
    {} +

echo "=== Phase 4: Socket/config directory ==="
find "$SOURCES_DIR" -name "*.swift" -exec sed -i '' \
    -e 's|\.remux/socket|.remux/socket|g' \
    -e 's|\.remux/|.remux/|g' \
    -e 's|remux-last-socket-path|remux-last-socket-path|g' \
    {} +

echo "=== Phase 5: Display names (case-sensitive) ==="
# "remux" → "Remux" in user-visible strings
find "$SOURCES_DIR" -name "*.swift" -exec sed -i '' \
    -e 's/"remux processes only"/"Remux processes only"/g' \
    -e 's/inside remux terminals/inside Remux terminals/g' \
    -e 's/remuxOnly/remuxOnly/g' \
    {} +

echo "=== Phase 6: Class/enum prefixes ==="
find "$SOURCES_DIR" -name "*.swift" -exec sed -i '' \
    -e 's/RemuxSurfaceConfigTemplate/RemuxSurfaceConfigTemplate/g' \
    -e 's/remuxSurfaceContextName/remuxSurfaceContextName/g' \
    -e 's/RemuxConfig/RemuxConfig/g' \
    -e 's/RemuxConfigStore/RemuxConfigStore/g' \
    -e 's/RemuxThemeNotifications/RemuxThemeNotifications/g' \
    -e 's/RemuxTypingTiming/RemuxTypingTiming/g' \
    -e 's/remuxAccentNSColor/remuxAccentNSColor/g' \
    -e 's/remuxConfigStore/remuxConfigStore/g' \
    {} +

echo "=== Phase 7: UserDefaults keys ==="
find "$SOURCES_DIR" -name "*.swift" -exec sed -i '' \
    -e 's/remuxDev/remuxDev/g' \
    -e 's/remuxTypingTimingLogs/remuxTypingTimingLogs/g' \
    -e 's/remuxKeyLatencyProbe/remuxKeyLatencyProbe/g' \
    {} +

echo "=== Phase 8: File renames ==="
[ -f "$SOURCES_DIR/RemuxConfig.swift" ] && git mv "$SOURCES_DIR/RemuxConfig.swift" "$SOURCES_DIR/RemuxConfig.swift"
[ -f "$SOURCES_DIR/remuxApp.swift" ] && git mv "$SOURCES_DIR/remuxApp.swift" "$SOURCES_DIR/RemuxApp.swift"

echo "=== Phase 9: @main struct rename ==="
if [ -f "$SOURCES_DIR/RemuxApp.swift" ]; then
    sed -i '' 's/struct remuxApp:/struct RemuxApp:/g' "$SOURCES_DIR/RemuxApp.swift"
fi

echo ""
echo "Done. Review changes with: git diff"
echo "Build and test before committing."
