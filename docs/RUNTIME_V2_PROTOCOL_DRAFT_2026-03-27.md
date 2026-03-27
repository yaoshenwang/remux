# Remux Runtime V2 Protocol Draft

Date: 2026-03-27
Status: Draft for implementation
Audience: runtime and web client contributors

This document is the concrete protocol companion to `docs/RUNTIME_V2_MASTER_PLAN_2026-03-27.md`.

## 1. Transport

Remux Runtime V2 keeps two WebSocket channels plus a small HTTP metadata surface.

- `GET /v2/meta`
- `GET /v2/control`
- `GET /v2/terminal`

Rules:

- protocol version is explicit in every hello payload
- client view state is not treated as backend truth
- Remux ids are stable protocol ids
- domain names stay stable even when payload shapes expand

## 2. HTTP Surface

### 2.1 `GET /v2/meta`

Returns runtime metadata required before a client opens sockets.

Response shape:

```json
{
  "service": "remuxd",
  "protocolVersion": "2026-03-27-draft",
  "controlWebsocketPath": "/v2/control",
  "terminalWebsocketPath": "/v2/terminal",
  "publicBaseUrl": null
}
```

### 2.2 `GET /healthz`

Returns runtime liveness only. It is not a readiness contract for PTY recovery.

## 3. Control Channel

### 3.1 Lifecycle

1. Client connects to `/v2/control`.
2. Server sends `hello`.
3. Client sends `authenticate`.
4. Client subscribes to workspace and diagnostics domains.

### 3.2 Client Messages

- `authenticate`
- `subscribe_workspace`
- `request_diagnostics`
- `request_inspect`

Example:

```json
{
  "type": "authenticate",
  "token": "opaque-token",
  "capabilities": {
    "inspect": true,
    "compose": true,
    "upload": true,
    "readOnly": false
  }
}
```

### 3.3 Server Messages

- `hello`
- `workspace_snapshot`
- `diagnostics_snapshot`
- `inspect_snapshot`
- `command_rejected`

Example hello:

```json
{
  "type": "hello",
  "protocolVersion": "2026-03-27-draft",
  "writeLeaseModel": "single-active-writer"
}
```

## 4. Terminal Channel

### 4.1 Lifecycle

1. Client connects to `/v2/terminal`.
2. Client sends `attach` with `paneId`, mode, and requested geometry.
3. Server sends `hello`.
4. Server sends either `snapshot` or `stream` frames.

### 4.2 Client Messages

- `attach`
- `input`
- `resize`
- `request_snapshot`

### 4.3 Server Messages

- `hello`
- `snapshot`
- `stream`
- `resize_confirmed`
- `lease_state`
- `exit`

Example attach:

```json
{
  "type": "attach",
  "paneId": "pane_0123456789abcdef",
  "mode": "interactive",
  "size": {
    "cols": 160,
    "rows": 42
  }
}
```

## 5. Domain Guarantees

- `workspace_snapshot` reflects Remux runtime truth, not client UI selection
- `snapshot` frames are produced from Remux-owned terminal state
- `resize_confirmed` reports applied PTY geometry
- inspect payloads must include precision metadata

## 6. Non-Goals Of This Draft

- full replay payload design
- upload chunk protocol
- extension-specific semantic layers

Those will be added after the single-session single-pane runtime is operational.
