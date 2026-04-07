# Contributing to remux

## Prerequisites

- macOS 14+
- Xcode 15+
- [Zig](https://ziglang.org/) (install via `brew install zig`)

## Getting Started

1. Clone the repository with submodules:
   ```bash
   git clone --recursive https://github.com/yaoshenwang/remux.git
   cd remux
   ```

2. Run the setup script:
   ```bash
   ./scripts/setup.sh
   ```

   This will:
   - Initialize git submodules (ghostty, homebrew-tap)
   - Build the GhosttyKit.xcframework from source
   - Create the necessary symlinks

3. Build and run the debug app:
   ```bash
   ./scripts/reload.sh
   ```

## Development Scripts

| Script | Description |
|--------|-------------|
| `./scripts/setup.sh` | One-time setup (submodules + xcframework) |
| `./scripts/reload.sh` | Build and launch Debug app |
| `./scripts/reloadp.sh` | Build and launch Release app |
| `./scripts/reload2.sh` | Reload both Debug and Release |
| `./scripts/rebuild.sh` | Clean rebuild |

## Rebuilding GhosttyKit

If you make changes to the ghostty submodule, rebuild the xcframework:

```bash
cd ghostty
zig build -Demit-xcframework=true -Doptimize=ReleaseFast
```

## Running Tests

### Basic tests (run on VM)

```bash
ssh remux-vm 'cd /Users/remux/GhosttyTabs && xcodebuild -project GhosttyTabs.xcodeproj -scheme remux -configuration Debug -destination "platform=macOS" build && pkill -x "remux DEV" || true && APP=$(find /Users/remux/Library/Developer/Xcode/DerivedData -path "*/Build/Products/Debug/remux DEV.app" -print -quit) && open "$APP" && for i in {1..20}; do [ -S /tmp/remux.sock ] && break; sleep 0.5; done && python3 tests/test_update_timing.py && python3 tests/test_signals_auto.py && python3 tests/test_ctrl_socket.py && python3 tests/test_notifications.py'
```

### UI tests (run on VM)

```bash
ssh remux-vm 'cd /Users/remux/GhosttyTabs && xcodebuild -project GhosttyTabs.xcodeproj -scheme remux -configuration Debug -destination "platform=macOS" -only-testing:remuxUITests test'
```

## Ghostty Submodule

The `ghostty` submodule points to [yaoshenwang/ghostty](https://github.com/yaoshenwang/ghostty), a fork of the upstream Ghostty project.

### Making changes to ghostty

```bash
cd ghostty
git checkout -b my-feature
# make changes
git add .
git commit -m "Description of changes"
git push manaflow my-feature
```

### Keeping the fork updated

```bash
cd ghostty
git fetch origin
git checkout main
git merge origin/main
git push manaflow main
```

Then update the parent repo:

```bash
cd ..
git add ghostty
git commit -m "Update ghostty submodule"
```

See `docs/ghostty-fork.md` for details on fork changes and conflict notes.

## License

By contributing to this repository, you agree that your contributions are licensed under the project's GNU Affero General Public License v3.0 or later (`AGPL-3.0-or-later`).
