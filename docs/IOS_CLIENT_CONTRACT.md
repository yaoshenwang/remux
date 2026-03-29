# iOS Client Bootstrap Contract

Date: 2026-03-26
Status: Draft — based on protocol revision from Milestone 1

## Overview

This document defines the contract a native iOS client needs to implement against the Remux server. It covers: API endpoints, WebSocket protocol, authentication, workspace model, terminal embedding strategy, notification payloads, and pairing bootstrap.

Reference fixtures live in `tests/harness/nativeClientFixtures.ts`. The JSON examples below should stay aligned with those tested fixtures.

## Server Discovery

The iOS client connects to a Remux server via:

1. **QR code scan** — encodes `{ url, token }` as JSON in a QR code
2. **Manual entry** — user enters server URL and token

The server URL includes the cloudflared tunnel hostname (e.g. `https://<random>.trycloudflare.com`).

## API Endpoints

### GET /api/config

Returns server configuration. Call this first to determine auth requirements.

```json
{
  "version": "0.2.0",
  "passwordRequired": false,
  "inspectLines": 1000,
  "pollIntervalMs": 2500,
  "uploadMaxSize": 52428800,
  "backendKind": "runtime-v2",
  "runtimeMode": "runtime-v2"
}
```

### POST /api/upload

Upload a file to the server. The file is written to the CWD of the active pane.

- Max size: 50 MB
- Content-Type: `application/octet-stream`
- Auth: `Authorization: Bearer <token>` header + optional `X-Password` header
- Required header: `X-Filename: <filename>`
- Optional header: `X-Pane-Cwd: <pane cwd>`

**Upload response example:**

```json
{
  "ok": true,
  "path": "/Users/wangyaoshen/dev/remux/notes.txt",
  "filename": "notes.txt"
}
```

## WebSocket Protocol

### Control Socket: /ws/control

JSON-based control plane. Handles auth, session management, workspace state.

**Auth handshake:**

```
Client → { "type": "auth", "token": "<token>", "password": "<optional>" }
Server → { "type": "auth_ok", "clientId": "abc123", "requiresPassword": false,
           "capabilities": { ... }, "serverCapabilities": { ... }, "backendKind": "runtime-v2" }
```

**Auth success example:**

```json
{
  "type": "auth_ok",
  "clientId": "native-client-001",
  "requiresPassword": false,
  "backendKind": "runtime-v2",
  "capabilities": {
    "supportsPaneFocusById": true,
    "supportsTabRename": true,
    "supportsSessionRename": true,
    "supportsPreciseInspect": true,
    "supportsPreciseScrollback": true,
    "supportsFloatingPanes": false,
    "supportsFullscreenPane": true
  },
  "serverCapabilities": {
    "protocolVersion": 1,
    "workspace": {
      "supportsPaneFocusById": true,
      "supportsTabRename": true,
      "supportsSessionRename": true,
      "supportsPreciseInspect": true,
      "supportsPreciseScrollback": true,
      "supportsFloatingPanes": false,
      "supportsFullscreenPane": true,
      "supportsUpload": true,
      "supportsTerminalSnapshots": false
    },
    "notifications": {
      "supportsPushNotifications": false
    },
    "transport": {
      "supportsTrustedReconnect": false,
      "supportsPairingBootstrap": false,
      "supportsDeviceIdentity": false
    },
    "semantic": {
      "adaptersAvailable": [],
      "adapterHealth": [],
      "supportsEventStream": false
    }
  }
}
```

Or on failure:

```
Server → { "type": "auth_error", "reason": "invalid password" }
```

**Server capabilities (new in protocol v1):**

```json
{
  "protocolVersion": 1,
  "workspace": {
    "supportsPaneFocusById": true,
    "supportsTabRename": true,
    "supportsSessionRename": true,
    "supportsPreciseInspect": true,
    "supportsPreciseScrollback": true,
    "supportsFloatingPanes": false,
    "supportsFullscreenPane": true,
    "supportsUpload": true,
    "supportsTerminalSnapshots": false
  },
  "notifications": {
    "supportsPushNotifications": true
  },
  "transport": {
    "supportsTrustedReconnect": false,
    "supportsPairingBootstrap": false,
    "supportsDeviceIdentity": false
  },
  "semantic": {
    "adaptersAvailable": [],
    "adapterHealth": [],
    "supportsEventStream": false
  }
}
```

**Post-auth messages from server:**

| Type | Description |
|------|-------------|
| `attached` | `{ session: string }` — session attached |
| `session_picker` | `{ sessions: SessionSummary[] }` — choose a session |
| `workspace_state` | `{ workspace: WorkspaceSnapshot, clientView: ClientView }` — full state |
| `tab_history` | Tab history/scrollback response |
| `error` | `{ message: string }` |
| `info` | `{ message: string }` |

**Session picker example:**

```json
{
  "type": "session_picker",
  "sessions": [
    {
      "name": "main",
      "attached": false,
      "tabCount": 2
    },
    {
      "name": "ops",
      "attached": false,
      "tabCount": 1
    }
  ]
}
```

**Workspace state example:**

```json
{
  "type": "workspace_state",
  "viewRevision": 1,
  "workspace": {
    "capturedAt": "2026-03-26T13:00:00.000Z",
    "sessions": [
      {
        "name": "main",
        "attached": true,
        "tabCount": 1,
        "tabs": [
          {
            "index": 0,
            "name": "shell",
            "active": true,
            "paneCount": 1,
            "panes": [
              {
                "index": 0,
                "id": "%0",
                "currentCommand": "bash",
                "active": true,
                "width": 120,
                "height": 40,
                "zoomed": false,
                "currentPath": "/Users/wangyaoshen/dev/remux"
              }
            ]
          }
        ]
      }
    ]
  },
  "clientView": {
    "sessionName": "main",
    "tabIndex": 0,
    "paneId": "%0",
    "followBackendFocus": false
  }
}
```

**Tab history example:**

```json
{
  "type": "tab_history",
  "viewRevision": 1,
  "sessionName": "main",
  "tabIndex": 0,
  "tabName": "shell",
  "lines": 1000,
  "source": "server_tab_history",
  "precision": "precise",
  "capturedAt": "2026-03-26T13:00:02.000Z",
  "panes": [
    {
      "paneId": "%0",
      "paneIndex": 0,
      "title": "Pane 0 · bash · %0",
      "command": "bash",
      "text": "npm test\nAll green.\n",
      "paneWidth": 120,
      "isApproximate": false,
      "archived": false,
      "lines": 1000,
      "capturedAt": "2026-03-26T13:00:02.000Z"
    }
  ],
  "events": [
    {
      "id": "evt-1",
      "text": "Viewed tab 0",
      "createdAt": "2026-03-26T13:00:02.000Z"
    }
  ]
}
```

**Client commands:**

| Type | Payload |
|------|---------|
| `select_session` | `{ session: string }` |
| `new_session` | `{ name: string }` |
| `close_session` | `{ session: string }` |
| `new_tab` | `{ session: string }` |
| `select_tab` | `{ session, tabIndex }` |
| `close_tab` | `{ session, tabIndex }` |
| `select_pane` | `{ paneId: string }` |
| `split_pane` | `{ paneId, direction: "right" | "down" }` |
| `close_pane` | `{ paneId: string }` |
| `toggle_fullscreen` | `{ paneId: string }` |
| `capture_scrollback` | `{ paneId, lines? }` |
| `capture_tab_history` | `{ session?, tabIndex, lines? }` |
| `send_compose` | `{ text: string }` |
| `rename_session` | `{ session, newName }` |
| `rename_tab` | `{ session, tabIndex, newName }` |
| `set_follow_focus` | `{ follow: boolean }` |

### Terminal Socket: /ws/terminal

Binary data plane. Streams raw PTY I/O.

**Auth:** Same token+password as control socket, sent as JSON on connect.

```
Client → { "type": "auth", "token": "...", "password": "...", "clientId": "abc123" }
```

After auth, all subsequent messages are raw terminal data (UTF-8 strings).

**Resize:** Send a JSON message `{ "type": "resize", "cols": N, "rows": N }`.

## Workspace Data Model

```
WorkspaceSnapshot
├── sessions: SessionState[]
│   ├── name: string
│   ├── attached: boolean
│   ├── tabCount: number
│   └── tabs: TabState[]
│       ├── index: number
│       ├── name: string
│       ├── active: boolean
│       ├── paneCount: number
│       └── panes: PaneState[]
│           ├── index: number
│           ├── id: string
│           ├── currentCommand: string
│           ├── active: boolean
│           ├── width: number
│           ├── height: number
│           ├── zoomed: boolean
│           └── currentPath: string
└── capturedAt: string (ISO 8601)
```

## Terminal Embedding Strategy

For the iPhone MVP, use **WKWebView with xterm.js** for terminal rendering:

1. Bundle a minimal HTML page with xterm.js
2. Load it in WKWebView
3. Bridge terminal data via `WKScriptMessageHandler`
4. Forward resize events from native layout to xterm
5. Handle keyboard input natively, forward to terminal socket

This avoids the complexity of building a native terminal renderer while maintaining full compatibility with the server's terminal output.

## Session Lifecycle

1. Fetch `/api/config`
2. Open control WebSocket, authenticate
3. Receive `session_picker` or auto-`attached`
4. If `session_picker`: show session list, user selects, send `select_session`
5. Receive `attached` → open terminal WebSocket
6. Receive `workspace_state` updates at poll interval (~2.5s)

## Reconnect Strategy

- On WebSocket close: exponential backoff from 1s to 8s
- Re-authenticate on reconnect (same token + password)
- If previously attached to a session, resume automatically
- Terminal buffer is reset on reconnect (server sends fresh state)

## Notification Payload Contract

Push notification registration (future):

```
POST /api/push/subscribe
{
  "deviceId": "uuid",
  "platform": "ios",
  "pushToken": "apns-device-token",
  "events": ["bell", "exit", "completion"]
}
```

Notification payload format (for APNs):

```json
{
  "aps": {
    "alert": {
      "title": "Remux",
      "body": "Session 'main' — command completed"
    },
    "sound": "default"
  },
  "remux": {
    "sessionName": "main",
    "eventType": "exit",
    "exitCode": 0
  }
}
```

## Pairing Bootstrap Payload

QR code content (JSON):

```json
{
  "url": "https://abc123.trycloudflare.com",
  "token": "remux-auth-token-here",
  "version": 1
}
```

The iOS app scans this, stores the URL and token in Keychain, and initiates connection.

## Capability-Driven Rendering

The iOS client should render UI elements based on `serverCapabilities`:

- Show rename buttons only if `workspace.supportsTabRename` / `supportsSessionRename`
- Show upload button only if `workspace.supportsUpload`
- Attempt terminal snapshot restore only if `workspace.supportsTerminalSnapshots`
- Show fullscreen toggle only if `workspace.supportsFullscreenPane`
- Show notification settings only if `notifications.supportsPushNotifications`
- Show semantic timeline only if `semantic.adaptersAvailable.length > 0`

This keeps the client aligned with the unified `runtime-v2` backend without hardcoded transport assumptions.
