# Zellij Native Bridge Plan

> Status: Draft
> Date: 2026-03-26
> Scope: Replace the current zellij pane stream implementation with a native protocol bridge while preserving the existing Remux control and state paths in the first phase.

---

## 1. Background

The current Remux zellij integration is split across three layers:

- command/control through `ZellijCliExecutor`
- workspace state snapshots through CLI polling
- terminal output through `ZellijPaneIO`

This is workable for basic operations, but it is still shaped around tmux assumptions. The most fragile part is the terminal stream path: even after recent stabilization, it is still a viewport mirror and not a real pane-native stream.

Upstream zellij source shows that:

- each terminal pane has its own PTY internally
- zellij exposes a native client/server subscription path for pane render updates
- the public render subscription contract is closer to `viewport + scrollback events` than to a raw PTY export

This makes a native bridge the best medium-term path if Remux wants to keep its own UI while making zellij mode genuinely reliable.

---

## 2. Goals

1. Replace the current zellij terminal output path with a native bridge that subscribes to pane render updates directly.
2. Keep the existing Remux session, tab, and pane UI in the first implementation.
3. Minimize first-phase blast radius by preserving the current CLI control path.
4. Improve fidelity for live viewport updates and scrollback.
5. Establish a versioned, testable integration boundary instead of continuing to parse CLI stdout as a pseudo-stream.

## 3. Non-Goals

1. Do not rewrite the entire zellij backend in phase 1.
2. Do not replace all control commands with native protocol actions in phase 1.
3. Do not attempt to make zellij behave exactly like tmux.
4. Do not rely on postinstall-time Rust builds for npm users.

---

## 4. Decision

### 4.1 First-phase architecture

Keep:

- `src/backend/zellij/cli-executor.ts` for control actions and workspace snapshots
- existing server-side client view logic
- existing frontend protocol and xterm integration

Replace:

- `src/backend/zellij/pane-io.ts` as the main zellij terminal stream implementation

Introduce:

- a native `zellij-bridge` helper process
- a Node adapter that manages the bridge process and translates bridge events into `PtyProcess`-compatible output

### 4.2 Why this boundary

This gives the highest value per unit of risk:

- the worst current behavior is in pane streaming
- control commands already work well enough to keep initially
- state polling can stay in place while the stream layer is replaced
- the Remux UI does not need to be redesigned before the stream path becomes trustworthy

---

## 5. Proposed Architecture

```text
Remux frontend
  ↓
xterm.js
  ↓
WebSocket terminal channel
  ↓
ZellijNativePaneIO
  ↓
Node bridge adapter
  ↓
zellij-bridge process
  ↓
zellij client/server pane-render protocol
  ↓
zellij server
```

### 5.1 Rust bridge

Recommended location:

- `native/zellij-bridge/`

Responsibilities:

- connect to the target zellij session socket
- subscribe to one or more pane render streams
- emit structured events over stdout as NDJSON
- surface bridge health and protocol errors explicitly

Initial scope:

- read-only pane render subscription
- no input forwarding in phase 1

### 5.2 Node adapter

Recommended files:

- `src/backend/zellij/native-bridge.ts`
- `src/backend/zellij/native-pane-io.ts`

Responsibilities:

- spawn and supervise the bridge process
- parse bridge stdout events
- map render updates into the existing `PtyProcess` abstraction
- handle reconnect, crash, and unsupported-version fallback

### 5.3 Existing CLI path retained initially

Still handled by `ZellijCliExecutor`:

- create session
- kill session
- rename session
- new tab
- split pane
- focus pane
- fullscreen
- capture pane
- list tabs and panes

This keeps phase 1 limited to the stream layer.

---

## 6. Bridge Process Contract

### 6.1 Transport

- stdin: reserved for future commands
- stdout: NDJSON event stream
- stderr: diagnostics only
- exit code: non-zero on startup or runtime failure

### 6.2 Initial event model

Bridge should emit events similar to:

```json
{"type":"hello","version":"0.1.0","zellijVersion":"0.44.0"}
{"type":"pane_render","paneId":"terminal_0","viewport":["..."],"scrollback":["..."],"isInitial":true}
{"type":"pane_closed","paneId":"terminal_0"}
{"type":"error","message":"..."}
```

### 6.3 Cursor strategy

Known limitation:

- upstream `PaneRenderUpdateMsg` includes `viewport` and `scrollback`
- it does not include pane cursor coordinates

Phase 1 strategy:

- use native render subscription as the main data source
- keep a secondary low-frequency cursor source through `list-panes --json --all`
- query cursor only when needed for visible terminal fidelity

Phase 2 options:

- investigate whether upstream web client paths expose cursor data elsewhere
- propose or maintain a zellij-side enhancement if cursor remains the only missing field

### 6.4 Resize strategy

Phase 1:

- keep the current hidden attached client for resize semantics

Later:

- evaluate whether resize can move fully into the native bridge

---

## 7. Packaging and Distribution

Current npm packaging only ships:

- `dist`
- `docs`
- `README.md`
- `LICENSE`

The bridge must therefore be treated as a first-class runtime artifact.

### 7.1 Packaging decision

Do:

- build and ship precompiled bridge binaries
- copy them into `dist/backend/zellij/` during backend build
- include them in npm package output

Do not:

- require end users to have Rust or Cargo installed
- compile the bridge in `postinstall`

### 7.2 Platform support

First supported targets should match realistic zellij usage:

- macOS arm64
- macOS x64
- Linux x64
- Linux arm64 if release automation is practical

Unsupported platforms should fall back cleanly to the current CLI mode with a warning.

---

## 8. Implementation Phases

### Phase 0: Boundary and Version Gate

Deliverables:

- define minimum supported zellij version for the bridge path
- add explicit startup detection for bridge availability
- add a capability flag for native zellij stream mode

Exit criteria:

- unsupported environments are detected up front
- Remux can choose bridge mode or CLI fallback deterministically

### Phase 1: Bridge PoC

Deliverables:

- Rust crate at `native/zellij-bridge/`
- subscribe to a single pane render stream
- emit NDJSON `hello`, `pane_render`, `pane_closed`, and `error` events
- local manual verification against real zellij

Exit criteria:

- a pane receives continuous native render updates without relying on `zellij subscribe` CLI stdout parsing

### Phase 2: Replace `ZellijPaneIO`

Deliverables:

- `ZellijNativePaneIO`
- `ZellijPtyFactory` switch to native mode when available
- preserve current write path through `write` / `write-chars`
- keep current hidden attach client for resize

Exit criteria:

- browser typing, enter, backspace, and long-line wrapping work on the native stream path
- CLI polling is no longer the primary viewport source

### Phase 3: Cursor and Scrollback Refinement

Deliverables:

- supplemental cursor source integrated cleanly
- real zellij scrollback wired to Remux scroll UI
- remove xterm-local scrollback masquerading as zellij history

Exit criteria:

- scroll view represents backend truth instead of terminal-local serialization
- cursor drift is not reproducible in normal shell use

### Phase 4: Hardening and Product Integration

Deliverables:

- bridge crash recovery
- version compatibility checks
- health diagnostics in logs and startup output
- packaging updates in `package.json` and build scripts

Exit criteria:

- npm package contains required bridge artifacts
- runtime errors fail loudly and fall back safely

### Phase 5: Real Regression Coverage

Deliverables:

- backend tests for bridge event parsing and supervision
- real smoke tests for zellij native stream mode
- browser E2E coverage for actual zellij sessions

Required scenarios:

- command input and enter
- backspace
- wrapped long lines
- pane close
- external focus changes
- scrollback capture

Exit criteria:

- regressions in native zellij stream mode are caught without manual exploratory testing alone

---

## 9. File Plan

Likely new files:

- `native/zellij-bridge/Cargo.toml`
- `native/zellij-bridge/src/main.rs`
- `src/backend/zellij/native-bridge.ts`
- `src/backend/zellij/native-pane-io.ts`
- `tests/backend/zellij-native-bridge.test.ts`
- `tests/smoke/zellij-native-bridge.test.ts`

Likely updated files:

- `src/backend/zellij/index.ts`
- `src/backend/providers/detect.ts`
- `src/backend/zellij/pane-io.ts`
- `package.json`
- backend build scripts

---

## 10. Risks

### 10.1 Cursor data remains incomplete

The native render subscription does not currently expose cursor coordinates. If no better source exists, some cursor logic will remain hybrid.

Mitigation:

- keep cursor lookup separate and minimal
- avoid falling back to full viewport polling

### 10.2 zellij protocol compatibility drift

Internal or semi-internal client/server details may change between zellij versions.

Mitigation:

- gate supported zellij versions
- pin bridge implementation to known versions
- add real smoke coverage

### 10.3 Packaging complexity

Shipping a Rust helper through an npm package adds cross-platform release work.

Mitigation:

- keep the bridge tiny
- prebuild binaries in release automation
- preserve CLI fallback path

### 10.4 Double-maintenance period

For a time, Remux will support both native and CLI stream modes.

Mitigation:

- keep the boundary narrow
- route both implementations through the same `PtyFactory` interface

---

## 11. Success Criteria

This project is successful when:

1. zellij mode no longer depends on CLI polling as the primary terminal viewport source
2. browser terminal interaction feels stable in real shell usage
3. scrollback is sourced from backend truth rather than xterm-local history
4. unsupported zellij environments fail explicitly instead of degrading silently
5. the integration boundary is documented, versioned, and covered by real tests

---

## 12. Recommended Next Step

Start with **Phase 1: Bridge PoC**.

Do not begin with a broad backend refactor. The right first proof is narrower:

- subscribe to one pane
- stream native render updates
- verify browser behavior on a real zellij session

If that proof is solid, phase 2 can replace the current `ZellijPaneIO` path with confidence.
