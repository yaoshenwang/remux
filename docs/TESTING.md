# Remux Testing Guide

Remux's current product path is the Node.js gateway plus direct PTY runtime. The default test loop should optimize for fast TypeScript feedback and browser behavior.

## Quick Loop

Use the smallest meaningful loop while iterating:

```bash
npm run typecheck
npm test
npm run build
```

What each command covers:

- `npm run typecheck`: backend and frontend TypeScript compile safety
- `npm test`: Vitest coverage for gateway, runtime, persistence, and browser behavior
- `npm run build`: produces the backend output and frontend bundle used by the packaged CLI

## Browser Check

When a change touches browser transport, terminal rendering, inspect output, upload behavior, auth, or resize handling, also run:

```bash
npm run test:e2e
```

Notes:

- `npm run test:e2e` is the Playwright smoke pass shipped in this repository
- some local harness file names still carry legacy naming; treat that as harness internals, not as the current product contract

## Merge Gate

Before merging to `dev`, the required gate is:

```bash
npm run typecheck && npm test && npm run build
```

Add `npm run test:e2e` when the change affects frontend or transport behavior.

## Native Dependency Note

`better-sqlite3` and `node-pty` are native modules. This repository is pinned to Node 24. If local verification fails with an ABI mismatch, rerun the test loop with Node 24 or reinstall native dependencies for your active Node 24 toolchain.
