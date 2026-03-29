> **Archived**: This document has been superseded by the [Remux Master Plan 2026](../remux-master-plan-2026-v1.1-with-checklist.md). Retained for historical reference only.

# Remux Runtime V2 Domain Model

Date: 2026-03-27
Status: Draft for implementation
Audience: runtime contributors

This document freezes the first implementation vocabulary for Runtime V2.

## 1. Workspace Entities

### Workspace

- top-level runtime instance
- owns session registry
- owns persistence boundaries

### Session

- restorable workspace container
- has lifecycle state: `starting`, `live`, `degraded`, `stopped`, `recoverable`
- contains ordered tabs

### Tab

- primary user-facing work unit
- owns layout tree root
- tracks active pane and zoom state

### Pane

- PTY-backed interactive unit
- owns terminal state, recording stream, and current geometry
- may have a single active write lease holder

### LayoutNode

- `leaf(pane_id)`
- `split(direction, ratio, children)`

## 2. Runtime Support Entities

### WriterLease

- `client_id`
- `acquired_at`
- `last_activity_at`
- `mode`

Modes:

- `interactive`
- `read_only`

### RecordingSegment

- append-only byte range
- linked to pane id
- bounded by timestamps
- may carry markers for resize, exit, and restart

### TerminalGeometry

- requested `cols` and `rows`
- applied `cols` and `rows`
- updated only by Remux runtime

## 3. History Entities

### PaneHistory

- byte segments
- derived snapshots
- precision labels
- lifecycle markers

### TabHistory

- pane histories plus pane topology markers

### SessionTimeline

- session, tab, and pane lifecycle markers in time order

## 4. Ownership Rules

- external multiplexer ids are not part of the public V2 model
- client selection state does not mutate runtime truth
- PTY geometry is owned by Remux, then reflected to the client
- inspect precision is explicit, never implied

## 5. First Release Cuts

The first Runtime V2 executable only needs to prove these domain slices end to end:

- one workspace
- one session
- one tab
- one pane
- one writer lease
- one recording stream

The model is larger than the first runtime, but the names are fixed now to prevent drift.
