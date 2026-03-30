# Remux Testing Guide

Remux's public product path is the Zellij-backed backend. The default test loop should optimize for fast TypeScript feedback, browser behavior, and a real terminal-width check in a real webpage after `dev` is pushed.

## Quick Loop

Use the smallest meaningful loop while iterating:

```bash
npm run typecheck
npm test
npm run build
```

What each command covers:

- `npm run typecheck`: backend and frontend TypeScript compile safety
- `npm test`: Vitest coverage for backend and frontend logic, including Zellij control/runtime helpers
- `npm run build`: produces the backend output and frontend bundle used by the packaged CLI

## Browser Check

When a change touches browser transport, terminal rendering, inspect output, upload behavior, auth, or resize handling, also run:

```bash
npm run test:e2e
```

Notes:

- `npm run test:e2e` is the Playwright smoke pass shipped in this repository
- some local harness file names still carry legacy naming; treat that as harness internals, not as the current product contract
- Playwright screenshots are useful for smoke coverage, but they do not replace the real width acceptance described below

## Merge Gate

Before merging to `dev`, the required gate is:

```bash
npm run typecheck && npm test && npm run build
```

Add `npm run test:e2e` when the change affects frontend or transport behavior.

## Width Acceptance

After the change is merged into `dev` and pushed to `origin/dev`, run a real webpage width check against the actual accessible environment:

1. Open a real terminal view in a desktop-width browser window.
2. Verify that restored first-screen content and subsequent live output use the full visible terminal container width.
3. Confirm there is no half-width rendering, premature wrapping, or mismatch between the browser width and the effective xterm/PTY columns.
4. If width is wrong, keep fixing and repeat the full `merge to dev -> push origin/dev -> real webpage retest` flow.

Fake harness screenshots are not an acceptable substitute for this check.
