# Remux

![Remux hero](./docs/assets/hero.svg)

**Runtime Cockpit now, Agentic Workstation next, Collaboration OS later.**

[![GitHub stars](https://img.shields.io/github/stars/yaoshenwang/remux?style=social)](https://github.com/yaoshenwang/remux/stargazers)
![GitHub contributors](https://img.shields.io/github/contributors/yaoshenwang/remux)

Remux is a remote workspace cockpit for terminal-first work. It uses Zellij as the shared session backend and adds Inspect, Live, and Control surfaces for catching up, intervening, and navigating from another device.

The product roadmap is deliberately staged:

- `Runtime Cockpit`: today’s shipped path, centered on Zellij-backed Inspect, Live, and Control
- `Agentic Workstation`: the next layer, where review, worktree, and agent-run workflows become first-class
- `Collaboration OS`: the longer-horizon shell, where topics, artifacts, approvals, and handoff become durable workspace objects

Remux does not try to replace Zellij. Zellij owns session, tab, pane, and attach truth; Remux adds web access, authentication, mobile-friendly controls, inspect views, and optional tunnel exposure on top.

## Why Remux

- Catch up on the current workspace without relying only on the visible terminal viewport
- Read, copy, and inspect terminal history more comfortably on mobile
- Jump into Live only when direct intervention is necessary
- Navigate sessions, tabs, and panes through a structured Control surface
- Reuse the same shared Zellij session from multiple browsers without rebuilding the runtime stack
- Protect access with token auth, optional password auth, and HTTPS tunnel exposure

## Roadmap Arc

Remux is being built in three explicit phases so the product can ship continuously without blocking on a rewrite:

- `Runtime Cockpit`: harden the current Zellij + Node.js + Web stack and make Inspect the reliable catch-up surface
- `Agentic Workstation`: add richer review, agent, worktree, and approval flows on top of the current runtime truth
- `Collaboration OS`: grow from a terminal cockpit into a topic-first collaborative workspace shell

## Product Surfaces

![Remux surfaces](./docs/assets/surfaces.svg)

- `Inspect`: readable history and context for catching up, copying, and understanding what happened
- `Live`: direct terminal I/O for quick fixes, command entry, and interactive tools
- `Control`: structured session, tab, and pane navigation plus workspace operations

## Backend Model

- The public and default backend is Zellij
- `/ws/terminal` carries terminal I/O and resize messages
- `/ws/control` carries workspace state, structured commands, inspect capture, and stats
- Each browser client gets its own attach PTY, while Zellij remains the shared source of truth
- Historical planning material is preserved under [docs/archive/README.md](./docs/archive/README.md)

## Quick Start

### 1. Install prerequisites

- Node.js 20+
- Zellij installed and available in `PATH`

Verify Zellij first:

```bash
zellij --version
```

### 2. Run from npm

```bash
npx remux
```

Remux prints:

- a local URL
- a tunnel URL when tunnel mode is enabled
- a password when password protection is enabled
- a QR code for quick mobile access

### 3. Open from another device

- Browser: open the printed local or tunnel URL
- Phone or tablet: scan the printed QR code
- Shared access: use the printed password when password protection is enabled

### 4. Run from source

```bash
git clone https://github.com/yaoshenwang/remux.git
cd remux
npm install
npm start
```

## Requirements

- Node.js 20+
- Zellij installed and available in `PATH` or passed via `--zellij-bin`
- Optional `devtunnel` or `cloudflared` when tunnel mode is enabled

## Features

- Session, tab, and pane management from the browser control drawer
- Full terminal streaming through xterm.js for Live interaction
- Inspect view for readable history and mobile-friendly text selection
- Per-client PTY attach model for reconnect-friendly shared sessions
- Compose input for native mobile keyboard entry
- Drag-and-drop or picker-based image upload into the active workspace
- Theme picker with built-in terminal themes
- Automatic reconnect with keepalive
- Optional Gastown metadata enrichment when running inside a Gastown workspace

## CLI

```text
remux [options]

Options:
  -p, --port <port>                Local port (default: 8767)
  --host <host>                    Bind address (default: 127.0.0.1)
  --password <pass>                Authentication password
  --[no-]require-password          Toggle password protection (default: true)
  --[no-]tunnel                    Start a public tunnel (default: true)
  --tunnel-provider <provider>     Tunnel provider: auto, devtunnel, cloudflare
  --zellij-session <name>          Zellij session name (default: remux)
  --zellij-bin <path>              Path to zellij binary
  --debug-log <path>               Write backend debug logs to a file
```

## Environment Variables

| Variable | Description |
|----------|-------------|
| `REMUX_DEBUG_LOG` | Debug log file path |
| `REMUX_PASSWORD` | Password used when `--require-password` is enabled |
| `REMUX_TOKEN` | Reuse a fixed auth token across restarts |
| `VITE_DEV_MODE=1` | Backend knows frontend is served by Vite during development |

## Security Defaults

- Token authentication is always required
- Password protection is enabled by default
- Control and terminal WebSockets authenticate independently
- The server binds to `127.0.0.1` by default
- Tunnel mode prefers HTTPS exposure through DevTunnel or Cloudflare instead of exposing the local port directly

## Documentation

- [docs/README.md](./docs/README.md): documentation entrypoint
- [docs/CURRENT_BASELINE.md](./docs/CURRENT_BASELINE.md): current architecture truth
- [docs/ACTIVE_DOCS_INDEX.md](./docs/ACTIVE_DOCS_INDEX.md): active, draft, and archive authority map
- [docs/SPEC.md](./docs/SPEC.md): current Zellij-backed architecture, transport model, and API surface
- [docs/TESTING.md](./docs/TESTING.md): current test loop and merge gate
- [docs/archive/README.md](./docs/archive/README.md): archived legacy and transition documents

## Development

```bash
npm run dev
```

Current validation commands:

```bash
npm run typecheck
npm test
npm run build
npm run test:e2e
```

The required pre-merge gate is:

```bash
npm run typecheck && npm test && npm run build
```

## Tech Stack

- Backend gateway: Node.js, Express 5, `ws`, `node-pty`
- Session backend: Zellij
- Frontend: React 19, Vite, xterm.js
- Testing: Vitest and Playwright
- Language: TypeScript

This stack maps to the current `Runtime Cockpit` phase. Future phases extend the same product line rather than replacing the shipped path wholesale.

## Acknowledgments

Remux was originally inspired by existing browser-based terminal access tools and then rewritten around a Zellij-backed, mobile-first control surface.

## Contributors

Thanks to everyone who has helped shape Remux.

[![Contributors](https://contrib.rocks/image?repo=yaoshenwang/remux)](https://github.com/yaoshenwang/remux/graphs/contributors)

Made with [contrib.rocks](https://contrib.rocks).

## Star History

[![Star History Chart](https://api.star-history.com/svg?repos=yaoshenwang/remux&type=Date)](https://star-history.com/#yaoshenwang/remux&Date)

## License

MIT. See [LICENSE](./LICENSE).
