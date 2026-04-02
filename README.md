# Remux

**Remote terminal workspace — powered by ghostty-web.**

[![GitHub stars](https://img.shields.io/github/stars/yaoshenwang/remux?style=social)](https://github.com/yaoshenwang/remux/stargazers)
![GitHub contributors](https://img.shields.io/github/contributors/yaoshenwang/remux)

Remux lets you monitor and control terminal sessions from any device — phone, tablet, or another computer — through a web browser. It runs a lightweight Node.js server that manages shell sessions and streams them via WebSocket using [ghostty-web](https://github.com/coder/ghostty-web) for stable, high-quality terminal rendering.

## Why Remux

- Access your terminal sessions from any browser, including mobile
- Multiple sessions and tabs, managed through a VS Code-style sidebar and tab bar
- Stable rendering with ghostty-web (Ghostty VT engine compiled to WASM)
- Server-side VT state tracking for instant session restore on reconnect
- Mobile-friendly compose bar for special keys (Esc, Tab, Ctrl, arrows)
- Token authentication for secure access
- Session persistence across server restarts
- Zero configuration — `npx @yaoshenwang/remux` and go

## Quick Start

### Prerequisites

- Node.js 20+

### Run from npm

```bash
npx @yaoshenwang/remux
```

Remux prints a local URL. Open it from any browser.

### Run with authentication

```bash
REMUX_TOKEN=my-secret-token npx @yaoshenwang/remux
```

Access via `http://localhost:8767/?token=my-secret-token`.

### Run from source

```bash
git clone https://github.com/yaoshenwang/remux.git
cd remux
pnpm install
pnpm start
```

## Features

- **Multiple sessions** — create, switch, and delete named sessions from the sidebar
- **Multiple tabs per session** — Chrome-style tab bar with create, close, and switch
- **ghostty-web rendering** — Ghostty VT engine in WASM, stable truecolor Canvas rendering
- **Server-side VT tracking** — ghostty-vt WASM tracks terminal state for instant snapshot restore
- **Session persistence** — sessions and scrollback survive server restarts
- **Multi-client support** — multiple browsers can connect simultaneously with coordinated terminal sizing
- **Token authentication** — protect access with `REMUX_TOKEN` environment variable
- **Mobile support** — responsive sidebar drawer, compose bar for special keys, viewport-aware layout
- **Auto reconnect** — WebSocket reconnects automatically on disconnection

## Architecture

```
Browser (ghostty-web Canvas)
    │
    └── WebSocket /ws (control + terminal data)
            │
            ▼
    server.js (Node.js)
    ├── HTTP server (serves app + ghostty-web assets)
    ├── WebSocket server (session/tab control + terminal I/O)
    ├── PTY management (node-pty, direct shell)
    ├── VT tracking (ghostty-vt WASM, server-side snapshots)
    └── Session persistence (JSON file, periodic save)
```

## Environment Variables

| Variable | Description |
|----------|-------------|
| `PORT` | Server port (default: 8767) |
| `REMUX_TOKEN` | Authentication token (optional; if set, required for access) |
| `REMUX_INSTANCE_ID` | Instance identifier for persistence file isolation |

## Tech Stack

- **Runtime**: Node.js 20+
- **Terminal rendering**: [ghostty-web](https://github.com/coder/ghostty-web) (Ghostty VT engine, WASM + Canvas)
- **PTY management**: [node-pty](https://github.com/niclas-niclas-niclas/node-pty)
- **WebSocket**: [ws](https://github.com/websockets/ws)
- **Server-side VT**: ghostty-vt WASM (same engine as browser, loaded server-side)
- **Testing**: [Vitest](https://vitest.dev/)
- **TUI companion**: Go + Bubbletea (in `tui/`)

## Development

```bash
pnpm install
pnpm run dev      # start server
pnpm test         # run tests
```

## Contributors

Thanks to everyone who has helped shape Remux.

[![Contributors](https://contrib.rocks/image?repo=yaoshenwang/remux)](https://github.com/yaoshenwang/remux/graphs/contributors)

Made with [contrib.rocks](https://contrib.rocks).

## Star History

[![Star History Chart](https://api.star-history.com/svg?repos=yaoshenwang/remux&type=Date)](https://star-history.com/#yaoshenwang/remux&Date)

## License

MIT. See [LICENSE](./LICENSE).
