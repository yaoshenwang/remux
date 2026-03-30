# Remux Specification

## Overview

Remux is a Zellij-backed remote workspace cockpit for terminal-first work. It helps users inspect, control, and intervene in a shared terminal workspace from another device without pretending the browser is a full desktop shell.

The current public product path is:

- Node.js CLI and web server
- Zellij as the session backend
- xterm.js in the browser for live terminal rendering
- separate control and terminal WebSocket channels

Legacy planning material is archived under [docs/archive/README.md](./archive/README.md).

## Product Shape

Remux exposes three product surfaces:

- `Inspect`: readable history and context for catch-up, copy, and diagnosis
- `Live`: a real terminal stream for interactive shell I/O
- `Control`: structured session, tab, and pane operations

The product is intentionally awareness-first. Zellij owns runtime truth; Remux makes that truth remotely accessible and easier to understand on mobile and secondary devices.

## Current Architecture

### Backend

The backend is a Node.js service built around:

- `src/backend/cli-zellij.ts`: CLI bootstrap, auth setup, tunnel startup, and Zellij-backed server startup
- `src/backend/server-zellij.ts`: HTTP routes, `/ws/control`, `/ws/terminal`, auth gates, upload handling, and extension APIs
- `src/backend/zellij-controller.ts`: Zellij JSON queries and structured tab/pane/session actions
- `src/backend/pty/zellij-pty.ts`: per-client attach PTY wrapper around Zellij
- `src/backend/extensions.ts`: optional terminal state tracking, notifications, bandwidth stats, file browsing, and Gastown enrichment

### Frontend

The frontend is a React app centered around:

- `src/frontend/App.tsx`: shell composition for Inspect, Live, Control, toolbar, and compose input
- `src/frontend/hooks/useZellijConnection.ts`: terminal WebSocket lifecycle and resize/input flow
- `src/frontend/hooks/useZellijControl.ts`: control WebSocket lifecycle, workspace state, inspect capture, and structured commands
- `src/frontend/hooks/useTerminalRuntime.ts`: xterm.js setup, fit behavior, buffering, and theme application

## Session Model

- The CLI targets one Zellij session, configured by `--zellij-session`
- The first terminal client boots or attaches that session through Zellij
- Each browser client gets its own attach PTY sized to that client's viewport
- Zellij remains the shared source of truth for session, tab, pane, and fullscreen state
- The browser control surface queries and mutates that shared state through `zellij action ...` commands

## Transport Model

Remux intentionally splits traffic into two channels.

### Terminal Plane

`/ws/terminal`

Responsibilities:

- terminal auth handshake
- raw terminal output streaming
- raw keyboard input
- resize messages
- ping/pong keepalive

Behavior:

- the first terminal message must be JSON auth
- after auth, terminal input is sent as raw bytes or text
- JSON messages are reserved for resize and ping/pong

### Control Plane

`/ws/control`

Responsibilities:

- control auth handshake
- workspace state subscription
- structured tab, pane, and session commands
- inspect capture requests
- bandwidth stats and keepalive

Current command set includes:

- `subscribe_workspace`
- `new_tab`
- `close_tab`
- `select_tab`
- `rename_tab`
- `new_pane`
- `close_pane`
- `toggle_fullscreen`
- `capture_inspect`
- `rename_session`

Current server messages include:

- `auth_ok`
- `auth_error`
- `workspace_state`
- `inspect_content`
- `bandwidth_stats`
- `error`
- `pong`

## HTTP API

Current HTTP routes include:

- `GET /api/config`
  - returns `passwordRequired` and server version
- `POST /api/upload`
  - accepts authenticated image uploads and stores them in the temporary upload directory

When extensions are enabled, the server also exposes:

- `GET /api/state/:session`
- `GET /api/inspect/:session`
- `GET /api/scrollback/:session`
- `GET /api/gastown/:session`
- `GET /api/stats/bandwidth`
- `GET /api/files`
- `GET /api/files/*filePath`

## Inspect and History

Remux currently exposes inspect data through two paths:

- `capture_inspect` on the control socket, which uses `zellij action dump-screen --ansi`
- extension-backed state tracking and inspect history APIs, which keep server-side terminal snapshots and derived history backed by the terminal buffer's technical scrollback state

The inspect history HTTP API is:

- `GET /api/inspect/:session`
  - returns `{ from, count, lines }`
  - reads inspect history lines from the extension-backed terminal state tracker
- `GET /api/scrollback/:session`
  - legacy compatibility route
  - responds with `301` redirect to the matching `/api/inspect/:session` URL and preserves `from` and `count` query params

This lets the browser show a readable Inspect view while keeping Live tied to the raw terminal stream.

## Security Constraints

The following constraints are deliberate and should be preserved:

- control and terminal sockets authenticate independently
- Zellij and shell-adjacent commands must use argument arrays, not shell-string interpolation
- session names in PTY paths must stay safely escaped
- uploads and file-browsing APIs must remain authenticated

## Non-Goals

Remux is not trying to be:

- a replacement for Zellij
- a generic browser SSH client
- a revival of archived runtime plans as a second public product path
