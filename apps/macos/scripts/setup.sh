#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
MONOREPO_ROOT="$(cd "$PROJECT_DIR/../.." && pwd)"
LOCAL_GHOSTTY_DIR="$PROJECT_DIR/ghostty"
MONOREPO_GHOSTTY_DIR="$MONOREPO_ROOT/vendor/ghostty"

cd "$PROJECT_DIR"

echo "==> Initializing submodules..."
git submodule update --init --recursive

echo "==> Checking for zig..."
if ! command -v zig &> /dev/null; then
    echo "Error: zig is not installed."
    echo "Install via: brew install zig"
    exit 1
fi

ACTIVE_GHOSTTY_DIR="$LOCAL_GHOSTTY_DIR"
if [[ ! -f "$ACTIVE_GHOSTTY_DIR/src/build/main.zig" ]]; then
    if [[ -f "$MONOREPO_GHOSTTY_DIR/src/build/main.zig" ]]; then
        echo "==> Embedded apps/macos/ghostty tree is incomplete; using monorepo vendor/ghostty"
        ACTIVE_GHOSTTY_DIR="$MONOREPO_GHOSTTY_DIR"
    else
        echo "Error: unable to locate a complete ghostty source tree."
        echo "Checked: $LOCAL_GHOSTTY_DIR and $MONOREPO_GHOSTTY_DIR"
        exit 1
    fi
fi

if [[ "$ACTIVE_GHOSTTY_DIR" == "$LOCAL_GHOSTTY_DIR" ]]; then
    GHOSTTY_SHA="$(git -C "$ACTIVE_GHOSTTY_DIR" rev-parse HEAD)"
else
    GHOSTTY_SHA="$(git -C "$MONOREPO_ROOT" rev-parse HEAD:vendor/ghostty)"
fi
CACHE_ROOT="${REMUX_GHOSTTYKIT_CACHE_DIR:-$HOME/.cache/remux/ghosttykit}"
CACHE_DIR="$CACHE_ROOT/$GHOSTTY_SHA"
CACHE_XCFRAMEWORK="$CACHE_DIR/GhosttyKit.xcframework"
LOCAL_XCFRAMEWORK="$ACTIVE_GHOSTTY_DIR/macos/GhosttyKit.xcframework"
LOCAL_SHA_STAMP="$LOCAL_XCFRAMEWORK/.ghostty_sha"
LOCK_DIR="$CACHE_ROOT/$GHOSTTY_SHA.lock"

mkdir -p "$CACHE_ROOT"

echo "==> Ghostty source key: $GHOSTTY_SHA"

LOCK_TIMEOUT=300
LOCK_START=$SECONDS
while ! mkdir "$LOCK_DIR" 2>/dev/null; do
    if (( SECONDS - LOCK_START > LOCK_TIMEOUT )); then
        echo "==> Lock stale (>${LOCK_TIMEOUT}s), removing and retrying..."
        rmdir "$LOCK_DIR" 2>/dev/null || rm -rf "$LOCK_DIR"
        continue
    fi
    echo "==> Waiting for GhosttyKit cache lock for $GHOSTTY_SHA..."
    sleep 1
done
trap 'rmdir "$LOCK_DIR" >/dev/null 2>&1 || true' EXIT

if [ -d "$CACHE_XCFRAMEWORK" ]; then
    echo "==> Reusing cached GhosttyKit.xcframework"
else
    # Only reuse local xcframework if its SHA stamp matches the current ghostty commit.
    # Without this check, a stale build from a previous commit could be cached under
    # the wrong SHA, producing ABI mismatches.
    LOCAL_SHA=""
    if [ -f "$LOCAL_SHA_STAMP" ]; then
        LOCAL_SHA="$(cat "$LOCAL_SHA_STAMP")"
    fi

    if [ -d "$LOCAL_XCFRAMEWORK" ] && [ "$LOCAL_SHA" = "$GHOSTTY_SHA" ]; then
        echo "==> Seeding cache from existing local GhosttyKit.xcframework (SHA matches)"
    else
        echo "==> Building GhosttyKit.xcframework (this may take a few minutes)..."
        (
            cd "$ACTIVE_GHOSTTY_DIR"
            zig build -Demit-xcframework=true -Dxcframework-target=universal -Doptimize=ReleaseFast
        )
        # Stamp the build output with the SHA it was built from
        echo "$GHOSTTY_SHA" > "$LOCAL_SHA_STAMP"
    fi

    if [ ! -d "$LOCAL_XCFRAMEWORK" ]; then
        echo "Error: GhosttyKit.xcframework not found at $LOCAL_XCFRAMEWORK"
        exit 1
    fi

    TMP_DIR="$(mktemp -d "$CACHE_ROOT/.ghosttykit-tmp.XXXXXX")"
    mkdir -p "$CACHE_DIR"
    cp -R "$LOCAL_XCFRAMEWORK" "$TMP_DIR/GhosttyKit.xcframework"
    rm -rf "$CACHE_XCFRAMEWORK"
    mv "$TMP_DIR/GhosttyKit.xcframework" "$CACHE_XCFRAMEWORK"
    rmdir "$TMP_DIR"
    echo "==> Cached GhosttyKit.xcframework at $CACHE_XCFRAMEWORK"
fi

echo "==> Creating symlink for GhosttyKit.xcframework..."
ln -sfn "$CACHE_XCFRAMEWORK" GhosttyKit.xcframework

echo "==> Setup complete!"
echo ""
echo "You can now build and run the app:"
echo "  ./scripts/reload.sh --tag first-run"
