# Zellij-First Refactor Design Document

> Status: Draft
> Date: 2025-03-24
> Scope: Full architecture refactor — domain model, protocol, server, terminal stream, frontend

---

## 1. Problem Statement

Remux was built as a tmux remote client, then grew zellij support by implementing the same `SessionGateway` interface. This created a series of fundamental mismatches:

- **Grouped session model doesn't exist in zellij** — `createGroupedSession()` and `switchClient()` are no-ops, per-client view isolation is faked via `VirtualView` in `server.ts`
- **Window ≠ Tab** — zellij tabs have IDs, tmux windows have indices; the protocol speaks tmux (`kill_window`, `select_window`, `windowIndex`)
- **Terminal stream is a viewport snapshot, not a PTY stream** — `ZellijPaneIO` subscribes to `pane_update` events and reconstructs terminal bytes from viewport diffs, losing scrollback history semantics
- **State index drifts** — `paneSessionMap` in `ZellijCliExecutor` is populated by `listPanes()` during polling but never updated on rename/kill/split, causing stale references
- **Cursor position requires per-frame CLI polling** — `queryCursorPosition()` runs `list-panes --json --all` on every `pane_update`, adding sustained overhead
- **Reflow logic is inherently fragile** — `visibleLength()` doesn't handle CJK/emoji/combining chars; `prevViewport` is already reflowed when used for cursor remapping, causing double-counting
- **`capturePane()` ignores the `lines` parameter** — protocol promises tmux semantics, backend doesn't deliver
- **No real zellij integration tests** — only parser and fake-gateway server tests pass; the actual CLI→subscribe→render chain is untested

These aren't bugs to fix incrementally. They're symptoms of a tmux-first architecture that can't cleanly support zellij.

---

## 2. Design Principles

1. **Zellij is the primary backend.** tmux and conpty become compatibility adapters.
2. **The domain model is multiplexer-neutral.** No tmux or zellij terminology in shared types.
3. **Backend state and client view are explicitly separated.** The protocol tells the frontend what's real vs. what's per-client.
4. **Capabilities are declared, not assumed.** Each backend advertises what it can do; frontend adapts.
5. **Terminal streaming is an isolated layer.** It doesn't know about sessions/tabs/panes structure.

---

## 3. New Domain Model

### Naming Migration

| Current (tmux) | New (neutral) | Notes |
|---|---|---|
| `SessionGateway` | `MultiplexerBackend` | Central backend interface |
| `StateSnapshot` | `WorkspaceSnapshot` | Top-level state |
| `SessionState` | `SessionState` | Keep — sessions are universal |
| `SessionSummary` | `SessionSummary` | Keep |
| `WindowState` | `TabState` | tmux "window" = zellij "tab" |
| `PaneState` | `PaneState` | Keep |
| `tmux_state` (message) | `workspace_state` | Protocol message type |
| `attachedSession` | `selectedSession` | Per-client, not per-backend |
| `kill_window` | `close_tab` | Protocol message type |
| `rename_window` | `rename_tab` | Protocol message type |
| `select_window` | `select_tab` | Protocol message type |
| `new_window` | `new_tab` | Protocol message type |
| `windowIndex` | `tabIndex` | Field name |
| `windowStates` | `tabs` | Field name |
| `VirtualView` | `ClientView` | Promoted to first-class module |

### Core Types

```typescript
// src/shared/types.ts — the single source of truth

export interface SessionSummary {
  name: string;
  attached: boolean;  // at least one real client attached
  tabCount: number;
}

export interface TabState {
  index: number;
  id?: string;           // zellij tab ID (opaque); undefined for tmux
  name: string;
  active: boolean;       // backend's real active state
  paneCount: number;
  panes: PaneState[];
}

export interface PaneState {
  index: number;
  id: string;            // "terminal_0" (zellij) or "%0" (tmux)
  currentCommand: string;
  currentPath: string;
  active: boolean;       // backend's real active state
  width: number;
  height: number;
  zoomed: boolean;
  isPlugin?: boolean;    // zellij only — plugin panes can be filtered
  isFloating?: boolean;  // zellij only
}

export interface SessionState extends SessionSummary {
  tabs: TabState[];
}

export interface WorkspaceSnapshot {
  sessions: SessionState[];
  capturedAt: string;
}

export interface ClientView {
  sessionName: string;
  tabIndex: number;
  paneId: string;
  followBackendFocus: boolean;  // configurable: does viewing follow real focus?
}
```

---

## 4. New Backend Interface

Replace `SessionGateway` with a capabilities-aware `MultiplexerBackend`:

```typescript
// src/backend/multiplexer/types.ts

export interface BackendCapabilities {
  supportsPaneFocusById: boolean;
  supportsTabRename: boolean;
  supportsSessionRename: boolean;
  supportsPreciseScrollback: boolean;
  supportsFloatingPanes: boolean;
  supportsFullscreenPane: boolean;
  supportsPaneResize: boolean;    // can CLI set pane dimensions?
  supportsTabId: boolean;         // tabs have stable IDs vs. just indices
}

export interface MultiplexerBackend {
  readonly kind: "tmux" | "zellij" | "conpty";
  readonly capabilities: BackendCapabilities;

  // ── Session ──
  listSessions(): Promise<SessionSummary[]>;
  createSession(name: string): Promise<void>;
  killSession(name: string): Promise<void>;
  renameSession(name: string, newName: string): Promise<void>;

  // ── Tab ──
  listTabs(session: string): Promise<Omit<TabState, "panes">[]>;
  newTab(session: string): Promise<void>;
  closeTab(session: string, tabIndex: number): Promise<void>;
  selectTab(session: string, tabIndex: number): Promise<void>;
  renameTab(session: string, tabIndex: number, newName: string): Promise<void>;

  // ── Pane ──
  listPanes(session: string, tabIndex: number): Promise<PaneState[]>;
  splitPane(paneId: string, direction: "right" | "down"): Promise<void>;
  closePane(paneId: string): Promise<void>;
  focusPane(paneId: string): Promise<void>;
  toggleFullscreen(paneId: string): Promise<void>;
  isPaneFullscreen(paneId: string): Promise<boolean>;

  // ── Scrollback ──
  capturePane(paneId: string, options?: { lines?: number }): Promise<{
    text: string;
    paneWidth: number;
    isApproximate: boolean;  // true for zellij (dump-screen != precise history)
  }>;

  // ── tmux-specific (optional, guarded by capabilities) ──
  createGroupedSession?(name: string, target: string): Promise<void>;
  switchClient?(session: string): Promise<void>;
}
```

### Backend Adapters

Each backend implements `MultiplexerBackend` with honest capabilities:

```
src/backend/multiplexer/
  types.ts              — MultiplexerBackend, BackendCapabilities
  zellij-adapter.ts     — ZellijBackend (primary)
  tmux-adapter.ts       — TmuxBackend (compat)
  conpty-adapter.ts     — ConPtyBackend (compat)
  detect.ts             — auto-detect + factory
  snapshot.ts           — buildSnapshot() using MultiplexerBackend
```

**ZellijBackend** no longer pretends to have grouped sessions. It maintains an authoritative `PaneIndex`:

```typescript
// Internal to ZellijBackend
class PaneIndex {
  private sessionMap = new Map<string, string>();   // paneId → session
  private tabMap = new Map<string, number>();        // paneId → tabIndex

  update(session: string, tabIndex: number, panes: PaneState[]): void { ... }
  getSession(paneId: string): string | undefined { ... }
  getTab(paneId: string): number | undefined { ... }
  removePane(paneId: string): void { ... }
  renameSession(oldName: string, newName: string): void { ... }
}
```

This `PaneIndex` is updated atomically on every state poll and on every mutation that changes structure (split, close, rename). It replaces the current `paneSessionMap` cache that drifts.

---

## 5. Client View Store

Promote the current `VirtualView` hack into a first-class server-side module:

```typescript
// src/backend/view/client-view-store.ts

export interface ClientViewState {
  clientId: string;
  sessionName: string;
  tabIndex: number;
  paneId: string;
  followBackendFocus: boolean;
}

export class ClientViewStore {
  private views = new Map<string, ClientViewState>();

  /** Initialize view for a new client. */
  initView(clientId: string, session: string, snapshot: WorkspaceSnapshot): ClientViewState { ... }

  /** Client explicitly selects a tab. */
  selectTab(clientId: string, tabIndex: number, snapshot: WorkspaceSnapshot): void { ... }

  /** Client explicitly selects a pane. */
  selectPane(clientId: string, paneId: string): void { ... }

  /** After backend state changes, repair views that reference dead tabs/panes. */
  reconcile(snapshot: WorkspaceSnapshot): void { ... }

  /** After session rename, update all views pointing to old name. */
  renameSession(oldName: string, newName: string): void { ... }

  getView(clientId: string): ClientViewState | undefined { ... }

  removeClient(clientId: string): void { ... }
}
```

Key behaviors:
- `reconcile()` runs after every state poll. If a client's viewed pane was killed, it falls back to the active pane of the same tab; if the tab was killed, falls back to the active tab.
- `selectTab()` / `selectPane()` only update the client's view. They do NOT call `backend.focusPane()` unless `followBackendFocus` is true.
- For tmux backend, `ClientViewStore` still uses grouped sessions under the hood (the store delegates to `createGroupedSession` / `switchClient`).

---

## 6. Protocol v2

### Server → Client Messages

```typescript
export type ServerMessage =
  | { type: "auth_ok"; clientId: string; requiresPassword: boolean;
      capabilities: BackendCapabilities; backendKind: string }
  | { type: "auth_error"; reason: string }
  | { type: "session_picker"; sessions: SessionSummary[] }
  | { type: "workspace_state";
      workspace: WorkspaceSnapshot;       // real backend state
      clientView: ClientView;             // this client's view
    }
  | { type: "scrollback"; paneId: string; text: string;
      lines: number; paneWidth: number; isApproximate: boolean }
  | { type: "error"; message: string }
  | { type: "info"; message: string };
```

Key change: `workspace_state` now carries **both** the real backend state and this client's view as separate fields. Frontend can:
- Render sidebar from `workspace.sessions` (real structure)
- Highlight current tab/pane from `clientView`
- Optionally show backend's real focus as a secondary indicator

### Client → Server Messages

```typescript
export type ClientMessage =
  | { type: "auth"; token?: string; password?: string;
      clientId?: string; session?: string }
  | { type: "select_session"; session: string }
  | { type: "new_session"; name: string }
  | { type: "new_tab"; session: string }
  | { type: "select_tab"; session: string; tabIndex: number }
  | { type: "close_tab"; session: string; tabIndex: number }
  | { type: "rename_tab"; session: string; tabIndex: number; newName: string }
  | { type: "select_pane"; paneId: string }
  | { type: "split_pane"; paneId: string; direction: "right" | "down" }
  | { type: "close_pane"; paneId: string }
  | { type: "toggle_fullscreen"; paneId: string }
  | { type: "capture_scrollback"; paneId: string; lines?: number }
  | { type: "send_compose"; text: string }
  | { type: "rename_session"; session: string; newName: string }
  | { type: "set_follow_focus"; follow: boolean };
```

Changes:
- `kill_window` → `close_tab`, `select_window` → `select_tab`, etc.
- `stickyZoom` removed — replaced by `toggle_fullscreen` as an explicit action
- `set_follow_focus` — new message to toggle whether client view follows backend focus
- `split_pane.orientation "h"|"v"` → `direction "right"|"down"` (zellij native)

### Backward Compatibility

During migration, server accepts both old and new message types via a thin adapter layer. Frontend switches to v2 immediately. Old message types are removed after one release cycle.

---

## 7. Terminal Stream Layer

Fully separate from session/tab/pane structure:

```
src/backend/terminal/
  types.ts              — TerminalStream interface
  stream-manager.ts     — manages per-client stream lifecycle
  tmux-stream.ts        — node-pty based (existing, works well)
  zellij-stream.ts      — subscribe-based (rewritten)
  conpty-stream.ts      — direct PTY (existing)
```

### TerminalStream Interface

```typescript
export interface TerminalStream {
  /** Opaque target identifier (e.g. "session:paneId" for zellij). */
  readonly target: string;

  write(data: string): void;
  resize(cols: number, rows: number): void;
  onData(handler: (data: string) => void): void;
  onExit(handler: (code: number) => void): void;
  kill(): void;
}

export interface TerminalStreamFactory {
  create(target: string): TerminalStream;
}
```

### ZellijStream Rewrite (key changes)

1. **No server-side viewport reflow.** Send raw viewport lines to frontend. Let xterm.js handle display at its own column width. Remove `reflowViewport()`, `wrapAnsiLine()`, `visibleLength()`.

2. **Cursor from subscribe event, not polling.** If zellij's subscribe JSON includes cursor coordinates (check latest zellij version), use them directly. If not available, query cursor only on initial attach and on explicit user interaction (not on every pane_update). Cache last known position.

3. **Acknowledge viewport semantics.** The stream explicitly declares it's a viewport viewer, not a full PTY. Frontend can display a subtle indicator ("viewport mode") and disable features that require full scrollback.

4. **Input batching remains** (current `writeBuf` approach is sound), but add metrics logging for latency tracking.

5. **Scrollback = dump-screen.** Don't pretend it's precise history. Mark `isApproximate: true` in scrollback responses. Frontend renders accordingly (e.g. "approximate scrollback" label).

### StreamManager

```typescript
// Manages per-client terminal stream lifecycle
class StreamManager {
  private streams = new Map<string, TerminalStream>();

  /**
   * Switch a client to viewing a different pane.
   * Kills old stream, creates new one, wires up data handlers.
   */
  switchPane(clientId: string, target: string, factory: TerminalStreamFactory,
             onData: (data: string) => void): void { ... }

  /** Clean up on client disconnect. */
  removeClient(clientId: string): void { ... }
}
```

This replaces the current pattern of `runtime.attachToSession()` embedded in control message handlers.

---

## 8. Server Decomposition

Current `server.ts` is ~1030 lines mixing HTTP routes, WebSocket handlers, state management, and backend-specific branching. Decompose into:

```
src/backend/
  server.ts             — thin shell: HTTP setup, WS upgrade routing, startup/shutdown
  handlers/
    control-handler.ts  — control WS message dispatch
    terminal-handler.ts — terminal WS binary/resize dispatch
  view/
    client-view-store.ts
  multiplexer/
    ...
  terminal/
    ...
  state/
    state-monitor.ts    — poll + diff + broadcast (rename: WorkspaceMonitor)
  auth/
    auth-service.ts     — unchanged
```

### server.ts (after refactor, ~200 lines)

Responsibilities:
- Express app setup + static serving
- HTTP API routes (`/api/config`, `/api/upload`, `/api/switch-backend`)
- WebSocket upgrade routing
- Wiring dependencies
- `start()` / `stop()` lifecycle

All control message logic moves to `control-handler.ts`. All terminal data forwarding moves to `terminal-handler.ts`.

### control-handler.ts

```typescript
export class ControlHandler {
  constructor(
    private backend: MultiplexerBackend,
    private viewStore: ClientViewStore,
    private streamManager: StreamManager,
    private monitor: WorkspaceMonitor,
    private auth: AuthService,
    private logger: Logger
  ) {}

  handleMessage(context: ControlContext, message: ClientMessage): Promise<void> { ... }
  handleConnect(socket: WebSocket): ControlContext { ... }
  handleDisconnect(context: ControlContext): Promise<void> { ... }
}
```

No more `if (isZellij)` branches. The `MultiplexerBackend` interface + `ClientViewStore` handle the differences.

---

## 9. Frontend Changes

### UI Model

- Sidebar: Session → Tab → Pane hierarchy (not "window")
- Tab bar: shows tabs with real names
- Pane list: shows panes, marks "viewed" vs "backend focused" distinctly
- New toggle: "Follow backend focus" (defaults to off for zellij)
- Capability-gated UI:
  - Hide "Rename Tab" button if `!capabilities.supportsTabRename`
  - Show "approximate" badge on scrollback if `!capabilities.supportsPreciseScrollback`
  - Hide floating pane controls if `!capabilities.supportsFloatingPanes`

### Protocol Adapter

Frontend uses new message types. During migration, a thin compatibility layer maps old server messages to new types (if server hasn't been updated yet).

### State Management

Replace the monolithic App.tsx state with:

```
src/frontend/
  hooks/
    useWorkspaceState.ts    — workspace snapshot + client view
    useTerminalStream.ts    — terminal WS connection + xterm
    useAuth.ts              — auth flow
    useCapabilities.ts      — backend capabilities
  components/
    Sidebar.tsx             — session/tab/pane tree
    Terminal.tsx             — xterm.js wrapper
    Toolbar.tsx              — existing, updated
    ScrollbackViewer.tsx    — scrollback modal
    SessionPicker.tsx       — session selection
  App.tsx                   — composition root (~100 lines)
```

---

## 10. Testing Strategy

### Layer 1: Backend Adapter Unit Tests

```
tests/backend/zellij-adapter.test.ts
tests/backend/tmux-adapter.test.ts
```

- CLI argument construction for every operation
- Output parsing (existing parser tests stay)
- PaneIndex update/rename/remove
- Error paths (timeout, invalid JSON, missing pane)

### Layer 2: ClientViewStore Unit Tests

```
tests/backend/client-view-store.test.ts
```

- Init view from snapshot
- Select tab/pane updates view
- Reconcile after pane kill → falls back correctly
- Reconcile after tab kill → falls back correctly
- Rename session → all views updated
- Multi-client isolation

### Layer 3: Terminal Stream Tests

```
tests/backend/zellij-stream.test.ts
```

- Subscribe event → correct xterm bytes (without reflow)
- Pane switch → old stream killed, new stream started
- Write batching behavior
- pane_closed event → clean exit

### Layer 4: Integration Tests

```
tests/integration/workspace-server.test.ts
```

- Existing server integration tests, updated for new protocol
- Use `FakeMultiplexerBackend` (replaces `FakeTmuxGateway`)
- Test client view isolation with multiple concurrent clients

### Layer 5: Real Zellij Smoke Tests

```
tests/smoke/zellij-smoke.test.ts
```

- Requires `REAL_ZELLIJ_SMOKE=1` + zellij installed
- Create session, list tabs, list panes, focus pane, close pane
- Subscribe + verify output events arrive
- Full server round-trip: connect → auth → view pane → type → see output

---

## 11. Migration Plan

### Phase 1: Types + Protocol Rename (no behavior change)

**Goal:** Introduce neutral types, deprecate tmux names, keep runtime identical.

1. Create `src/shared/types.ts` with new type names
2. Re-export old names as `@deprecated` aliases from `src/shared/protocol.ts`
3. Add `workspace_state` as alias for `tmux_state` in server messages
4. Frontend accepts both `tmux_state` and `workspace_state`
5. Rename `windowStates` → `tabs` in types (with compat alias)
6. Update all imports gradually

**Validation:** All existing tests pass. No runtime behavior change.

### Phase 2: Extract ClientViewStore

**Goal:** Move virtual view logic out of server.ts into a tested module.

1. Create `ClientViewStore` with full test coverage
2. Replace `VirtualView` in server.ts with `ClientViewStore` calls
3. Add `reconcile()` to state monitor broadcast path
4. Remove `paneSessionMap` from `ZellijCliExecutor`, replace with `PaneIndex`

**Validation:** Existing integration tests pass. New unit tests for ClientViewStore.

### Phase 3: Extract MultiplexerBackend

**Goal:** Replace `SessionGateway` with capabilities-aware interface.

1. Create `MultiplexerBackend` interface
2. Wrap `ZellijCliExecutor` as `ZellijBackend` implementing new interface
3. Wrap `TmuxCliExecutor` as `TmuxBackend`
4. Remove `createGroupedSession()` / `switchClient()` from core interface
5. Move grouped session logic into TmuxBackend-specific code
6. Remove all `if (isZellij)` branches from server.ts

**Validation:** All tests pass. Server no longer has backend-specific branches.

### Phase 4: Rewrite Terminal Stream

**Goal:** Clean terminal stream abstraction, fix zellij output issues.

1. Create `TerminalStream` interface + `StreamManager`
2. Rewrite `ZellijPaneIO` as `ZellijStream` — no reflow, no cursor polling
3. Keep existing `TerminalRuntime` as `TmuxStream` wrapper
4. Wire `StreamManager` into control handler

**Validation:** New stream tests. Manual testing on real zellij.

### Phase 5: Protocol v2

**Goal:** Ship new protocol with separated workspace/clientView.

1. Server sends `workspace_state` with both `workspace` and `clientView` fields
2. Frontend switches to new protocol
3. Add `capabilities` to `auth_ok`
4. Frontend gates UI features on capabilities
5. Remove deprecated old message types after one release

**Validation:** E2E tests updated. Manual testing on both backends.

### Phase 6: Frontend Refactor

**Goal:** Break up App.tsx, implement zellij-native UI.

1. Extract hooks: `useWorkspaceState`, `useTerminalStream`, `useAuth`
2. Extract components: `Sidebar`, `Terminal`, `SessionPicker`
3. Update UI labels: "Tab" not "Window"
4. Add "Follow focus" toggle
5. Show capability-gated controls

**Validation:** E2E tests pass. Visual manual testing.

### Phase 7: Zellij Smoke Tests

**Goal:** Real zellij integration coverage.

1. Add `tests/smoke/zellij-smoke.test.ts`
2. CI conditional: skip if zellij not installed
3. Cover: session CRUD, tab/pane operations, subscribe output, full round-trip

---

## 12. Risk Assessment

| Risk | Mitigation |
|---|---|
| Large refactor breaks tmux support | Phase 3 explicitly wraps tmux as adapter; all existing tmux tests must keep passing |
| Zellij CLI interface changes between versions | Pin minimum zellij version; add version check to detect.ts |
| Protocol v2 breaks existing clients | Ship compat aliases in Phase 1; remove in Phase 5 only |
| Frontend refactor introduces regressions | E2E tests must pass at every phase boundary |
| Stream rewrite (Phase 4) is highest risk | Can be done independently; manual testing checkpoint required |

---

## 13. Out of Scope (for now)

- Floating pane UI
- Plugin pane filtering
- Tab/pane layout preview
- In-session search
- Multi-backend simultaneous connection
- Zellij plugin-based I/O (replacing CLI subscribe)

These can be built on top of the refactored architecture but are not part of this refactor.
