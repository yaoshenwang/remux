# ADR: Runtime V2 Persistence Policy

Date: 2026-03-27
Status: Accepted

## Context

Runtime V2 needs honest recovery semantics without promising impossible process resurrection.

## Decision

The first V2 persistence layer stores metadata and append-only recording boundaries before it attempts richer restoration.

Persisted in phase order:

1. workspace, session, tab, and pane metadata
2. pane recording segment metadata
3. runtime lifecycle markers
4. future screen snapshots and replay indexes

Not promised in the first release:

- perfect child-process resurrection
- full terminal screen resurrection after crash
- cross-machine roaming of live PTY handles

## Consequences

Positive:

- recovery state is honest and debuggable
- persistence scope stays small enough for the first runtime cut
- inspect history can remain useful even when a pane stops

Tradeoffs:

- some post-crash panes will surface as `stopped` or `recoverable`
- first-release restart UX must explain degraded history boundaries
