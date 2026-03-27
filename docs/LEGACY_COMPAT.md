# Legacy Compatibility Paths

Remux now treats `runtime-v2` as the only active product contract.

Legacy `tmux` / `zellij` / `conpty` code still exists temporarily for migration, debugging, and rollback work, but it is no longer part of the default CLI help, CI path, or release narrative.

## Hidden Or Advanced CLI Paths

- Hidden compatibility flag: `--backend <auto|tmux|zellij|conpty>`
- Disable runtime-v2 startup and force legacy fallback detection: `REMUX_RUNTIME_V2=0`

If you need the legacy tmux fallback on macOS or Linux:

```bash
# macOS
brew install tmux

# Ubuntu / Debian
sudo apt install tmux
```

Optional tap-to-focus setup for the legacy tmux path:

```bash
echo 'set -g mouse on' >> ~/.tmux.conf
tmux source-file ~/.tmux.conf
```

## Legacy Environment Variables

- `REMUX_SOCKET_NAME`
- `REMUX_SOCKET_PATH`
- `REMUX_TRACE_TMUX=1`
- `REMUX_FORCE_SCRIPT_PTY=1`
- `REMUX_ZELLIJ_SOCKET_DIR`

These only matter when you are intentionally running the compatibility path.

## Legacy Tests And Builds

These commands are available explicitly, but they are not part of the default runtime-v2 gate:

```bash
npm run test:legacy
npm run test:e2e:legacy-ui
npm run test:legacy:tmux-smoke
npm run build:legacy:zellij-bridge
```

Use them only when you are debugging compatibility behavior or preparing to remove old code safely.
