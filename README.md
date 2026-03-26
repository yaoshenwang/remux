# Remux

![Remux hero](./docs/assets/hero.svg)

**Monitor, inspect, and control live terminal workspaces from a phone, tablet, or second laptop.**

[![GitHub stars](https://img.shields.io/github/stars/yaoshenwang/remux?style=social)](https://github.com/yaoshenwang/remux/stargazers)
![GitHub contributors](https://img.shields.io/github/contributors/yaoshenwang/remux)

Remux is a remote workspace cockpit for terminal-first work. It helps you check on long-running coding sessions, AI agents, builds, and shells when you are away from the primary machine. Run `npx remux`, open the generated URL, and move between three complementary surfaces: `Inspect` for readable history and context, `Live` for direct terminal I/O, and `Control` for structured workspace operations.

Remux is intentionally not a generic browser SSH client and not a thin browser wrapper around a multiplexer. It is designed for awareness first, comprehension second, and lightweight intervention when needed.

## Why Remux

- Catch up on the current tab from another device without relying only on the visible terminal viewport
- Read, copy, and inspect terminal history more comfortably on mobile
- Jump into Live only when direct intervention is necessary
- Navigate sessions, tabs, and panes through a structured Control surface
- Browser-based access with no native app install
- Password protection enabled by default, plus optional Cloudflare tunnel exposure
- Separate control and terminal WebSocket channels for structured state sync and terminal streaming

## Product Surfaces

![Remux surfaces](./docs/assets/surfaces.svg)

- `Inspect`: readable history and context for catching up, copying, and understanding what happened
- `Live`: direct terminal I/O for quick fixes, command entry, and interactive tools
- `Control`: structured session, tab, and pane navigation plus workspace operations

## Backend Support

Remux uses a multiplexer-neutral workspace model internally, but it does not promise equal fidelity across all backends.

- `tmux`: flagship backend and the most polished path today
- `zellij`: supported with explicit capability and history-fidelity caveats
- `conpty`: Windows fallback for simpler persistent shell access

If you want the most polished experience, use `tmux`. For current zellij caveats, see [docs/ZELLIJ_MODE_AUDIT_2026-03-25.md](./docs/ZELLIJ_MODE_AUDIT_2026-03-25.md).

## Remux vs Zellij

`zellij` and Remux are complementary, not substitutes.

- `zellij` is a terminal multiplexer you run on the machine itself
- Remux is a remote awareness and control layer you open from another device
- `zellij` gives you native local pane and tab management
- Remux gives you mobile-friendly Inspect, browser control surfaces, remote attach flows, and structured workspace navigation

If you want the best local terminal multiplexer experience, use `zellij` or `tmux` directly.
If you want to monitor and intervene from a phone, tablet, or second laptop, Remux is the product layer on top.

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

- Session, tab, and pane management from the browser control drawer
- Full terminal streaming through xterm.js for Live interaction
- Inspect view for readable history and mobile-friendly text selection
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
| `REMUX_FORCE_SCRIPT_PTY=1` | Force a fail-fast check for degraded tmux PTY mode; Remux refuses `script(1)` because it breaks resize invariants |
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

- [docs/PRODUCT_ARCHITECTURE.md](./docs/PRODUCT_ARCHITECTURE.md): product definition, interaction model, inspect/history strategy, backend posture, and roadmap
- [docs/SPEC.md](./docs/SPEC.md): current architecture and protocol model
- [docs/SECURITY.md](./docs/SECURITY.md): security assumptions, risks, and operating guidance
- [docs/NATIVE_PLATFORM_ROADMAP_2026-03-26.md](./docs/NATIVE_PLATFORM_ROADMAP_2026-03-26.md): native-client and semantic-adapter evolution plan
- [docs/ZELLIJ_MODE_AUDIT_2026-03-25.md](./docs/ZELLIJ_MODE_AUDIT_2026-03-25.md): current zellij backend audit

## Development

```bash
npm run dev
```

Managed runtime sync for long-running `main` / `dev` instances:

```bash
npm run runtime:install-launchd
npm run runtime:sync
npm run runtime:status
```

See [docs/RUNTIME_SYNC.md](./docs/RUNTIME_SYNC.md) for the detached runtime worktree layout and launchd setup.

Self-hosted deploy runner:

```bash
npm run runner:install
npm run runner:status
```

See [docs/SELF_HOSTED_RUNNER.md](./docs/SELF_HOSTED_RUNNER.md) for the deploy workflow and security boundary.

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

## Contributors

Thanks to everyone who has helped shape Remux.

[![Contributors](https://contrib.rocks/image?repo=yaoshenwang/remux)](https://github.com/yaoshenwang/remux/graphs/contributors)

Made with [contrib.rocks](https://contrib.rocks).

## Star History

[![Star History Chart](https://api.star-history.com/svg?repos=yaoshenwang/remux&type=Date)](https://star-history.com/#yaoshenwang/remux&Date)

## License

MIT. See [LICENSE](./LICENSE).
