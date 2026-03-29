# Remux Testing Guide

Remux now treats the unified `runtime-v2` path as the only default product contract.

The default test loop should therefore optimize for:

- fast TypeScript and frontend/backend contract feedback
- runtime-v2 browser behavior
- explicit terminal width validation
- minimal high-cost harness coverage


## Quick Loop

Use the smallest meaningful loop while iterating:

```bash
npm run typecheck
npm test
npm run build
npm run test:e2e:functional
```

What each command covers:

- `npm run typecheck`: TypeScript compile safety for backend and frontend
- `npm test`: runtime-v2 and product-core Vitest coverage only; compatibility suites are excluded by design
- `npm run build`: produces the frontend bundle used by Playwright harnesses
- `npm run test:e2e:functional`: narrow runtime-v2 browser contract checks against the fake runtime-v2 upstream, including reconnect history recovery

If you have not changed the frontend bundle since the last successful build, you can usually skip rerunning `npm run build` and execute the targeted Playwright command directly.

## Browser Suites

The browser harness is intentionally narrow.

```bash
npm run test:e2e:functional
npm run test:e2e:width
npm run test:e2e:screenshots
```

- `test:e2e:functional`: runtime-v2 browser contract tests only, including server-backed scrollback replay and inspect recovery after reconnect
- `test:e2e:width`: explicit terminal width invariant checks; this is the required width gate before merging to `dev`
- `test:e2e:screenshots`: PR-only screenshot capture for visual review

## Merge Gate

Before merging to `dev`, run the full runtime-v2 gate:

```bash
npm run test:gate
```

That expands to:

```bash
npm run typecheck
npm test
npm run native:v2:check
npm run build
npm run test:e2e
```

## Release Gate

For a release-ready pass:

```bash
npm run test:release
```

This adds:

- screenshot capture for PR/release review
- `npm pack --dry-run` package verification
