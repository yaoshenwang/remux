# Capability Naming Audit

**Task**: E01-006
**Date**: 2026-03-30
**Branch**: `feat/runtime-identity-cleanup`

## Overview

This document audits every capability-related field across the Remux codebase, identifying naming conflicts, redundancies, and migration candidates. The goal is to arrive at a clean, consistent capability surface where each field has exactly one canonical name and location.

## Capability Interfaces

### Hierarchy

```
ServerCapabilities (core.ts)
├── protocolVersion: number
├── workspace: WorkspaceCapabilities
│   ├── (inherits BackendCapabilities)
│   ├── supportsUpload
│   └── supportsTerminalSnapshots
├── notifications: NotificationCapabilities
│   └── supportsPushNotifications
├── transport: TransportCapabilities
│   ├── supportsTrustedReconnect
│   ├── supportsPairingBootstrap
│   └── supportsDeviceIdentity
└── semantic: SemanticCapabilitySummary
    ├── adaptersAvailable
    ├── adapterHealth
    └── supportsEventStream
```

### Additional Surfaces

- **`BackendCapabilities`** (workspace.ts) — multiplexer-level feature flags
- **`auth_ok` payload** (protocol.ts) — includes `capabilities`, `serverCapabilities`, `backendKind`
- **`ServerConfig`** (app-types.ts) — HTTP `/api/config` response consumed by frontend
- **`/api/diagnostics`** — includes `backendKind`, `runtimeMode`

---

## Field Audit Table

### BackendCapabilities (workspace.ts)

| Field | Location | Decision | New Name | Reason |
|-------|----------|----------|----------|--------|
| `supportsPaneFocusById` | `BackendCapabilities` | **keep** | — | Clear, adapter-specific, correctly scoped |
| `supportsTabRename` | `BackendCapabilities` | **keep** | — | Clear, adapter-specific |
| `supportsSessionRename` | `BackendCapabilities` | **keep** | — | Clear, adapter-specific |
| `supportsPreciseInspect` | `BackendCapabilities` | **keep** | — | Renamed from `supportsPreciseScrollback` in E01-003; canonical name going forward |
| `supportsPreciseScrollback` | `BackendCapabilities` | **remove** (after deprecation) | — | Deprecated alias of `supportsPreciseInspect`. Currently still emitted by server-v2.ts (`backendCapabilities` object sets this, not `supportsPreciseInspect`). Needs migration: server-v2.ts must set `supportsPreciseInspect: true` and keep `supportsPreciseScrollback` only for backward compat |
| `supportsFloatingPanes` | `BackendCapabilities` | **keep** | — | Zellij-specific, correctly scoped |
| `supportsFullscreenPane` | `BackendCapabilities` | **keep** | — | Clear, adapter-specific |

### WorkspaceCapabilities (core.ts)

| Field | Location | Decision | New Name | Reason |
|-------|----------|----------|----------|--------|
| `supportsUpload` | `WorkspaceCapabilities` | **keep** | — | Server-level feature, correctly in workspace domain |
| `supportsTerminalSnapshots` | `WorkspaceCapabilities` | **keep** | — | Server-level feature, correctly scoped |

### NotificationCapabilities (core.ts)

| Field | Location | Decision | New Name | Reason |
|-------|----------|----------|----------|--------|
| `supportsPushNotifications` | `NotificationCapabilities` | **keep** | — | Correctly isolated in its own domain |

### TransportCapabilities (core.ts)

| Field | Location | Decision | New Name | Reason |
|-------|----------|----------|----------|--------|
| `supportsTrustedReconnect` | `TransportCapabilities` | **keep** | — | Clear transport-layer concern |
| `supportsPairingBootstrap` | `TransportCapabilities` | **keep** | — | Clear transport-layer concern |
| `supportsDeviceIdentity` | `TransportCapabilities` | **keep** | — | Clear transport-layer concern |

### SemanticCapabilitySummary (core.ts)

| Field | Location | Decision | New Name | Reason |
|-------|----------|----------|----------|--------|
| `adaptersAvailable` | `SemanticCapabilitySummary` | **keep** | — | Correctly placed in semantic domain |
| `adapterHealth` | `SemanticCapabilitySummary` | **keep** | — | Correctly placed in semantic domain |
| `supportsEventStream` | `SemanticCapabilitySummary` | **keep** | — | Correctly placed in semantic domain |

### ServerCapabilities top-level (core.ts)

| Field | Location | Decision | New Name | Reason |
|-------|----------|----------|----------|--------|
| `protocolVersion` | `ServerCapabilities` | **keep** | — | Essential versioning field |

### auth_ok payload (protocol.ts, server-v2.ts)

| Field | Location | Decision | New Name | Reason |
|-------|----------|----------|----------|--------|
| `capabilities` | `auth_ok` payload | **remove** (after migration) | — | Legacy field; `serverCapabilities.workspace` supersedes it. Frontend reads both (`setCapabilities` + `setServerCapabilities`). Should be removed once all clients migrate to `serverCapabilities` |
| `serverCapabilities` | `auth_ok` payload | **keep** | — | Canonical structured capability object |
| `backendKind` | `auth_ok` payload | **move** | `serverCapabilities.workspace.adapterKind` | Adapter-specific identity leaked into protocol envelope. Should be a semantic property inside capabilities, not a top-level auth_ok field. See Finding #2 |

### ServerConfig / /api/config (app-types.ts, server-v2.ts)

| Field | Location | Decision | New Name | Reason |
|-------|----------|----------|----------|--------|
| `backendKind` | `ServerConfig` | **rename** | `adapterKind` | "Backend" is ambiguous (gateway? runtime?). `adapterKind` is specific. Aligns with runtime identity cleanup goals |
| `runtimeMode` | `ServerConfig` | **remove** | — | Exact duplicate of `backendKind` — both are set to `RUNTIME_V2_BACKEND_KIND`. No consumer distinguishes them. See Finding #3 |

### /api/diagnostics (server-v2.ts)

| Field | Location | Decision | New Name | Reason |
|-------|----------|----------|----------|--------|
| `backendKind` | diagnostics response | **rename** | `adapterKind` | Same as ServerConfig — align naming |
| `runtimeMode` | diagnostics response | **remove** | — | Same duplicate as ServerConfig |

### WorkspaceRuntimeState (workspace.ts)

| Field | Location | Decision | New Name | Reason |
|-------|----------|----------|----------|--------|
| `inspectPrecision` | `WorkspaceRuntimeState` | **keep** | — | Runtime state counterpart to `supportsPreciseInspect` capability flag |
| `scrollbackPrecision` | `WorkspaceRuntimeState` | **remove** (after deprecation) | — | Deprecated alias of `inspectPrecision` (E01-003) |
| `streamMode` | `WorkspaceRuntimeState` | **keep** | — | Correctly describes current streaming mechanism |
| `degradedReason` | `WorkspaceRuntimeState` | **keep** | — | Correctly describes degradation cause |

---

## Key Findings

### Finding 1: `supportsPreciseScrollback` still emitted as primary field

**Location**: `src/backend/server-v2.ts:127`

The `backendCapabilities` object in server-v2.ts sets `supportsPreciseScrollback: true` but does **not** set `supportsPreciseInspect`. The `BackendCapabilities` interface now has `supportsPreciseInspect` as canonical and `supportsPreciseScrollback` as `@deprecated`, but the concrete value object hasn't been updated.

**Action**: Set `supportsPreciseInspect: true` alongside `supportsPreciseScrollback: true` in server-v2.ts. After deprecation window, remove `supportsPreciseScrollback`.

### Finding 2: `backendKind` on auth_ok is adapter-specific leakage

**Location**: `src/shared/protocol.ts:112`, `src/backend/server-v2.ts:1860`

The `auth_ok` WebSocket message carries `backendKind` as a top-level string. This is implementation-specific information that should live inside the structured `serverCapabilities` object, ideally as `workspace.adapterKind` or a new top-level `identity` domain.

**Action**: Add `adapterKind` to `WorkspaceCapabilities` (or a new `RuntimeIdentity` section). Deprecate top-level `backendKind` on `auth_ok`.

### Finding 3: `runtimeMode` duplicates `backendKind`

**Location**: `src/frontend/app-types.ts:14`, `src/backend/server-v2.ts:1217`

Both fields are set to the exact same value (`RUNTIME_V2_BACKEND_KIND`). The frontend only reads `backendKind` (in `AppHeader.tsx:137`, `App.tsx:896`, `App.tsx:1185`). `runtimeMode` has no unique consumer.

**Action**: Remove `runtimeMode` from `ServerConfig`, `/api/config`, and `/api/diagnostics`. Keep `backendKind` (renamed to `adapterKind` per Finding #2).

### Finding 4: `BackendCapabilities` vs `WorkspaceCapabilities` naming overlap

**Location**: `src/shared/contracts/workspace.ts`, `src/shared/contracts/core.ts`

`BackendCapabilities` describes multiplexer adapter features. `WorkspaceCapabilities extends BackendCapabilities` adds server-level features. The name "Backend" is ambiguous — it could mean the gateway server, the runtime, or the adapter.

**Action**: Rename `BackendCapabilities` to `AdapterCapabilities` to clarify it describes the multiplexer adapter (tmux/zellij). `WorkspaceCapabilities` then correctly extends adapter capabilities with server-level features.

### Finding 5: Legacy `capabilities` field on auth_ok

**Location**: `src/shared/protocol.ts:112`, `src/backend/server-v2.ts:1858`

The `auth_ok` message sends both `capabilities` (flat `BackendCapabilities`) and `serverCapabilities` (structured `ServerCapabilities`). The frontend consumes both: `setCapabilities(message.capabilities)` and `setServerCapabilities(message.serverCapabilities)`. Since `serverCapabilities.workspace` is a superset of `capabilities`, the flat field is redundant.

**Action**: Migrate frontend to read from `serverCapabilities.workspace`. Deprecate `capabilities` on `auth_ok`. Remove after deprecation window (check iOS client contract in `docs/IOS_CLIENT_CONTRACT.md`).

---

## Migration Priority

| Priority | Finding | Risk | Effort |
|----------|---------|------|--------|
| 1 | #1 — Fix `supportsPreciseInspect` emission | Low (additive) | Small |
| 2 | #3 — Remove `runtimeMode` duplicate | Low (no consumers) | Small |
| 3 | #4 — Rename `BackendCapabilities` → `AdapterCapabilities` | Medium (wide rename) | Medium |
| 4 | #2 — Move `backendKind` into capabilities | Medium (protocol change) | Medium |
| 5 | #5 — Remove legacy `capabilities` on auth_ok | High (iOS client compat) | Medium |

---

## Notes

- The `semantic` domain fields (`adaptersAvailable`, `adapterHealth`, `supportsEventStream`) are correctly placed and well-named. No changes needed.
- The `transport` and `notifications` domains are clean and well-isolated.
- The `WorkspaceStreamMode` and `WorkspaceDegradedReason` types in workspace.ts are well-named and correctly scoped.
- Any protocol-level changes must respect the iOS client contract documented in `docs/IOS_CLIENT_CONTRACT.md`.
