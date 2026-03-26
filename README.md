# Remux

**Remote terminal multiplexers from a phone, tablet, or second laptop.**

Remux is a web client for `tmux`, with additional `zellij` and Windows `conpty` backends. It is built for checking long-running coding sessions, AI agents, builds, and remote shells without staying at your desk. Run `npx remux`, open the generated URL, and control the live workspace from a browser.

Remux is intentionally not a generic SSH terminal. It focuses on session-aware navigation, mobile input ergonomics, and fast reconnect behavior for real terminal workflows.

## Why Remux

- Browser-based access with no native app install
- Mobile-first controls for sessions, tabs, panes, scrollback, and common terminal shortcuts
- Password protection enabled by default, plus optional Cloudflare tunnel exposure
- Separate control and terminal WebSocket channels for structured state sync and terminal streaming
- Session-aware UI instead of raw terminal-only access
- Workflow extras: compose box, snippets, file upload, themes, reconnect, and backend switching

## Backend Support

Remux uses a multiplexer-neutral model internally: sessions, tabs, and panes.

- `tmux`: primary backend and the most mature path today
- `zellij`: supported, but some behavior differs because zellij semantics do not map cleanly to tmux
- `conpty`: Windows fallback when tmux and zellij are unavailable

If you want the most polished experience, use `tmux`. For current zellij caveats, see [docs/ZELLIJ_MODE_AUDIT_2026-03-25.md](./docs/ZELLIJ_MODE_AUDIT_2026-03-25.md).

## Screenshots

### Amber
![Remux screenshot - Amber](./docs/assets/screenshot.png)

### Midnight
![Remux screenshot - Midnight](./docs/assets/screenshot-midnight.png)

## Quick Start

### Run from npm

```bash
npx remux
```

Remux prints:

- a local URL
- a tunnel URL when tunnel mode is enabled
- a password when password protection is enabled
- a QR code for quick mobile access

### Run from source

```bash
git clone https://github.com/yaoshenwang/remux.git
cd remux
npm install
npm start
```

## Requirements

- Node.js 20+
- One supported backend:
  - `tmux` on macOS / Linux
  - `zellij` on macOS / Linux
  - Windows terminal environment for `conpty`

For the best current experience:

```bash
# macOS
brew install tmux

# Ubuntu / Debian
sudo apt install tmux
```

Recommended for tap-to-focus in `tmux`:

```bash
echo 'set -g mouse on' >> ~/.tmux.conf
tmux source-file ~/.tmux.conf
```

## Features

- Session, tab, and pane management from the browser drawer
- Full terminal streaming through xterm.js
- Inline scrollback viewer with mobile-friendly text selection
- Compose input for native mobile keyboard entry
- Custom snippets stored in local browser storage
- Drag-and-drop or picker-based file upload into the active pane working directory
- Theme picker with six built-in terminal themes
- Automatic reconnect with backoff
- Runtime backend switching between `tmux`, `zellij`, and `conpty` when available

## CLI

```text
remux [options]

Options:
  -p, --port <port>                Local port (default: 8767)
  --host <host>                    Bind address (default: 127.0.0.1)
  --password <pass>                Authentication password
  --[no-]require-password          Toggle password protection (default: true)
  --[no-]tunnel                    Start Cloudflare quick tunnel (default: true)
  --session <name>                 Default session name (default: main)
  --scrollback <lines>             Default scrollback capture lines (default: 1000)
  --debug-log <path>               Write backend debug logs to a file
  --backend <auto|tmux|zellij|conpty>
                                   Force a specific backend
```

## Environment Variables

| Variable | Description |
|----------|-------------|
| `REMUX_DEBUG_LOG` | Debug log file path |
| `REMUX_SOCKET_NAME` | Custom tmux socket name (`tmux -L`) |
| `REMUX_SOCKET_PATH` | Custom tmux socket path (`tmux -S`) |
| `REMUX_TRACE_TMUX=1` | Print tmux CLI calls |
| `REMUX_VERBOSE_DEBUG=1` | Enable verbose server logging |
| `REMUX_FORCE_SCRIPT_PTY=1` | Force `script(1)` PTY fallback on Unix |
| `REMUX_TOKEN` | Reuse a fixed auth token across restarts |
| `VITE_DEV_MODE=1` | Backend knows frontend is served by Vite during development |

## Security Defaults

- Token authentication is always required
- Password protection is enabled by default
- Control and terminal WebSockets authenticate independently
- The server binds to `127.0.0.1` by default
- Tunnel mode uses Cloudflare's HTTPS endpoint instead of exposing the local server directly

Read the full model in [docs/SECURITY.md](./docs/SECURITY.md).

## Documentation

- [docs/SPEC.md](./docs/SPEC.md): current architecture and protocol model
- [docs/SECURITY.md](./docs/SECURITY.md): security assumptions, risks, and operating guidance
- [docs/NATIVE_PLATFORM_ROADMAP_2026-03-26.md](./docs/NATIVE_PLATFORM_ROADMAP_2026-03-26.md): native-client and semantic-adapter evolution plan
- [docs/ZELLIJ_MODE_AUDIT_2026-03-25.md](./docs/ZELLIJ_MODE_AUDIT_2026-03-25.md): current zellij backend audit

## Development

```bash
npm run dev
```

Quality gate before merging into `dev`:

```bash
npm run typecheck
npm test
npm run build
```

Additional test commands:

```bash
npm run test:e2e
npm run test:smoke
```

## Tech Stack

- Backend: Node.js, Express 5, `ws`, `node-pty`, `yargs`, `zod`
- Frontend: React 19, Vite, xterm.js
- Testing: Vitest and Playwright
- Language: TypeScript

## Acknowledgments

Remux was originally inspired by [tmux-mobile](https://github.com/DagsHub/tmux-mobile) and [porterminal](https://github.com/lyehe/porterminal), then substantially rewritten around a dedicated mobile-first control surface.

## License

MIT. See [LICENSE](./LICENSE).
