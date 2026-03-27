# ADR: Runtime V2 Write Lease Policy

Date: 2026-03-27
Status: Accepted

## Context

Remux V2 allows multiple clients to observe the same pane. Input ownership must remain explicit so terminal writes do not race silently.

## Decision

Runtime V2 uses a single active writer lease per pane.

Rules:

- unlimited clients may attach in read-only mode
- at most one client holds the interactive write lease
- lease ownership is visible in workspace metadata
- lease handoff is explicit and observable
- server-side commands may reject input when the lease is missing

## Consequences

Positive:

- avoids silent multi-writer corruption
- makes collaboration state understandable
- keeps mobile catch-up cheap and safe

Tradeoffs:

- collaborative editing is intentionally constrained
- client UX must expose lease status clearly
- later multi-writer support would require a new ADR
