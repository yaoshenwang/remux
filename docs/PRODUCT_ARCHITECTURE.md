# Remux Product Architecture

> Status: Proposed
> Date: 2026-03-26
> Scope: Product definition, interaction model, history/inspect semantics, backend strategy, and phased architecture plan

Current direction note:

- `runtime-v2` is now the only product path

---

## 1. Executive Summary

Remux should be defined as a **remote workspace cockpit for terminal-first work**, not as a generic web SSH client and not as a thin browser wrapper around a terminal multiplexer.

Its core value is asymmetric access:

- from a phone, tablet, or second laptop, the user mostly wants to **observe**
- sometimes they need to **understand what happened**
- occasionally they need to **intervene quickly**

This leads to three first-class product surfaces:

1. **Live** — direct terminal interaction
2. **Inspect** — readable, selectable, searchable history and context
3. **Control** — structured session/tab/pane navigation and workspace operations

The current `scroll mode` should be redefined as the beginning of the **Inspect layer**, not as a terminal-side convenience feature.

The most important requirement for that layer is:

> Remux must be able to show the meaningful history of the current tab, not just the currently visible terminal viewport or this client's local xterm buffer.

That requirement changes both product semantics and technical design.

---

## 2. Problem Statement

Today, Remux already has strong ingredients:

- live terminal streaming
- structured session/tab/pane control
- mobile-oriented shortcuts and compose input
- reconnect behavior
- backend capability modeling
- emerging notification, event, and terminal-state infrastructure

But the product contract is still blurry in one critical area: **history and readability**.

The current scroll experience mixes several different concepts:

- local xterm buffer serialization
- backend scrollback capture
- readable mobile copy mode
- pane-level history
- tab-level context
- exact versus approximate history

This creates product confusion:

- users can believe they are reading authoritative history when they are not
- reconnects and late joins can show incomplete context
- backend differences leak through in surprising ways
- `scroll` sounds like a terminal affordance, while the real need is broader inspection

The result is not merely a bug-prone feature. It is an incomplete product model.

---

## 3. Product Thesis

### 3.1 What Remux Is

Remux is a **remote awareness and intervention layer for terminal workspaces**.

It exists to make terminal-first work manageable when the user is away from the primary machine, especially on devices where full desktop terminal ergonomics are poor.

Remux is valuable because it combines:

- a real terminal surface when direct input is needed
- a structured workspace model when navigation matters more than raw shell gestures
- a readable inspection surface when the user mainly wants to catch up, diagnose, or copy information

### 3.2 What Remux Is Not

Remux is not trying to be:

- a general-purpose browser SSH client
- a perfect multiplexer abstraction with behavior parity everywhere
- a desktop replacement for heavy terminal workflows
- a security broker for multi-tenant remote access

### 3.3 Core User Job

The dominant user job is:

> "Let me check on an ongoing terminal workspace from another device, understand its current state quickly, and make small but meaningful interventions without sitting at my desk."

This job is primarily about **awareness**, then **comprehension**, then **intervention**.

That ordering matters.

---

## 4. Design Principles

1. **Honesty over fake completeness**
   - If history is approximate, say so.
   - If a backend is in viewport mode, say so.
   - If a feature is local-cache-only, do not present it as authoritative.

2. **Inspect is not secondary**
   - On mobile, reading and catching up are often more important than typing.
   - The inspect experience is a core product differentiator.

3. **Backend truth and client view are different things**
   - The system must distinguish real backend state from what this client is currently viewing.

4. **Capabilities are declared, not implied**
   - The frontend must adapt based on backend capabilities.
   - Unsupported flows should be disabled, not softened into flaky behavior.

5. **History has scopes**
   - Pane history, tab history, and workspace timeline are distinct concepts.
   - They should not be collapsed into one ambiguous "scrollback."

6. **The product should reward intermittent use**
   - Fast catch-up matters more than maximal terminal fidelity in every path.

7. **Architecture should follow product semantics**
   - Do not force history, workspace state, and live terminal traffic through the same mental model.

---

## 5. Product Model

### 5.1 The Three Core Surfaces

#### Live

Purpose:

- direct terminal I/O
- quick fixes
- command entry
- interactive tools when needed

Characteristics:

- xterm.js-based rendering
- keyboard input, compose input, upload, shortcuts
- optimized for immediacy, not for long-form reading

#### Inspect

Purpose:

- catch up on what happened
- read output comfortably on small screens
- search, copy, share, and diagnose
- understand the state of the current work without entering raw terminal mode

Characteristics:

- HTML/text presentation optimized for readability
- supports authoritative history when available
- can remain useful even when live terminal attachment is unavailable or disconnected

#### Control

Purpose:

- navigate sessions, tabs, and panes
- create, rename, split, close, focus, zoom/fullscreen when supported
- surface runtime capability honestly instead of exposing backend switching as a primary UX

Characteristics:

- structured UI
- capability-driven affordances
- workspace-aware rather than terminal-only

### 5.2 Naming Change

The product should eventually stop using `Scroll` as the primary label.

Recommended naming:

- top-level surface: **Inspect**
- optional subviews:
  - **Tab History**
  - **Pane History**
  - **Timeline** (future)

`Scroll` may remain as an implementation-era alias temporarily, but it should not define the product semantics.

---

## 6. History and Inspect Semantics

This is the most important section for the product.

### 6.1 History Scopes

Remux should model three different history scopes.

#### Pane History

Definition:

- the historical output and context for a single pane

Use cases:

- copy exact command output from one pane
- inspect a specific long-running process
- reconcile output after reconnect

#### Tab History

Definition:

- the history relevant to the current tab, across its panes and tab-local events

This should become the **default inspect surface** for the current tab.

Why:

- a tab is the user's mental workspace unit more often than a single pane
- a user checking in remotely usually asks "what happened in this tab?" rather than "what is the current pane viewport?"

Tab history may include:

- pane output grouped or interleaved by pane
- pane lifecycle events (split, close, focus, fullscreen)
- tab rename or tab-level markers
- system annotations such as reconnects or capture boundaries

#### Workspace Timeline

Definition:

- a broader activity stream spanning sessions/tabs, plus future agent and notification events

This is a future direction, not the initial deliverable.

### 6.2 Authoritativeness Levels

Every inspect payload must explicitly carry its truth level.

Recommended levels:

- `precise`
  - backend-authored and semantically trustworthy for the requested scope
- `approximate`
  - useful, but not a perfect historical record
- `partial`
  - intentionally incomplete, such as local cache or truncated capture

The UI must show these clearly.

### 6.3 Source Types

Every inspect payload must also carry its source.

Recommended source values:

- `backend_capture`
- `live_pane_stream`
- `tab_aggregator`
- `local_cache`
- `viewport_reconstruction`

This keeps the product honest and helps debugging.

### 6.4 Required Inspect Contract

The inspect layer should follow these rules:

1. It must never silently present local client cache as authoritative history.
2. It must be able to show the current tab's meaningful history, not just the visible terminal rows.
3. It must support pane-level drilldown from the tab view.
4. It must survive reconnect better than the live terminal viewport alone.
5. It must remain readable on mobile without terminal-gesture literacy.

### 6.5 What "Current Tab Full History" Means

The product requirement should be defined carefully.

For Remux, "current tab full history" means:

- the user can inspect the output and relevant events for the currently selected tab
- this is not limited to the active pane's currently visible viewport
- this is not limited to what the current browser session happened to cache locally
- the result should include older content beyond the immediate screen

Short-term honest definition:

- "the best available tab-scoped history assembled from backend pane captures and live events"

Long-term target definition:

- "a timestamped tab activity history assembled continuously from pane output streams and control events"

Those are not the same, and the UI should distinguish them.

### 6.6 Recommended Inspect UX

Default inspect experience on mobile:

1. Open current tab history
2. Show capture/source/precision badges
3. Allow search, copy, and expand older history
4. Allow filtering to one pane
5. Allow jumping back to Live instantly

This is a better product than trying to imitate terminal copy-mode inside a browser.

---

## 7. Backend Strategy

### 7.1 Recommended Product Posture

Remux should keep a workspace-neutral domain model, but the shipped product contract should be the unified `runtime-v2` path.

Recommended posture:

- `runtime-v2` is the only default product path
- legacy adapters are compatibility-only and should keep shrinking
- release, docs, and CI should optimize for runtime-v2 correctness instead of backend parity theater

### 7.2 Why This Matters

The current architecture already shows that "one abstraction, same UX everywhere" is too optimistic.

Compatibility paths differ in:

- scrollback precision
- focus semantics
- grouped view behavior
- pane targeting behavior
- fullscreen semantics
- live stream fidelity

The product should embrace capability-aware behavior without letting old backends define the main narrative.

### 7.3 Backend-Specific Implications

#### runtime-v2

Target position:

- authoritative product contract
- strongest inspect and live-stream fidelity target
- the only path that should shape default UX, docs, and CI

#### legacy compatibility

Target position:

- explicit migration boundary
- hidden from the primary product surface
- tested only when compatibility work is being touched

---

## 8. Technical Architecture

### 8.1 High-Level Layers

Remux should be understood as four cooperating layers:

1. **Workspace Layer**
   - sessions, tabs, panes, capabilities, client view

2. **Live Terminal Layer**
   - interactive stream, resize, input, attach/reconnect

3. **Inspect Layer**
   - pane history, tab history, capture metadata, search/copy surfaces

4. **Awareness Layer**
   - notifications, bells, completion signals, future agent/workflow events

### 8.2 Truth Model

The system should explicitly separate:

- **backend truth**
  - real session/tab/pane state from the multiplexer or backend
- **client view**
  - what this specific client is currently viewing or following
- **derived inspect state**
  - captured or assembled history presented for understanding

This distinction is essential for correctness and for user trust.

### 8.3 Proposed Server Modules

Recommended long-term modules:

- `WorkspaceService`
  - current backend truth, capabilities, snapshots
- `ClientViewService`
  - per-client selection and follow behavior
- `LiveTerminalService`
  - PTY attach lifecycle and data plane
- `HistoryService`
  - pane capture, tab aggregation, pagination, metadata
- `AwarenessService`
  - notifications, bell/session events, future external event feeds

### 8.4 Proposed History Service

The inspect layer needs an explicit server-side history module.

Responsibilities:

- capture pane history from backend-specific sources
- assemble tab-scoped history from pane histories plus control events
- mark results as precise/approximate/partial
- support incremental loading and pagination
- provide metadata for UI honesty

Suggested conceptual interfaces:

```ts
interface HistoryDescriptor {
  scope: "pane" | "tab" | "workspace";
  source:
    | "backend_capture"
    | "live_pane_stream"
    | "tab_aggregator"
    | "local_cache"
    | "viewport_reconstruction";
  precision: "precise" | "approximate" | "partial";
  capturedAt: string;
  sessionName: string;
  tabIndex?: number;
  paneId?: string;
}

interface HistoryChunk {
  id: string;
  timestamp?: string;
  paneId?: string;
  kind: "output" | "event" | "marker";
  text: string;
}

interface HistorySnapshot {
  descriptor: HistoryDescriptor;
  chunks: HistoryChunk[];
  truncated: boolean;
  nextCursor?: string;
}
```

### 8.5 Tab History Assembly

To support the product requirement around current-tab history, the backend should eventually support two levels of tab history.

#### Level 1: Snapshot Assembly

Short-term implementation:

- capture each pane in the current tab
- assemble them into a tab-scoped inspect view
- include pane labels and capture timestamps
- mark the result as precise only if the backend can justify that claim

Benefits:

- far better than viewport-only scroll mode
- achievable without a full event-sourced architecture

Limitation:

- historical ordering across panes may be approximate

#### Level 2: Continuous Tab Timeline

Long-term implementation:

- continuously record pane output and control events with timestamps
- maintain tab-level activity history as an append-only stream

Benefits:

- true tab-level catch-up
- better diagnostics
- better notification deep-linking
- foundation for future agent/workflow timeline features

Limitation:

- more backend-specific work
- stronger storage and lifecycle design needed

### 8.6 Transport Model

Current split:

- `/ws/control`
- `/ws/terminal`

Recommended evolution:

- keep live terminal traffic separate from inspect/history traffic
- do not overload the terminal channel with history semantics

Practical path:

- short term: request history via control messages or authenticated HTTP endpoints
- medium term: add a dedicated history route or stream if inspect becomes paginated and live-updating

### 8.7 Frontend Architecture

The frontend should be reorganized around product surfaces, not around one monolithic component.

Recommended long-term structure:

- `connection/`
  - auth, attach state machine, reconnect
- `workspace/`
  - sessions, tabs, panes, client view, capabilities
- `live/`
  - xterm runtime, toolbar, compose, upload
- `inspect/`
  - tab history, pane history, search, copy, filters, metadata badges
- `awareness/`
  - status, notifications, future event timeline

The current `App.tsx` should become an orchestrator, not the place where product semantics live.

---

## 9. Interaction Model

### 9.1 Primary Mobile Flow

The expected mobile flow should be:

1. Open Remux
2. Understand current workspace quickly
3. Enter Inspect by default or with one tap
4. Read current tab history
5. Search or filter if needed
6. Jump into Live only when intervention is necessary
7. Use Control for structural operations

This flow matches real intermittent usage far better than a terminal-first default for every situation.

### 9.2 Surface Transitions

Recommended transitions:

- `Control -> Inspect`
  - user selects tab/pane and immediately sees relevant history
- `Inspect -> Live`
  - user found the issue and now needs to act
- `Live -> Inspect`
  - user wants to catch up, copy, or search without terminal friction

### 9.3 Inspect Subviews

Recommended inspect navigation:

- default: current tab history
- secondary: active pane history
- future: workspace timeline

### 9.4 Offline and Reconnect Semantics

Inspect should degrade better than Live.

If live terminal connectivity is interrupted:

- the UI should still preserve the last inspect snapshot
- it should label staleness clearly
- it should refetch authoritative history when possible

---

## 10. Capability Model

The capability model should be extended from operation support into product-fidelity support.

Current capability examples are already useful:

- pane focus support
- precise scrollback support
- floating pane support
- fullscreen support

Recommended additions:

- `supportsTabHistory`
- `supportsPreciseTabHistory`
- `supportsPaneHistoryStreaming`
- `supportsViewportModeOnly`
- `supportsFocusPlugin`

This allows the UI to explain why a surface behaves differently on different backends.

---

## 11. Product Roadmap

### Phase 0: Contract Cleanup

Goal:

- define the product honestly before adding more features

Deliverables:

- rename `Scroll` toward `Inspect` or `History`
- add explicit source and precision labels
- stop presenting local buffer serialization as authoritative history
- document flagship versus experimental backend posture

### Phase 1: Inspect Baseline

Goal:

- make inspect genuinely useful and trustworthy

Deliverables:

- wire backend-backed pane history into the frontend
- fetch history on attach, pane switch, tab switch, and reconnect
- preserve local cache only as convenience or preview
- add readable metadata: captured time, source, precision, scope

### Phase 2: Tab History

Goal:

- satisfy the real mobile catch-up use case

Deliverables:

- assemble current-tab history from pane captures
- support pane filtering inside tab history
- add pagination / load older content
- add search inside inspect

### Phase 3: Architecture Split

Goal:

- align code structure with product structure

Deliverables:

- split frontend by surface and state domain
- add explicit `HistoryService`
- formalize shared schema definitions
- refine backend truth vs client view separation

### Phase 4: High-Fidelity Backends

Goal:

- improve correctness where strategically justified

Deliverables:

- harden runtime-v2 inspect and live-stream fidelity
- keep reducing the legacy compatibility boundary
- add smoke tests around runtime-v2 history semantics, not only control operations

### Phase 5: Awareness Layer

Goal:

- evolve from remote terminal viewing into remote workspace understanding

Deliverables:

- bell/completion notifications linked to inspect context
- future agent/workflow event timeline
- deep links from notification to relevant tab history segment

---

## 12. Success Metrics

The product should be measured by understanding and recovery, not just terminal rendering.

Recommended metrics:

- time-to-understand-current-state from mobile
- success rate for finding relevant output without entering Live
- copy success rate from Inspect
- reconnect recovery rate without context loss
- percentage of inspect views labeled precisely versus approximately
- frequency of unsupported/experimental actions being attempted

---

## 13. Risks and Tradeoffs

### Risk: Letting Legacy Compatibility Define The Product

Mitigation:

- publish runtime-v2-first posture
- keep legacy paths explicit, hidden, and non-default

### Risk: Building a Complex History System Too Early

Mitigation:

- phase the work
- begin with pane capture and tab snapshot assembly
- move to continuous timeline only if product usage justifies it

### Risk: Keeping Live and Inspect Semantics Entangled

Mitigation:

- explicit separate modules
- explicit separate payload metadata
- explicit separate UI labels

### Risk: Product Scope Drift

Mitigation:

- keep the core promise narrow:
  - awareness
  - comprehension
  - lightweight intervention

---

## 14. Non-Goals

This architecture does not require Remux to become:

- a full desktop terminal replacement
- a perfect terminal recorder across every backend immediately
- a complete observability platform
- a generic collaboration platform

The goal is much more focused:

> make terminal-first work remotely understandable and controllable from constrained devices

---

## 15. Final Recommendation

The strategic move is to stop treating scroll mode as a buggy side feature and instead elevate it into a first-class **Inspect layer**.

That layer should be defined around:

- trustworthy history
- current-tab context
- mobile readability
- explicit precision and source semantics

If Remux does this well, it stops being "a browser terminal wrapper with some extras" and becomes a product with a clearer identity:

> a remote workspace cockpit for terminal work

That identity is already latent in the codebase. The next step is to make the product and architecture admit it explicitly.
