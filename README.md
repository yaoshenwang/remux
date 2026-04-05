# Remux

**Remote terminal workspace with tsm-style attach / reattach semantics.**

[![GitHub stars](https://img.shields.io/github/stars/yaoshenwang/remux?style=social)](https://github.com/yaoshenwang/remux/stargazers)
![GitHub contributors](https://img.shields.io/github/contributors/yaoshenwang/remux)

Remux lets you monitor and control terminal sessions from any device — phone, tablet, or another computer — through a web browser. It runs a lightweight Node.js server that owns session truth, keeps PTY-backed tabs alive, and streams them over WebSocket using [ghostty-web](https://github.com/coder/ghostty-web) for stable terminal rendering.

This repository is now the Remux monorepo: the Node.js gateway and browser shell remain at the root, the full macOS client lives in [`apps/macos`](./apps/macos), and adjacent iOS app work remains in [`apps/ios`](./apps/ios) without being part of the current public release gate.

## Official Surfaces

The canonical public entrypoints for Web, npm, and macOS live in [`docs/OFFICIAL_SURFACES.md`](./docs/OFFICIAL_SURFACES.md).

- Web: `https://remux.yaoshen.wang`
- npm / CLI: `npx @wangyaoshen/remux`
- macOS: signed DMG on GitHub Releases

## Why Remux

- Access your terminal sessions from any browser, including mobile
- Multiple sessions and tabs, managed through a VS Code-style sidebar and tab bar
- Stable rendering with ghostty-web (Ghostty VT engine compiled to WASM)
- Server-side VT state tracking for instant session restore on reconnect
- Mobile-friendly compose bar for special keys (Esc, Tab, Ctrl, arrows)
- Token authentication for secure access
- Session persistence across server restarts
- Zero configuration — `npx @wangyaoshen/remux` and go

## Quick Start

### Prerequisites

- Node.js 24.x

### Run from npm

```bash
npx @wangyaoshen/remux
```

Remux prints a local URL. Open it from any browser.

### Run with authentication

```bash
REMUX_TOKEN=my-secret-token npx @wangyaoshen/remux
```

Access via `http://localhost:8767/?token=my-secret-token`.

### Run from source

```bash
git clone https://github.com/yaoshenwang/remux.git
cd remux
pnpm install
pnpm start
```

### Build macOS client from source

```bash
cd apps/macos
./scripts/reload.sh --tag local
```

For signed DMG releases, use the macOS release pipeline under `apps/macos/scripts/`.

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
Browser / Native Surface
    │
    └── WebSocket /ws
            │
            ▼
    server.js
    ├── src/cli/remux-server.ts
    ├── src/gateway/ws/
    ├── src/runtime/
    ├── src/persistence/
    ├── src/domain/
    └── src/integrations/
```

## Repo Layout

- `src/cli/` — CLI bootstrap and server assembly
- `src/gateway/` — transport-facing entrypoints, currently centered on WebSocket handling
- `src/runtime/` — PTY lifecycle, detached daemon protocol, VT snapshotting, buffering
- `src/persistence/` — SQLite-backed state and repositories
- `src/domain/` — auth and workspace-domain logic
- `src/integrations/` — adapters, git, push, tunnel, macOS service integration
- `tests/` — backend and Playwright coverage for the web/runtime path
- `apps/macos/` — GPL macOS desktop client, CLI, release scripts, and native tests
- `apps/ios/` — adjacent iOS app work that is not part of the current public release gate
- `packages/` — shared libraries such as `RemuxKit`
- `labs/` — archived or non-shipping lines kept for reference, not current product truth
- `docs/` — active baseline, testing guidance, ADRs, and roadmap docs

## Environment Variables

| Variable | Description |
|----------|-------------|
| `PORT` | Server port (default: 8767) |
| `REMUX_TOKEN` | Authentication token (optional; if set, required for access) |
| `REMUX_INSTANCE_ID` | Instance identifier for persistence file isolation |
| `REMUX_HOME` | Override the state directory used for databases and logs (default: `~/.remux`) |

## Tech Stack

- **Runtime**: Node.js 24.x
- **Terminal rendering**: [ghostty-web](https://github.com/coder/ghostty-web) (Ghostty VT engine, WASM + Canvas)
- **PTY management**: [node-pty](https://github.com/niclas-niclas-niclas/node-pty)
- **WebSocket**: [ws](https://github.com/websockets/ws)
- **Server-side VT**: ghostty-vt WASM (same engine as browser, loaded server-side)
- **Testing**: [Vitest](https://vitest.dev/)

## Development

```bash
pnpm install
pnpm run dev      # start server
pnpm test         # rebuild bundles, then run tests
```

## Contributors

Thanks to everyone who has helped shape Remux.

[![Contributors](https://contrib.rocks/image?repo=yaoshenwang/remux)](https://github.com/yaoshenwang/remux/graphs/contributors)

Made with [contrib.rocks](https://contrib.rocks).

## Star History

[![Star History Chart](https://api.star-history.com/svg?repos=yaoshenwang/remux&type=Date)](https://star-history.com/#yaoshenwang/remux&Date)

## License

GPL-3.0-or-later. See [LICENSE](./LICENSE) and [docs/licensing.md](./docs/licensing.md).
