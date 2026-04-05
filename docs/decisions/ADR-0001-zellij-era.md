# ADR-0001: Zellij Era Runtime Baseline

- Status: Superseded / Archive Only
- Date: 2026-03-31

> [!WARNING]
> This ADR is preserved for history only. The current shipping baseline is the
> ghostty-web-backed Node.js gateway with direct shell / PTY runtime documented
> in `README.md`, `docs/CURRENT_BASELINE.md`, and `docs/SPEC.md`.

## Context

Remux already ships as a Node.js + TypeScript gateway layered on top of Zellij. The codebase, packaging, and test flow all assume that shape today. Treating a replacement runtime as the current baseline would misdirect active development and documentation.

## Decision

For the current product line, Zellij is the runtime substrate and the Node.js gateway is the shipping control plane. All public docs, implementation work, and validation flow should default to that baseline.

## Alternatives Considered

- Reframe the repository around an unreleased replacement runtime now
- Run both a legacy runtime line and the Zellij line as equal public paths
- Freeze major work until a new runtime exists

## Why Rejected

- None of those options match the repository as it exists today
- Dual public paths create ambiguity in docs, tests, and support
- Blocking on a rewrite would slow down the product where users already depend on it

## Consequences

- Runtime hardening happens inside the current Zellij-era architecture
- Archived runtime documents remain reference-only
- Future runtime experiments must enter as explicit research or sidecar work, not as implicit replacements

## Exit Conditions

Reevaluate this ADR only if all of the following become true:

1. a replacement runtime has real production-grade session, inspect, and control parity
2. the test and release pipeline can validate that new path end-to-end
3. a new ADR explicitly promotes the replacement to shipping baseline
