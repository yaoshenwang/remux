# Remux Specification

## Overview

Remux is a remote workspace cockpit for terminal-first work. It helps users monitor, inspect, and control live terminal workspaces from another device without pretending the browser is a full desktop terminal.

The workspace model is multiplexer-neutral, with `tmux` as the flagship backend, explicit `zellij` caveats, and `conpty` as a practical Windows fallback.

Primary use cases:

- understand the current state of an ongoing terminal workspace from another device
- inspect readable history and catch up after reconnects or late joins
- intervene quickly through a live terminal when direct input is needed
- keep remote access session-aware instead of exposing a generic browser shell

Distribution model:

- npm package invoked as `npx remux`
- local HTTP server plus optional Cloudflare quick tunnel
- single-page frontend served by the backend

## Product Shape

The key design choice is that Remux is not just a streamed PTY. It combines:

- `Inspect`: readable history and context for catch-up, copy, and diagnosis
- `Live`: a real terminal stream for interactive shell I/O when intervention is needed
- `Control`: structured session, tab, and pane operations
- a mobile-oriented UI layer that makes navigation and lightweight intervention practical on touch devices

This lets the browser act as a remote workspace cockpit instead of pretending to be a full desktop terminal emulator.

## Current Architecture

### Backend

The backend is a Node.js service built around:

- Express for HTTP routes and static frontend serving
- `ws` for WebSocket transport
- a `MultiplexerBackend` abstraction for structured workspace operations
- a `PtyFactory` abstraction for attaching terminal I/O to the selected pane/session
- a polling state monitor that snapshots sessions, tabs, and panes and broadcasts diffs

Key entry points:

- `src/backend/cli.ts`: CLI bootstrap, auth setup, backend detection, tunnel startup
- `src/backend/server.ts`: HTTP routes, WebSocket lifecycle, auth gates, upload endpoint
- `src/backend/providers/detect.ts`: backend auto-detection and forced backend selection
- `src/backend/multiplexer/types.ts`: backend-neutral workspace contract

### Frontend

The frontend is a React app centered in `src/frontend/App.tsx` with:

- xterm.js for the Live terminal surface
- a drawer for Control-oriented workspace navigation
- a toolbar for modifier keys and mobile-friendly shortcuts
- a compose box for native keyboard input
- an inspect surface, currently backed by scrollback capture and terminal serialization, for readable copy and selection
- local preferences for theme, snippets, and view behavior

### Shared Model

The protocol now uses multiplexer-neutral naming:

- `SessionSummary`
- `SessionState`
- `TabState`
- `PaneState`
- `WorkspaceSnapshot`

Deprecated tmux-flavored aliases still exist in `src/shared/protocol.ts` for compatibility, but the active design vocabulary is `session/tab/pane`.

## Transport Model

Remux intentionally splits traffic into two channels.

### Control Plane

`/ws/control`

Responsibilities:

- authentication handshake
- session picker flow
- workspace state broadcasts
- structured operations such as create, rename, split, select, and close
- info and error messages

Payload format:

- JSON messages validated at runtime with `zod`

### Terminal Plane

`/ws/terminal`

Responsibilities:

- terminal output streaming
- raw keyboard input
- resize messages

Rationale:

- terminal traffic stays simple and high-throughput
- control messages remain typed and inspectable
- both channels can authenticate independently

## Backend Abstraction

The core backend contract is `MultiplexerBackend`.

Required capabilities:

- list, create, close, and rename sessions
- list, create, close, select, and rename tabs
- list panes and focus or split them
- close panes
- toggle fullscreen when supported
- capture scrollback

Each backend also declares `BackendCapabilities`, which the frontend uses to adapt the UI for:

- pane focus behavior
- precise or approximate inspect history backing
- floating panes
- fullscreen support
- session and tab rename support

## Supported Backends

### tmux

`tmux` is the flagship backend and the most mature path.

Characteristics:

- grouped sessions are used to isolate window focus per client where possible
- tmux CLI calls are executed through `execFile` argument arrays
- PTY attachment is handled through the node-pty adapter or `script(1)` fallback

### zellij

`zellij` support exists through a dedicated backend and PTY factory.

Important caveat:

- zellij semantics differ from tmux, so Remux cannot provide exact behavior or history fidelity parity
- some UI logic contains zellij-specific handling
- see `docs/ZELLIJ_MODE_AUDIT_2026-03-25.md` for current gaps and design pressure

### conpty

`conpty` is the fallback backend for Windows environments.

Characteristics:

- used when tmux and zellij are not available, or when forced explicitly
- capability surface is narrower than tmux

## Runtime Flow

### Startup

1. User runs `npx remux`
2. CLI parses flags and environment variables
3. Auth token is created, and password is generated unless disabled or supplied
4. Backend is auto-detected or forced
5. HTTP and WebSocket server start
6. Optional Cloudflare tunnel starts
7. CLI prints launch URLs and QR code

### Frontend Connection

1. Browser loads the app and fetches `/api/config`
2. Browser opens `/ws/control`
3. First control message must be auth with token and optional password
4. Server replies with `auth_ok` or `auth_error`
5. After attach completes, browser opens `/ws/terminal`
6. Terminal socket authenticates separately using token, password, and `clientId`

### Session Attach

The attach flow depends on the selected backend and available sessions:

- if no session exists, the backend creates the default one
- if one session exists, the server can attach directly
- if multiple sessions exist, the frontend shows a picker
- once attached, the terminal plane starts streaming

## UI Responsibilities

### Drawer

The drawer is the structured workspace navigator. It exposes:

- sessions
- tabs
- panes
- create, rename, and close actions
- split and fullscreen actions when supported
- backend switch controls
- theme and snippet management
- sticky zoom and focus-follow behavior

### Live View

Live is the direct intervention surface for shell I/O. It is optimized for immediacy, not for long-form reading.

It supports:

- xterm rendering
- resize propagation
- reconnect recovery
- drag-and-drop upload

### Inspect View

The current Inspect surface renders captured history as HTML instead of relying on native multiplexer copy mode.

Today it is still grounded in historical `scroll` naming in some APIs and UI labels, but the product semantics are moving toward `Inspect`.

Goals:

- readable long-form output on mobile
- native text selection
- configurable font size
- predictable copy behavior
- better catch-up than the visible terminal viewport alone

### Compose Input

Compose mode is meant for touch devices using native keyboard UX.

Behavior:

- user types into a native input
- `send_compose` sends text to the active terminal
- snippets can optionally auto-submit with Enter

## HTTP Endpoints

Current server endpoints include:

- `GET /api/config`
  - returns version, password requirement, scrollback defaults, upload limit, backend kind
- `POST /api/upload`
  - uploads a file into the active pane working directory after auth
- `POST /api/switch-backend`
  - switches between `tmux`, `zellij`, and `conpty` when supported and authenticated

The frontend bundle is served statically, and all non-API non-WS paths fall back to the app shell.

## State Synchronization

`TmuxStateMonitor` is still the historical name, but it now serves the generic backend model.

Behavior:

- snapshots the full workspace on an interval
- compares state over time
- broadcasts only when meaningful changes happen
- includes `clientView` so each frontend can maintain local focus state

This separation matters because the rendered terminal and the structured workspace snapshot can diverge temporarily during attach, reconnect, or backend-specific focus changes.

## Security-Relevant Constraints

The following are deliberate design constraints and should be preserved:

- control and terminal sockets authenticate independently
- structured backend commands must not be built through shell-string interpolation
- auth credentials are runtime values, not checked into config
- upload and backend-switch endpoints must remain authenticated

See `docs/SECURITY.md` for the threat model and operating guidance.

## Known Design Pressure

The current implementation still carries some transitional complexity:

- `src/frontend/App.tsx` is a large monolith and should eventually be split
- protocol types are shared logically but still maintained manually
- zod is used for inbound control messages, but validation is not yet universal across all boundaries
- zellij support is useful but not yet as coherent as the tmux path

## Non-Goals

Remux is not trying to be:

- a general-purpose web SSH client
- a hardened multi-tenant remote access broker
- a desktop replacement for full terminal workflows
- a feature-complete abstraction over every multiplexer concept
