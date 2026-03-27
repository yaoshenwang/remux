# Remux Specification

## Overview

Remux is a remote workspace cockpit for terminal-first work. It helps users monitor, inspect, and control live terminal workspaces from another device without pretending the browser is a full desktop terminal.

The active product contract is the unified `runtime-v2` backend. Legacy `tmux` / `zellij` / `conpty` code remains only as a shrinking compatibility boundary and is not part of the default release path.

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
- a runtime-v2 gateway that proxies workspace state, inspect snapshots, and terminal streams
- a translation layer that maps runtime-v2 data into the browser-facing workspace model
- optional compatibility adapters kept outside the default contract

Key entry points:

- `src/backend/cli.ts`: CLI bootstrap, auth setup, runtime-v2 startup, tunnel startup
- `src/backend/server-v2.ts`: runtime-v2 gateway HTTP routes, WebSocket lifecycle, auth gates, upload endpoint
- `src/backend/v2/translation.ts`: runtime-v2 to browser model translation
- `src/backend/v2/types.ts`: runtime-v2 protocol-facing workspace contract

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

## Runtime Contract

The active backend contract is `runtime-v2`.

Required behavior:

- publish workspace summaries for sessions, tabs, panes, and layout
- expose inspect snapshots with explicit scope and precision
- stream terminal output through a dedicated terminal channel
- accept structured control mutations such as create, rename, split, select, and close
- report capability support explicitly instead of relying on implicit backend assumptions

The frontend still consumes translated `BackendCapabilities`, which it uses to adapt the UI for:

- pane focus behavior
- precise or approximate inspect history backing
- floating panes
- fullscreen support
- session and tab rename support

## Compatibility Boundary

The old `tmux` / `zellij` / `conpty` adapters remain in the repository only as migration-era compatibility code.

They are intentionally outside the default contract:

- hidden from the normal CLI help
- excluded from the default CI matrix
- excluded from the default `npm test` and default Playwright path
- retained only for debugging, migration, and staged removal work

See `docs/LEGACY_COMPAT.md` for the remaining escape hatches.

## Runtime Flow

### Startup

1. User runs `npx remux`
2. CLI parses flags and environment variables
3. Auth token is created, and password is generated unless disabled or supplied
4. The runtime-v2 gateway starts and connects to `remuxd`
5. HTTP and WebSocket server start
6. Optional Cloudflare tunnel starts
7. CLI prints launch URLs and QR code

Compatibility note:

- if runtime-v2 is explicitly disabled or fails to start, Remux can still fall back to the old adapters during migration work

### Frontend Connection

1. Browser loads the app and fetches `/api/config`
2. Browser opens `/ws/control`
3. First control message must be auth with token and optional password
4. Server replies with `auth_ok` or `auth_error`
5. After attach completes, browser opens `/ws/terminal`
6. Terminal socket authenticates separately using token, password, and `clientId`

### Session Attach

The attach flow depends on runtime-v2 workspace state:

- if no session exists, the gateway creates or requests the default one
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
- theme and snippet management
- sticky zoom and view behavior controls

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
  - returns version, password requirement, scrollback defaults, upload limit, and runtime mode metadata
- `POST /api/upload`
  - uploads a file into the active pane working directory after auth
- `POST /api/switch-backend`
  - returns `501` under runtime-v2 and exists only as a compatibility stub

The frontend bundle is served statically, and all non-API non-WS paths fall back to the app shell.

## State Synchronization

The primary state path is a runtime-v2 workspace subscription translated into the browser-facing snapshot model.

Behavior:

- the gateway subscribes to workspace summaries from the upstream runtime
- runtime-v2 terminal and inspect state are translated into browser-facing payloads
- only meaningful workspace changes are rebroadcast
- `clientView` remains separate so each frontend can preserve its local selection state

This separation matters because the rendered terminal and the structured workspace snapshot can diverge temporarily during attach, reconnect, or terminal retargeting.

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
- legacy compatibility code still adds complexity that should continue shrinking

## Non-Goals

Remux is not trying to be:

- a general-purpose web SSH client
- a hardened multi-tenant remote access broker
- a desktop replacement for full terminal workflows
- a feature-complete abstraction over every multiplexer concept
