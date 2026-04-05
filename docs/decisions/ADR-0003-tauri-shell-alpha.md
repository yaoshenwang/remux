# ADR-0003: Tauri Shell Alpha Direction

- Status: Superseded / Archive Only
- Date: 2026-03-31

> [!WARNING]
> This ADR is preserved for history only. It describes a superseded desktop
> direction from the Zellij-era baseline and is not current implementation
> authority.

## Context

Remux needs a desktop surface that can validate tray, multi-window, quick
attach, notification, and review-oriented workflows without redefining the
current runtime baseline.

The current shipped truth remains:

- Node.js + TypeScript gateway
- Zellij as the runtime substrate
- React web shell as the main client surface

ADR-0002 preferred Electron because it assumed the desktop host needed to
package and launch the current gateway locally right away. That constraint is
stronger than what the alpha actually needs. The immediate desktop goal is to
host the existing web shell, add desktop-native integrations, and preserve the
same gateway and protocol truth that the browser already uses.

## Decision

Desktop alpha work should start from Tauri 2 as a shell around the existing
React frontend, while keeping the Node.js gateway and Zellij runtime as the
current source of truth.

For this alpha path:

- Tauri owns windowing, tray, notifications, shortcuts, deep links, local
  cache, and other desktop integrations
- The current gateway and protocol remain authoritative
- Desktop work must host the existing product line, not fork it into a second
  runtime path

## Alternatives Considered

- Keep Electron as the first desktop alpha host
- Delay all desktop work until the gateway becomes fully hostable in-process
- Start with a fully native desktop shell

## Why Rejected

- Electron is not required to validate the current desktop shell goals
- Delaying desktop work blocks validation of desktop-native workflows that can
  already layer on top of the current gateway
- A fully native shell would add even more product and integration work before
  the desktop path proves itself

## Consequences

- E07-style desktop shell work may proceed on top of the current web shell
- Desktop alpha must not replace the Node.js gateway or the Zellij runtime
- Any local process-hosting or packaging work must still respect the current
  Node/Zellij baseline rather than inventing a second runtime
- If desktop packaging later requires tight local gateway bundling that Tauri
  cannot support cleanly, the host decision must be revisited explicitly

## Reevaluate When

- desktop packaging must ship the gateway as a local managed process
- Node-specific APIs are still a blocker after the gateway boundaries are
  cleaner
- a future desktop host needs deeper local process ownership than a Tauri shell
  can provide cleanly
