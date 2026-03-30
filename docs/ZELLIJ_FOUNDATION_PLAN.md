# Zellij Foundation — Architecture & Roadmap

## Problem

Remux started as a cross-device terminal management tool, but the architecture
grew too complex. The runtime-v2 path included:

- **13 Rust crates** (remux-pty, remux-terminal, remux-session, remux-store, …)
- **A custom Rust daemon** (remuxd) with PTY management, terminal state machine,
  session/tab/pane model, persistence, and patch generation
- **A 2855-line Node.js gateway** (server-v2.ts) bridging browsers to remuxd
- **A 1672-line React component** (App.tsx) with dual WebSocket channels,
  workspace state, terminal patch/revision tracking, and inspect views
- **Custom terminal patch system** with revision tracking, epoch validation,
  canonical reflow diffs, and bandwidth telemetry

The core issue: **Remux was reinventing the terminal multiplexer** — PTY hosting,
session/tab/pane layout, terminal rendering, persistence — all things Zellij
already provides natively.

## Solution

Use Zellij as the foundation. Remux becomes a **web portal for Zellij**, not a
replacement for it.

### Architecture

```
Browser (xterm.js)  ←—  WebSocket  ←—  Node.js Server  ←—  node-pty (Zellij)
```

One PTY runs Zellij. One WebSocket carries terminal I/O. All session, tab, and
pane management happens inside Zellij's native TUI. The Node.js server is a
thin auth + transport bridge.

### What Zellij provides (no longer custom)

| Capability                | Old (custom)                   | New (Zellij native)          |
|---------------------------|--------------------------------|------------------------------|
| PTY hosting               | remux-pty (portable_pty)       | Zellij manages all PTYs      |
| Terminal rendering        | remux-terminal (vt100 parser)  | Zellij internal renderer     |
| Session/tab/pane model    | remux-session (LayoutNode)     | Zellij core feature          |
| Persistence & recovery    | remux-store (envelope v1)      | `zellij attach --create`     |
| Terminal patch generation | remux-terminal (row diffing)   | Raw PTY output stream        |
| Keyboard multiplexing     | Dual WebSocket protocol        | Single PTY I/O               |

### What Remux still provides

- **Web access** — browser-based terminal from any device
- **Auth** — token + optional password (timing-safe)
- **Cloudflare tunnel** — remote access without port forwarding
- **Mobile UI** — touch toolbar with modifier keys (Ctrl/Alt/Shift/Meta)
- **Compose bar** — text input for mobile keyboards
- **Theme switching** — dark/light modes

## Code comparison

| Component         | runtime-v2              | zellij-foundation       |
|-------------------|-------------------------|-------------------------|
| Backend server    | server-v2.ts (2855 LOC) | server-zellij.ts (~190) |
| Frontend app      | App.tsx (1672 LOC)      | App.tsx (~180)           |
| CLI entry         | cli.ts (200 LOC)        | cli-zellij.ts (~140)    |
| PTY layer         | 13 Rust crates          | zellij-pty.ts (~90)     |
| Connection hook   | 3 hooks (~1000 LOC)     | useZellijConnection (~170) |
| Build chain       | Cargo + tsc + Vite      | tsc + Vite              |
| **Total critical path** | **~4500 LOC**    | **~770 LOC**            |

## Phase 1 — Web TTY (DONE)

**Branch:** `feat/zellij-foundation`
**Status:** Validated, working via Cloudflare tunnel

### Deliverables

- `src/backend/pty/zellij-pty.ts` — node-pty wrapper spawning `zellij attach --create <session>`
- `src/backend/server-zellij.ts` — Express + single WebSocket server
- `src/backend/cli-zellij.ts` — simplified CLI with `--zellij-session` and `--zellij-bin` flags
- `src/frontend/hooks/useZellijConnection.ts` — single-WebSocket connection hook
- `src/frontend/App.tsx` — rewritten from 1672 to ~180 lines

### WebSocket protocol

```
1. Client connects to /ws/terminal
2. Client sends: { type: "auth", token, password?, cols?, rows? }
3. Server replies: { type: "auth_ok" } or { type: "auth_error", reason }
4. After auth:
   - Client → Server: binary (terminal input) or JSON { type: "resize", cols, rows }
   - Server → Client: string (PTY output) or JSON { type: "pong", timestamp }
```

### Reused modules (unchanged)

- `auth/auth-service.ts` — token + password verification
- `tunnels/` — Cloudflare/DevTunnel providers
- `cloudflared/` — cloudflared process management
- `util/file-logger.ts`, `util/random.ts`, `launch-context.ts`
- `useTerminalRuntime.ts` — xterm.js initialization, fit, themes, write buffer
- `terminal-write-buffer.ts` — frame-budgeted rendering
- `Toolbar.tsx` — mobile modifier keys
- `ComposeBar.tsx` — text composition
- `PasswordOverlay.tsx` — auth gate
- `app.css` — full theme system
- `reconnect-policy.ts`, `websocket-keepalive.ts`

### Verified scenarios

- [x] Zellij TUI renders correctly in xterm.js (title bar, tabs, panes, status bar)
- [x] Keyboard input flows to Zellij
- [x] Terminal resize follows browser window
- [x] Password authentication works
- [x] Cloudflare tunnel access works (remux-dev.yaoshen.wang)
- [x] Session persists across page refresh (`zellij attach --create`)
- [x] Typecheck passes (both backend and frontend)

### How to run

```bash
# Development (Vite dev server + backend)
npm run dev:zellij

# Production (built frontend + tunnel)
npm run build:frontend
REMUX_TOKEN=<token> npx tsx src/backend/cli-zellij.ts --port 3457
```

## Phase 2 — Mobile Enhancement (TODO)

Goal: make Zellij usable from a phone without a physical keyboard.

### Planned work

- **Zellij keybinding toolbar** — map toolbar buttons to Zellij operations:
  - New tab: send `Ctrl+T, N`
  - Next tab: send `Ctrl+T, Right`
  - New pane: send `Ctrl+P, D` (split down) / `Ctrl+P, R` (split right)
  - Close pane: send `Ctrl+P, X`
  - Toggle fullscreen: send `Ctrl+P, F`
- **Zellij layout presets** — offer common layouts (2-pane, 3-pane) via toolbar
- **Touch-friendly pane switching** — detect Zellij pane layout, overlay tap targets
- **Custom Zellij config** — ship a `config.kdl` optimized for web access
  (shorter keybinding prefixes, simplified status bar)

## Phase 3 — Zellij-Aware (OPTIONAL)

Goal: enhance the web UI with Zellij state awareness.

### Possible approaches

1. **Zellij plugin API (WASM)** — write a plugin that reports tab/pane state
   to the Node.js server via IPC
2. **Terminal output parsing** — detect Zellij's status bar rendering to infer
   active tab/pane
3. **Existing zellij-bridge** — the `native/zellij-bridge/` Rust crate already
   implements deep Zellij integration; could be adapted

### Possible features

- Web-native tab bar (above the terminal, not inside it)
- Per-pane inspect/history (server-side scrollback capture)
- Pane-level notifications (detect output activity)
- Custom web sidebar for session management

## Prerequisites

- **Zellij >= 0.41** — install via `brew install zellij` (macOS) or `cargo install zellij`
- **Node.js >= 20**
- **node-pty** — ensure `spawn-helper` has execute permission after `npm install`

## Design principles

1. **Zellij is the runtime** — don't reimplement what it already does
2. **Remux is the web portal** — auth, transport, mobile UI
3. **Iterate from simple** — Phase 1 is a raw web TTY; add intelligence later
4. **Session persistence is free** — `zellij attach --create` handles reconnection
5. **One WebSocket** — no separate control plane; JSON messages coexist with binary I/O
