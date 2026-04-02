# Repo Evolution Plan

Remux should evolve incrementally from the current single-package repository toward a multi-surface workspace platform without forcing an early rewrite.

## Phase 0: Current Layout

- `src/`: gateway, auth, session runtime, persistence, adapters, workspace logic, and browser shell template
- `tests/`: backend, frontend, and e2e coverage
- `apps/ios/` and `apps/macos/`: adjacent native clients under active exploration
- `docs/`: active, draft, and archived documentation

This is still the correct layout while the gateway and protocol are being hardened.

## Phase 1: Clear Boundaries Before New Packages

- Introduce clearer runtime and transport boundaries inside `src/`
- Isolate protocol contracts and shared DTOs
- Keep feature work inside the current package until boundaries are stable

This avoids splitting the repo before interfaces are clear.

## Phase 2: Shared Packages Where Pressure Is Real

Only split when a boundary is already exercised by more than one surface:

- `packages/contracts/` for protocol schema or generated types
- `packages/ui-shared/` for cross-shell view logic
- `packages/devex/` for scripts or audit tooling

## Phase 3: Host and Native Surfaces

Add host shells or native clients as separate top-level applications only after the gateway and shared contracts are stable enough to justify them.

Examples:

- `apps/ios/`
- `apps/macos/`
- `apps/android/`

## Red Lines

- Do not split the repo just to mirror a future architecture diagram.
- Do not introduce a second production runtime path before the current one is hardened.
- Do not move files solely for aesthetics without reducing coupling or improving ownership.
