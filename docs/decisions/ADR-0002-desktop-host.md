# ADR-0002: Desktop Host Direction

- Status: Accepted
- Date: 2026-03-31

## Context

Remux needs a desktop host path that can package and launch the current Node.js gateway, preserve access to `node-pty`, and grow system integration over time. The present gateway shape is much closer to Electron than to a lighter host that would require additional bridge work first.

## Decision

Desktop host exploration should start from Electron hosting the existing gateway and web shell. Reevaluate lighter host options only after the gateway boundaries are cleaner and the runtime substrate no longer depends directly on today’s Node-specific assumptions.

## Alternatives Considered

- Start with Tauri immediately
- Start with a fully native desktop shell
- Delay all desktop work until a new runtime exists

## Why Rejected

- Tauri would need more near-term adaptation around Node, `node-pty`, and packaging constraints
- A fully native shell would be even further from the current implementation
- Delaying desktop host work would block validation of desktop workflows that can already reuse the existing gateway

## Consequences

- Desktop work should host, not rewrite, the current product path
- Gateway and protocol boundaries need to become cleaner so host options can expand later
- Future reevaluation should be based on concrete runtime portability, not preference alone

## Reevaluate When

- the runtime adapter boundary exists and is exercised
- desktop packaging no longer depends on Node-specific APIs directly
- terminal integration and local process management can be expressed through a portable boundary

