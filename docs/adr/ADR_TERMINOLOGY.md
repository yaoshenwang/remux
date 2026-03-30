# ADR: Terminology Baseline

- Status: Accepted
- Date: 2026-03-31

## Context

Remux has carried multiple generations of naming across web UI, backend APIs, tests, and planning documents. The most damaging ambiguity is using `scroll` as a product surface name when the shipped product already uses `Inspect`, while the codebase still contains many legitimate technical uses of scroll terminology such as xterm scrollback, viewport scroll events, and CSS scrollbar rules.

Without a fixed vocabulary, new work keeps reintroducing mixed terms and makes API migration harder.

## Decision

The canonical product surface vocabulary is:

- `Inspect`
- `Live`
- `Control`
- `Topic`
- `Run`
- `Artifact`
- `Approval`
- `Agent`

The following terms are valid technical terms when they describe implementation details rather than product surfaces:

- `scrollback`
- `scrollbar`
- `scroll` event / viewport scrolling
- CSS `overscroll`, `scroll-snap`, `-webkit-overflow-scrolling`

The following term is banned as a product-facing primary name:

- `Scroll`

## Rules

1. User-facing surfaces, docs, route names, and internal product abstractions must use `Inspect`, not `Scroll`.
2. Technical scroll terminology is allowed only where it refers to browser behavior, xterm behavior, or terminal buffer mechanics.
3. When compatibility requires an older name, the current canonical name must stay primary and the legacy name must be explicitly marked as compatibility-only.
4. New docs and tests should follow the canonical vocabulary from the start instead of depending on later cleanup.

## Consequences

- Product-facing API names move toward `inspect`.
- Guard scripts may reject new active-file uses of `scroll` that look like product terminology.
- Archive material can still mention older names because history must remain traceable.
