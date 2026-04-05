# Remux Specification

## Overview

Remux is a ghostty-web-backed remote terminal workspace for terminal-first work. It helps users inspect, control, and intervene in shell sessions from another device without pretending the browser is a full desktop shell.

The current public product path is:

- Node.js CLI and web server
- direct shell / PTY tabs with optional detached daemon persistence
- ghostty-web in the browser for terminal rendering
- a single WebSocket channel that multiplexes structured control messages and terminal data

Legacy planning material is archived under [docs/archive/README.md](./archive/README.md).

## Product Shape

Remux exposes three product surfaces:

- `Inspect`: readable history and context for catch-up, copy, and diagnosis
- `Live`: a real terminal stream for interactive shell I/O
- `Control`: structured session, tab, and pane operations

The product is intentionally awareness-first. The current server owns runtime truth for sessions, tabs, devices, and persisted workspace state, and exposes that truth to browsers and adjacent clients.

## Current Architecture

### Backend

The backend is a Node.js service built around:

- `src/cli/remux-server.ts`: CLI bootstrap, HTTP routes, static asset serving, browser shell template, and startup orchestration
- `src/gateway/ws/websocket-server.ts`: `/ws` upgrade handling, auth gate, protocol envelope, terminal/control routing, buffering, and device flows
- `src/runtime/session-runtime.ts`: session/tab model, PTY lifecycle, detached daemon reattach, broadcast, and resize behavior
- `src/persistence/store.ts`: SQLite persistence for sessions, devices, push, search, workspace objects, and durable stream state
- `src/integrations/push/push-service.ts`: VAPID initialization, subscription persistence, and web-push delivery
- `src/domain/workspace/workspace-service.ts` and `src/domain/workspace/workspace-head.ts`: snapshots, handoff bundle, shared focus state, and workspace objects
- `src/integrations/macos/launchd-service.ts`: launchd service install/uninstall/status for macOS
- `src/integrations/adapters/`: generic shell, Claude Code, and Codex adapter hooks

### Frontend

The browser client is currently served inline by the Node.js gateway:

- `src/cli/remux-server.ts`: HTML template, browser runtime, sidebar, inspect/live/control interactions, and service worker payload
- `ghostty-web` package assets: browser-side terminal renderer and WASM runtime
- `/sw.js`: notification click handling and window focus behavior

## Session Model

- Sessions are named logical workspaces stored in `sessionMap` and persisted to SQLite.
- Each session owns one or more tabs backed by a direct PTY or a detached PTY daemon.
- Each browser client attaches to one tab at a time and reports its own terminal dimensions.
- Clients are tracked as `active` or `observer`; observers receive output but their input is dropped until they claim control.
- Durable stream state, snapshots, and reconnect cursors are stored in SQLite for resume flows.

## Transport Model

Remux currently uses a single WebSocket endpoint: `/ws`.

Responsibilities:

- auth handshake
- terminal output streaming
- terminal input and resize messages
- session, tab, device, push, and workspace commands
- resume, buffering, and durable stream catch-up
- inspect, snapshot, search, and handoff flows

Behavior:

- the first client message must authenticate with a token and optional device identity
- structured JSON messages use the v1 envelope `{ v: 1, type, payload }`
- legacy bare JSON messages are still accepted for backward compatibility
- server-sent structured messages are enveloped; raw terminal output may still be sent directly

Current command families include:

- session and tab actions such as `attach_first`, `attach_tab`, `new_tab`, `close_tab`, `new_session`, and `delete_session`
- control arbitration such as `request_control` and `release_control`
- device trust and pairing such as `list_devices`, `generate_pair_code`, `pair`, `trust_device`, and `revoke_device`
- push flows such as `get_vapid_key`, `subscribe_push`, `unsubscribe_push`, and `test_push`
- workspace flows such as `create_topic`, `list_runs`, `list_artifacts`, `resolve_approval`, `create_note`, `search`, and `get_handoff`

Current server message families include:

- auth and resume messages such as `auth_ok`, `auth_error`, and `resume_complete`
- state broadcasts such as `state`, `clients`, and tab output
- device and push messages such as `pair_code`, `pair_result`, and push status updates
- workspace messages such as notes, approvals, artifacts, search results, and adapter events

## HTTP API

Current HTTP routes include:

- `POST /auth`
  - exchanges a password for a temporary token when password auth is enabled
- `GET /`
  - serves the browser shell HTML
- `GET /dist/*`
  - serves `ghostty-web` browser assets
- `GET /ghostty-vt.wasm`
  - serves the Ghostty VT WASM asset
- `GET /sw.js`
  - serves the service worker used for notification interaction

## Inspect and History

Remux currently exposes inspect and history through the live WebSocket session plus server-side VT tracking:

- tabs maintain ring-buffer scrollback plus a Ghostty VT snapshot
- detached daemon tabs can be revived and resumed from persisted stream chunks and snapshots
- browser inspect mode periodically requests structured inspect content over `/ws`
- workspace snapshots and handoff bundles are derived from the persisted workspace state

## Security Constraints

The following constraints are deliberate and should be preserved:

- auth must remain enforced before a client can attach or mutate state
- shell and daemon launches must keep using argument arrays, not shell-string interpolation
- device trust, pair-code flows, and observer-mode input dropping must remain intact
- persisted workspace and push data must stay scoped to the configured instance database

## Non-Goals

Remux is not trying to be:

- a generic browser SSH client
- a full desktop shell running inside the browser
- a revival of archived runtime plans as a second public product path
