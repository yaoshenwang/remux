# Remux Native Platform Roadmap

Date: 2026-03-26
Status: Proposed execution plan
Audience: project maintainer

## Executive Summary

Remux should evolve in two deliberately separated directions:

1. A strong multiplexer-native remote platform.
2. A semantic adapter platform for AI coding tools.

The first direction is the product foundation. The second direction is an optional depth layer that should sit on top of the foundation, not replace it.

This separation is the main strategic difference between Remux and tools that are built directly around one runtime such as Codex. Remux should remain useful in three progressively richer modes:

- Core mode: remote terminal multiplexer control with no tool-specific assumptions.
- Passive semantic mode: detect and display richer events from compatible tools when available.
- Active semantic mode: allow deep structured control for tools that expose enough stable surface area.

The first deep semantic adapter should be Codex because it offers the clearest near-term value. It should be implemented as the first adapter, not as the new definition of the whole product.

## Product Thesis

Remux should become the best mobile-first control surface for live terminal workspaces, with optional AI-runtime awareness where the environment supports it.

The core promise is:

- open a live workspace from another device
- understand where the user is in the workspace
- control the workspace safely and quickly
- layer richer AI-runtime context on top when available

This means the multiplexer remains the universal transport and state substrate, while semantic integrations are adapters with capability declarations and isolated failure domains.

## Why This Direction

Remux already has the right base shape for a general platform:

- backend-neutral workspace model in `src/shared/protocol.ts`
- backend abstraction in `src/backend/multiplexer/types.ts`
- split control and terminal transports in `src/backend/server.ts`
- extension entrypoint in `src/backend/extensions.ts`
- mobile-oriented browser UX in `src/frontend/App.tsx`

What Remux does not yet have is a product architecture that cleanly separates:

- core workspace control
- device trust and transport concerns
- native client delivery
- tool-specific semantic models

That separation is the next major architectural milestone.

## Current State Snapshot

### Existing Strengths

- Multiplexer-neutral internal model for `tmux`, `zellij`, and `conpty`.
- Strong browser-first mobile UX for sessions, tabs, panes, scrollback, compose, snippets, upload, and reconnect.
- Clear transport split between control-plane JSON and terminal-plane streaming.
- Authentication defaults that are practical for self-hosting.
- Early groundwork for extensions:
  - push notification backend routes
  - terminal state tracking
  - structured event watcher
  - bandwidth tracking
  - workspace enrichment hooks
- Reasonable test coverage across backend, frontend, integration, E2E, and smoke paths.

### Current Weaknesses

- `src/frontend/App.tsx` still owns too much state and too many responsibilities.
- The protocol is still optimized for the browser app, not for multiple client types.
- Extension hooks exist, but there is no stable public adapter contract yet.
- Device identity, pairing, trusted reconnect, and relay responsibilities are not separated into a dedicated layer.
- Semantic event ingestion is exploratory, not a productized capability.
- There is no native client delivery path yet.

### What Must Not Regress

- fast browser setup via `npx remux`
- current tmux-first reliability
- web accessibility from any modern browser
- low operational complexity for single-user self-hosting

## Product Boundaries

### Core Product

Core Remux should own:

- session, tab, and pane navigation
- terminal streaming
- resize and attach behavior
- scrollback capture and readable viewing
- file upload into the live shell context
- reconnect and client recovery
- device-safe remote access basics
- backend capability exposure

### Semantic Adapters

Semantic adapters should own:

- thread and turn models
- tool call streams
- approval workflows
- attachment semantics
- git and worktree actions when the tool supports them
- runtime-specific controls such as reasoning or mode selection

### Non-Goals For The Core

The core should not directly hardcode:

- Codex thread lifecycle as the universal runtime model
- Claude Code internal event formats as global truth
- tool-specific approval logic inside generic terminal transport
- a requirement that every supported runtime expose structured semantics

## North Star Architecture

The target system should be split into six layers.

### 1. Workspace Core

Owns the universal live workspace model.

Responsibilities:

- multiplexer backend abstraction
- workspace snapshot building
- pane attach and terminal routing
- scrollback capture
- upload target resolution
- reconnect-safe client view state

Source alignment today:

- `src/backend/multiplexer/`
- `src/backend/pty/`
- `src/backend/state/`
- `src/shared/protocol.ts`

### 2. Device And Transport Layer

Owns how a remote client becomes a trusted participant.

Responsibilities:

- auth handshake
- device identity
- pairing bootstrap
- trusted reconnect
- optional relay transport
- push registration lifecycle

This layer should be optional. Local-only browser use should remain possible without it.

### 3. Shared Client Protocol

Owns a stable transport schema usable by Web and native clients.

Responsibilities:

- capability negotiation
- versioning
- typed message envelopes
- workspace domain messages
- terminal domain messages
- semantic domain messages
- notification and device domain messages

This should become the contract boundary between server and all clients.

### 4. Client Applications

Separate product surfaces over the same protocol.

Planned clients:

- Web app
- iPhone app
- future iPad-first layout
- optional Android app later

### 5. Semantic Adapter Runtime

Owns tool-specific observation and control.

Responsibilities:

- adapter registration
- capability declaration
- adapter-specific event decoding
- optional structured actions
- graceful fallback when semantics are unavailable

Candidate adapters:

- `adapter-codex`
- `adapter-claude-code`
- `adapter-copilot-cli`
- `adapter-generic-shell`

### 6. Persistence And Observability

Owns logs, state snapshots, metrics, and diagnostics across all layers.

Responsibilities:

- session state persistence
- pairing/device state persistence
- notification dedupe state
- protocol version reporting
- structured debug traces
- adapter health signals

## Capability Model

Remux should expose capabilities at two levels.

### Workspace Capabilities

Examples:

- `supportsSessionRename`
- `supportsTabRename`
- `supportsPaneFocusById`
- `supportsPreciseScrollback`
- `supportsFullscreenPane`
- `supportsFloatingPanes`
- `supportsUpload`
- `supportsPushNotifications`
- `supportsTrustedReconnect`

### Semantic Capabilities

Examples:

- `supportsThreads`
- `supportsTurnHistory`
- `supportsToolEvents`
- `supportsApprovals`
- `supportsImageAttachments`
- `supportsGitActions`
- `supportsWorktreeActions`
- `supportsRuntimeModes`
- `supportsReasoningControls`
- `supportsFollowUpQueue`

Clients should render from declared capabilities, not runtime-brand guesses.

## Target Protocol Direction

The current protocol is sufficient for the browser client but too narrow for native apps and semantic adapters.

The next protocol revision should keep the current dual-channel transport shape while introducing typed domains.

### Proposed Domain Split

- `core/*`
- `workspace/*`
- `terminal/*`
- `semantic/*`
- `notifications/*`
- `device/*`

### Proposed Envelope Shape

```ts
interface RemuxMessageEnvelope<TPayload> {
  domain: "core" | "workspace" | "terminal" | "semantic" | "notifications" | "device";
  type: string;
  version: 1;
  requestId?: string;
  emittedAt: string;
  payload: TPayload;
}
```

### Proposed Core Messages

- `core/hello`
- `core/hello_ok`
- `core/auth_required`
- `core/capabilities`
- `core/error`
- `core/info`

### Proposed Workspace Messages

- `workspace/snapshot`
- `workspace/view`
- `workspace/session_picker`
- `workspace/action_result`
- `workspace/scrollback`

### Proposed Terminal Messages

- `terminal/open`
- `terminal/data`
- `terminal/resize`
- `terminal/closed`
- `terminal/ping`
- `terminal/pong`

### Proposed Semantic Messages

- `semantic/state`
- `semantic/event`
- `semantic/action_result`
- `semantic/adapter_status`

### Proposed Device Messages

- `device/pairing_state`
- `device/trust_state`
- `device/recovery_required`

## Semantic Adapter Contract

Adapters should be isolated behind a narrow interface.

```ts
interface SemanticAdapter {
  id: string;
  displayName: string;
  detect(context: AdapterDetectContext): Promise<AdapterMatch>;
  getCapabilities(): SemanticCapabilities;
  start(context: AdapterRuntimeContext): Promise<void>;
  stop(): Promise<void>;
  handleClientAction?(action: SemanticClientAction): Promise<SemanticActionResult>;
}
```

### Adapter Detection Inputs

- current pane command
- current working directory
- optional session metadata
- known runtime files
- explicit user preference
- adapter-specific environment variables

### Adapter Output Modes

- `none`
- `passive`
- `active`

This lets Remux display passive semantic timelines without promising active control where the runtime does not support it safely.

## Native Client Strategy

The native plan should be intentionally staged.

### iPhone MVP Principle

Do not start with a fully native terminal renderer.

Start with:

- native shell and navigation
- native auth and connection setup
- native notifications
- native session picker and sidebar equivalents
- `WKWebView` or embedded web terminal surface for xterm-based rendering in the first version

This reduces risk and gives the project a native product sooner.

### Why This Is The Right First Step

- terminal emulation is not the product moat
- pairing, reconnect, layout, notifications, and session control matter more on mobile
- the same core terminal surface can later be swapped or wrapped more deeply if needed

### Native Client Responsibilities In v1

- device onboarding
- server discovery and trusted connection setup
- session selection
- tab and pane navigation
- compose input and shortcuts
- scrollback reading
- upload initiation
- push notification handling
- reconnect and connection state UI

## Recommended Repository Evolution

Do not rewrite the repo into a monorepo immediately. Use two phases.

### Phase A: In-Place Modularization

Keep the current repo shape, but introduce clearer boundaries:

- `src/backend/core/`
- `src/backend/device/`
- `src/backend/adapters/`
- `src/shared/contracts/`
- `src/frontend/web/`

Suggested moves:

- move protocol types out of `src/shared/protocol.ts` into domain files
- move browser runtime state machine out of `App.tsx`
- move pairing and trust logic into a new `src/backend/device/`
- move semantic experiments out of generic `extensions.ts`

### Phase B: Multi-App Layout

After the protocol and core boundaries stabilize:

- keep `src/backend/` as the server platform
- keep `src/frontend/` as the web app
- add `apps/ios/` or separate `RemuxMobile/` for the iOS project
- optionally extract `packages/contracts/` later if shared code starts duplicating

Do not create a large workspace layout before the protocol is stable enough to justify it.

## Concrete Module Migration Map

The roadmap should translate directly into code movement. The table below shows the most practical first-pass target map from the current codebase.

### Shared Contracts

- `src/shared/protocol.ts`
  - split into `src/shared/contracts/workspace.ts`
  - split into `src/shared/contracts/terminal.ts`
  - split into `src/shared/contracts/core.ts`
  - split into `src/shared/contracts/device.ts`
  - split into `src/shared/contracts/semantic.ts`
  - keep `src/shared/protocol.ts` temporarily as a backward-compatible barrel during migration

### Backend Server

- `src/backend/server.ts`
  - extract `src/backend/server/http-routes.ts`
  - extract `src/backend/server/control-socket.ts`
  - extract `src/backend/server/terminal-socket.ts`
  - extract `src/backend/server/session-attach-service.ts`
  - extract `src/backend/server/client-capabilities.ts`
  - keep `server.ts` as composition root

### Workspace Core

- `src/backend/multiplexer/types.ts`
  - keep as workspace backend contract
- `src/backend/state/state-monitor.ts`
  - move toward `src/backend/core/workspace-monitor.ts`
- `src/backend/view/client-view-store.ts`
  - move toward `src/backend/core/client-view-store.ts`
- `src/backend/pty/terminal-runtime.ts`
  - move toward `src/backend/core/terminal-session-runtime.ts`

### Device And Transport

- create `src/backend/device/identity-store.ts`
- create `src/backend/device/pairing-service.ts`
- create `src/backend/device/trust-store.ts`
- create `src/backend/device/push-registration-service.ts`
- create `src/backend/device/relay-session.ts`

This directory should stay independent from any single semantic adapter.

### Semantic Runtime

- `src/backend/extensions.ts`
  - keep only as a temporary compatibility composition layer
- `src/backend/events/event-watcher.ts`
  - move under `src/backend/adapters/sources/` once the adapter registry exists
- create `src/backend/adapters/registry.ts`
- create `src/backend/adapters/types.ts`
- create `src/backend/adapters/generic-shell/`
- create `src/backend/adapters/codex/`

### Web Client

- `src/frontend/App.tsx`
  - extract `src/frontend/hooks/useRemuxConnection.ts`
  - extract `src/frontend/hooks/useWorkspaceState.ts`
  - extract `src/frontend/hooks/usePreferences.ts`
  - extract `src/frontend/hooks/useNotifications.ts`
  - extract `src/frontend/screens/AppShell.tsx`
  - extract `src/frontend/screens/SessionPickerScreen.tsx`
  - extract `src/frontend/screens/WorkspaceScreen.tsx`

### Native Client

When native work begins, the first app should mirror the same domain split:

- `Connection`
- `Workspace`
- `Terminal`
- `Notifications`
- `Device Trust`
- `Semantic Timeline`

This should map to the protocol domains instead of mirroring current web component names.

## Delivery Plan

The roadmap below assumes a single primary maintainer with focused execution. If more contributors join, the semantic adapter and native-client tracks can overlap sooner.

### Milestone 1: Stabilize The Platform Boundary

Target window:

- 2 to 3 weeks

Goal:

- make the current codebase ready to support more than one client and more than one semantic runtime

Deliverables:

- split `App.tsx` into:
  - connection state machine
  - workspace state hook
  - terminal session hook
  - local preference store
  - presentation components
- create shared protocol domain files under `src/shared/contracts/`
- add explicit server capability payloads for:
  - workspace
  - upload
  - notifications
  - device transport
  - semantic adapters
- refactor `extensions.ts` into clearer modules:
  - `transport extensions`
  - `semantic sources`
  - `observability`

Acceptance criteria:

- the browser app still ships with no user-visible regression
- protocol shapes are covered by contract tests
- server code no longer assumes a browser-only client

Suggested issue list:

- extract `useRemuxConnection`
- extract `useWorkspaceState`
- extract `useClientPreferences`
- split protocol types into domain modules
- add `ServerCapabilities` contract
- add protocol version field
- add adapter registry skeleton

### Milestone 2: iPhone Core MVP

Target window:

- 4 to 6 weeks after Milestone 1

Goal:

- ship a useful native iPhone client without deep semantic assumptions

Deliverables:

- iOS app shell
- QR-based bootstrap for server URL and token import
- session picker
- session, tab, and pane navigation
- terminal surface embedding
- compose input
- scrollback reader
- upload trigger
- reconnect UI

Acceptance criteria:

- user can launch Remux on a Mac and connect from iPhone without desktop browser fallback
- common actions can be completed one-handed on phone
- reconnect after transient network loss works reliably

Deferred work:

- full device trust model
- relay
- deep semantic adapters
- native terminal renderer replacement

### Milestone 3: Device Trust, Pairing, And Push

Target window:

- 4 to 6 weeks after Milestone 2

Goal:

- move from a convenient remote browser product to a trusted mobile product

Deliverables:

- device identity persistence on server
- trusted device list and revoke flow
- pairing QR with expiry
- push registration API
- completion and bell notifications for native client
- background reconnect strategy

Decision point:

- keep local-only direct connect as the default path
- add relay support as an optional transport mode, not as the mandatory architecture

Acceptance criteria:

- user can pair once and reconnect without re-entering credentials every time
- the phone can receive meaningful notifications for long-running sessions
- device trust can be revoked safely

### Milestone 4: Semantic Platform Foundation

Target window:

- 3 to 4 weeks after Milestone 3

Goal:

- make semantic integrations first-class without coupling the product to one runtime

Deliverables:

- semantic adapter registry
- adapter capability declarations
- semantic event transport domain
- semantic timeline UI model shared by web and iOS
- generic shell adapter with passive mode only

Acceptance criteria:

- server can run with zero, one, or multiple registered adapters
- client can render adapter presence and health
- unsupported runtimes degrade cleanly to plain workspace mode

### Milestone 5: Codex Adapter

Target window:

- 4 to 8 weeks after Milestone 4

Goal:

- deliver the first deep AI-runtime integration on top of the generic platform

Deliverables:

- Codex runtime detection
- thread and turn state model
- tool event ingestion
- approval and action surface where feasible
- thread history browsing
- optional git and worktree action bridge if the runtime surface is stable enough
- native and web UI for the Codex timeline

Acceptance criteria:

- a user can see more than raw terminal output for Codex sessions
- semantic failures do not break terminal access
- Codex-specific code remains isolated from the workspace core

### Milestone 6: Second Adapter And Hardening

Target window:

- after Codex adapter stabilizes

Goal:

- prove that the architecture is genuinely multi-runtime, not Codex-specialized under another name

Candidate second adapters:

- Claude Code passive adapter
- Copilot CLI passive adapter
- generic JSONL event source adapter

Acceptance criteria:

- a second adapter ships without requiring protocol redesign
- the UI can present different adapter capability surfaces coherently
- the core still remains useful when no adapter is active

## Milestone Gates

Each milestone should have an explicit go or no-go gate before the next one begins.

### Gate After Milestone 1

Proceed to native work only if:

- protocol versioning exists
- capability negotiation exists
- frontend connection state is no longer trapped inside `App.tsx`
- backend server responsibilities are at least partially split

### Gate After Milestone 2

Proceed to device trust work only if:

- iPhone client can attach and recover from disconnects reliably
- session, tab, and pane control is fast enough on mobile
- embedded terminal rendering is stable enough for normal use

### Gate After Milestone 3

Proceed to semantic platform work only if:

- trusted reconnect is understandable to users
- notification registration flow is stable
- transport-layer complexity is not still dominating bug volume

### Gate After Milestone 4

Proceed to Codex adapter only if:

- the generic adapter registry works
- passive semantic mode can be rendered without special-casing Codex
- semantic transport is versioned and test-covered

### Gate After Milestone 5

Declare the architecture healthy only if:

- Codex integration does not force core protocol redesign
- the browser client still works cleanly without semantic integration
- a second adapter looks materially easier than the first

## Detailed Execution Track

The work should be executed across four parallel tracks, but only two should be active at full speed at any one time.

### Track A: Core Refactor

Order:

1. split frontend state ownership
2. isolate protocol domain types
3. add server capability negotiation
4. isolate device and transport concerns
5. isolate adapter runtime

### Track B: Native Delivery

Order:

1. define app navigation and session model
2. implement bootstrap and config fetch
3. embed terminal surface
4. implement workspace navigation
5. add reconnect and notifications

### Track C: Device Trust

Order:

1. server-side device identity model
2. pairing bootstrap
3. trusted reconnect
4. revoke and recovery flows
5. optional relay mode

### Track D: Semantic Platform

Order:

1. define semantic capability model
2. define semantic event envelope
3. add adapter registry and health reporting
4. implement passive generic adapter
5. implement Codex adapter

## Near-Term Backlog

The following backlog is the most practical next slice after this document lands.

### Server

- introduce `ServerCapabilities`
- add protocol versioning
- split `src/shared/protocol.ts`
- create `src/backend/device/`
- create `src/backend/adapters/registry.ts`
- move notification concerns behind a stable transport interface
- define semantic event broadcast path separate from terminal data

### Web Client

- extract connection state machine from `App.tsx`
- extract workspace reducer
- extract preference persistence
- extract notification state
- add capability-driven rendering
- remove backend-brand conditionals where capability checks are sufficient

### iOS Prep

- write API contract fixtures for a native client
- document terminal embedding strategy
- define session list and active workspace models
- define notification payload contract
- define pairing bootstrap payload format

### Semantic Prep

- define `SemanticCapabilities`
- define `SemanticEvent`
- define adapter detection inputs
- formalize passive versus active adapter modes
- decide how git and worktree actions are represented in the protocol

## Suggested Data Models

### Workspace Domain

Keep:

- `SessionSummary`
- `SessionState`
- `TabState`
- `PaneState`
- `WorkspaceSnapshot`

Add:

- `ServerCapabilities`
- `TransportCapabilities`
- `UploadCapabilities`
- `NotificationCapabilities`

### Semantic Domain

Introduce:

```ts
interface SemanticSessionState {
  adapterId: string;
  mode: "none" | "passive" | "active";
  sessionId: string;
  title?: string;
  status: "idle" | "running" | "awaiting_input" | "complete" | "errored";
}

interface SemanticEvent {
  adapterId: string;
  eventId: string;
  sessionId: string;
  kind:
    | "user_message"
    | "assistant_message"
    | "tool_start"
    | "tool_end"
    | "approval_requested"
    | "approval_resolved"
    | "file_change"
    | "git_status"
    | "run_status";
  emittedAt: string;
  payload: Record<string, unknown>;
}
```

## Testing Strategy

The next architecture phase needs stronger contract-level testing.

### Additions Needed

- protocol contract fixtures consumed by server and web
- semantic adapter fixture tests
- capability matrix tests across `tmux`, `zellij`, and `conpty`
- reconnect tests for device trust state
- notification payload tests for native clients

### Keep Existing Strengths

- backend unit coverage
- integration WebSocket tests
- browser E2E for core flows
- real tmux smoke tests

### New Native Testing Philosophy

For iOS:

- unit test view models and protocol decoding first
- UI test only critical navigation and reconnect paths
- avoid over-investing in fragile UI automation early

## Risks And Mitigations

### Risk: The project becomes two products at once

Mitigation:

- keep the core useful without any semantic adapter
- ship the iPhone client for core mode before deep adapter work

### Risk: Protocol churn blocks all clients

Mitigation:

- version the protocol
- add contract fixtures before native development begins

### Risk: The first adapter leaks into the platform

Mitigation:

- require every adapter feature to pass through adapter capability checks
- forbid Codex-specific types in workspace core modules

### Risk: Native terminal rendering becomes a time sink

Mitigation:

- use embedded terminal rendering first
- revisit full native rendering only after mobile product-market usefulness is proven

### Risk: Device trust and relay work overwhelm the roadmap

Mitigation:

- ship local direct-connect MVP first
- make relay mode optional

### Risk: zellij and non-tmux backends regress during refactor

Mitigation:

- add capability-matrix regression tests before large protocol changes
- keep backend-specific behavior isolated behind capabilities

## Success Metrics

The roadmap should be judged by concrete product outcomes, not just architectural cleanliness.

### Core Metrics

- time from `npx remux` to successful mobile attach
- reconnect success rate after transient disconnect
- browser and native attach latency
- number of actions doable without raw terminal gestures

### Platform Metrics

- count of client surfaces supported from the same server contract
- count of semantic adapters supported without core redesign
- percentage of backend behaviors expressed as capabilities rather than frontend brand checks

### Semantic Metrics

- fraction of Codex sessions with semantic detection
- fraction of semantic events rendered without fallback to raw terminal inspection
- rate of adapter failures that degrade safely to core mode

## Recommended Immediate Decisions

These decisions should be made before implementation starts.

1. Remux remains multiplexer-first.
2. Semantic integrations are adapters, not the core identity.
3. The first native client is iPhone-only.
4. The first native terminal surface may be embedded web rendering.
5. Relay support is optional and follows local direct-connect MVP.
6. Codex is the first deep adapter.
7. A second adapter is required before declaring the architecture successful.

## First 30 Days

If execution starts immediately, the next 30 days should aim to complete this slice:

1. split frontend state and connection logic out of `App.tsx`
2. define `ServerCapabilities`
3. split protocol into domain files
4. create adapter registry skeleton
5. create device-layer module skeleton
6. add contract tests for server hello and capabilities
7. write an iOS client bootstrap contract note based on the new protocol

This is the minimum work required to make the native and semantic roadmap real instead of aspirational.

## Final Recommendation

Remux should not race tool-specific products by copying their surface area directly.

It should build a stronger foundation:

- best-in-class multiplexer-native mobile control
- optional trusted device connectivity
- optional semantic depth through adapters

That strategy gives Remux a broader ceiling than a single-runtime product while keeping the implementation order realistic. The right sequence is:

1. stabilize the platform boundary
2. ship native core mobile control
3. add trusted device flow
4. ship semantic platform
5. ship Codex adapter
6. prove the abstraction with a second adapter

That sequence preserves the current strengths of the project while creating a path toward a much more ambitious product.
